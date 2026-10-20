import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { expect, it, onTestFinished, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: true } }))

import type { AcpRuntimeEvent } from '../../shared/acp'
import type { ExecutionRecord, ExecutionRequest } from '../../shared/earthnano/execution-port'
import type { AgentSpawnInput } from '../agent-framework/types'
import {
  createCandidateSnapshotStore,
  type MaterializedCandidate
} from '../earthnano/candidate-snapshot'
import { createClaudeCandidateDriver } from '../earthnano/claude-candidate-driver'
import { emptyExecutionState, ExecutionCore } from '../earthnano/execution-core'
import { createAcpCreateSessionWorkflow } from './create-session-workflow'
import { AcpRuntime } from './runtime'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'
import { createAcpTaskAgentPort } from './task-agent-port'

// Paid, explicitly requested smoke only. Merely supplying a key/file never enables this test.
const optedIn = process.env.EARTHNANO_LIVE_DEEPSEEK === '1'
const keyFile = process.env.EARTHNANO_LIVE_DEEPSEEK_KEY_FILE
const model = 'deepseek-flash'
const endpoint = 'https://api.deepseek.com/anthropic/v1/messages'
const maximumRequests = 12
const maximumOutputTokens = 768
type Label = 'A' | 'B'
interface Observation {
  label: Label
  status?: number
  model: string
  ownSystemOnly: boolean
  skillContextSeen: boolean
  inputReadResultSeen: boolean
  toolsCalled: string[]
  maxTokens: number
  thinkingDisabled: boolean
  nativeThinking: string
  usage?: {
    inputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    outputTokens: number
  }
  stopReason?: string
  transportFailed?: boolean
}
interface Probe {
  materialized: MaterializedCandidate
  events: AcpRuntimeEvent[]
  pids: number[]
  reaped?: boolean
  outputMatches?: boolean
  finalMatches?: boolean
}

it.skipIf(!optedIn || !keyFile || process.platform === 'win32')(
  'runs two bounded synthetic Claude ACP candidates against explicitly enabled DeepSeek',
  async () => {
    // Never log file contents, arbitrary provider errors, headers, or raw request/response bodies.
    const matches = new Set(
      (await readFile(keyFile!, 'utf8')).match(/\bsk-[A-Za-z0-9_-]+\b/g) ?? []
    )
    if (matches.size !== 1)
      throw new Error('The explicit key file must contain exactly one distinct API token')
    const apiKey = [...matches][0]!
    matches.clear()
    const root = await realpath(await mkdtemp(join(tmpdir(), 'earthnano-deepseek-live-')))
    const native = createRequire(import.meta.url).resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`
    )
    const observations: Observation[] = []
    const probes = new Map<Label, Probe>()
    const inFlight = new Set<AbortController>()
    const shutdowns: Array<() => Promise<unknown>> = []
    let attempts = 0
    let rejectedRequests = 0
    let disposeCore = (): void => undefined
    let records: ExecutionRecord[] = []
    const loopbackToken = randomUUID()
    const server = createServer(async (request, response) => {
      const reject = (status: number, reason: string): void => {
        rejectedRequests++
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: reason }
          })
        )
      }
      attempts++
      if (
        attempts > maximumRequests ||
        request.method !== 'POST' ||
        !request.url?.startsWith('/v1/messages') ||
        request.headers.authorization !== `Bearer ${loopbackToken}`
      ) {
        reject(400, 'Live smoke request boundary reached')
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk)
        size += bytes.length
        if (size > 256 * 1024) {
          reject(400, 'Live smoke input limit reached')
          return
        }
        chunks.push(bytes)
      }
      let body: Record<string, unknown>
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        reject(400, 'Invalid live smoke request')
        return
      }
      const system = JSON.stringify(body.system)
      const label = (['A', 'B'] as const).find((candidate) =>
        system.includes(`EARTHNANO_LIVE_SYSTEM_${candidate}`)
      )
      if (
        !label ||
        body.model !== model ||
        body.stream !== true ||
        observations.filter((item) => item.label === label).length >= 6
      ) {
        reject(400, 'Unsupported live smoke route or background request')
        return
      }
      const messages = body.messages as Array<{ role?: string; content?: unknown }>
      const blocks = messages.flatMap((message) =>
        Array.isArray(message.content) ? message.content : []
      ) as Array<{
        type?: string
        id?: string
        name?: string
        tool_use_id?: string
        is_error?: boolean
        content?: unknown
      }>
      const readIds = new Set(
        blocks
          .filter((block) => block.type === 'tool_use' && block.name === 'Read')
          .map((block) => block.id)
      )
      const observation: Observation = {
        label,
        model,
        ownSystemOnly: !system.includes(`EARTHNANO_LIVE_SYSTEM_${label === 'A' ? 'B' : 'A'}`),
        skillContextSeen: JSON.stringify(messages).includes('SYNTHETIC_SKILL_V1'),
        inputReadResultSeen: blocks.some(
          (block) =>
            block.type === 'tool_result' &&
            readIds.has(block.tool_use_id) &&
            !block.is_error &&
            JSON.stringify(block.content).includes('SYNTHETIC_INPUT_V1')
        ),
        toolsCalled: [],
        maxTokens: maximumOutputTokens,
        thinkingDisabled: true,
        nativeThinking: (body.thinking as { type?: string } | undefined)?.type ?? 'omitted'
      }
      observations.push(observation)
      // This test-only observer enforces the output cap before every paid request. No model spoofing.
      body.thinking = { type: 'disabled' }
      body.max_tokens = Math.min(
        typeof body.max_tokens === 'number' ? body.max_tokens : maximumOutputTokens,
        maximumOutputTokens
      )
      observation.maxTokens = body.max_tokens as number
      const controller = new AbortController()
      inFlight.add(controller)
      const disconnected = (): void => {
        if (!response.writableEnded) controller.abort()
      }
      response.on('close', disconnected)
      try {
        const upstream = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)])
        })
        observation.status = upstream.status
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel()
          reject(400, `Live upstream returned HTTP ${upstream.status}`)
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        let pending = ''
        for await (const chunk of upstream.body) {
          response.write(chunk)
          pending += Buffer.from(chunk).toString('utf8')
          let newline: number
          while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline).trim()
            pending = pending.slice(newline + 1)
            if (!line.startsWith('data: ')) continue
            let event: Record<string, unknown>
            try {
              event = JSON.parse(line.slice(6))
            } catch {
              continue
            }
            if (event.type === 'message_start') {
              const usage = (event.message as { usage?: Record<string, number> }).usage
              if (usage)
                observation.usage = {
                  inputTokens: usage.input_tokens ?? 0,
                  cacheReadTokens: usage.cache_read_input_tokens ?? 0,
                  cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
                  outputTokens: usage.output_tokens ?? 0
                }
            }
            if (event.type === 'message_delta') {
              const usage = event.usage as Record<string, number> | undefined
              if (observation.usage && usage?.output_tokens !== undefined)
                observation.usage.outputTokens = usage.output_tokens
              observation.stopReason = (event.delta as { stop_reason?: string } | undefined)
                ?.stop_reason
            }
            const block = event.content_block as { type?: string; name?: string } | undefined
            if (event.type === 'content_block_start' && block?.type === 'tool_use' && block.name)
              observation.toolsCalled.push(block.name)
          }
        }
        response.end()
      } catch {
        observation.transportFailed = true
        if (!response.headersSent) reject(400, 'Live upstream transport stopped')
        else response.end()
      } finally {
        inFlight.delete(controller)
        response.off('close', disconnected)
      }
    })
    onTestFinished(async () => {
      disposeCore()
      for (const controller of inFlight) controller.abort()
      const shutdownResults = await Promise.allSettled(shutdowns.map((stop) => stop()))
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      const report = {
        model,
        endpoint,
        nativeVersion: '2.1.232',
        candidateLimit: 2,
        maxTurnsPerCandidate: 5,
        requestLimit: maximumRequests,
        outputTokensPerRequest: maximumOutputTokens,
        attempts,
        forwardedRequests: observations.length,
        rejectedRequests,
        observations,
        shutdownResults: shutdownResults.map((result) => result.status),
        candidates: [...probes].map(([label, probe]) => ({
          label,
          processCount: probe.pids.length,
          reaped: probe.reaped,
          outputMatches: probe.outputMatches,
          finalMatches: probe.finalMatches,
          record: records.find((record) => record.request.origin.stageId === label) && {
            phase: records.find((record) => record.request.origin.stageId === label)!.phase,
            cleanup: records.find((record) => record.request.origin.stageId === label)!.cleanup,
            identity: records.find((record) => record.request.origin.stageId === label)!.identity,
            usage: records.find((record) => record.request.origin.stageId === label)!.usage
          }
        }))
      }
      try {
        if (process.env.EARTHNANO_LIVE_DEEPSEEK_REPORT)
          await writeFile(
            process.env.EARTHNANO_LIVE_DEEPSEEK_REPORT,
            JSON.stringify(report, null, 2) + '\n',
            { mode: 0o600 }
          )
      } finally {
        const unlock = async (path: string): Promise<void> => {
          const stat = await lstat(path)
          if (stat.isSymbolicLink()) return
          if (stat.isDirectory()) {
            await chmod(path, 0o700)
            for (const entry of await readdir(path)) await unlock(join(path, entry))
          }
        }
        await unlock(root)
        await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const snapshots = await createCandidateSnapshotStore({
      root: join(root, 'snapshots'),
      candidatesRoot: join(root, 'candidates')
    })
    const driver = createClaudeCandidateDriver({
      snapshots,
      // The real token is confined to this observer closure, never passed to the CLI or snapshots.
      binding: async (agent) => ({
        executablePath: native,
        runtimeVersion: '2.1.232',
        providerRef: agent.providerRef,
        provider: { type: 'custom', model, key: loopbackToken, baseUrl, apiEndpoints: ['messages'] }
      }),
      openOwner: async ({ prepared, materialized, request, context }) => {
        const label = request.origin.stageId as Label
        const probe: Probe = { materialized, events: [], pids: [] }
        probes.set(label, probe)
        const backend = {
          ...prepared.backend,
          sessionOptions: {
            ...prepared.backend.sessionOptions,
            thinking: { type: 'disabled' },
            maxTurns: 5
          },
          framework: {
            ...prepared.backend.framework,
            spawn: (input: AgentSpawnInput) =>
              prepared.backend.framework.spawn({
                ...input,
                spawnProcess: (command, args, options) => {
                  const child = spawn(command, args, options)
                  if (child.pid) probe.pids.push(child.pid)
                  return child
                }
              })
          }
        }
        let active = false
        const runtime = new AcpRuntimeCoordinator(
          (callbacks) => {
            const options = {
              ...prepared.runtimeOptions,
              resolveBackend: () => backend,
              appVersion: 'deepseek-live-smoke',
              callbacks
            }
            const base = composeAcpRuntimeBaseOwners(options)
            return new AcpRuntime(options, base, composeAcpRuntimeSessionOwners(options, base))
          },
          {
            onEvent: (event) => probe.events.push(event),
            onPromptEnded: () => {
              active = false
            }
          }
        )
        const shutdown = async (): Promise<{ reaped: boolean }> => {
          const result = await runtime.shutdownForQuit()
          probe.reaped = result.reaped
          return result
        }
        shutdowns.push(shutdown)
        const agent = createAcpTaskAgentPort(runtime, createAcpCreateSessionWorkflow(runtime))
        return {
          agent,
          preparePlan: async () => {
            const session = await agent.createSession({
              cwd: materialized.cwd,
              projectId: request.projectId,
              permissionProfile: 'ask',
              memoryEnabled: false
            })
            const promptMessageId = `prompt-${context.executionId}`
            return {
              kind: 'prepared',
              projectId: request.projectId,
              prompt: {
                sessionId: session.sessionId,
                promptMessageId,
                provenanceContext: { promptMessageId },
                text: [
                  materialized.snapshots.task.prompt,
                  materialized.snapshots.invocation.mission,
                  `Input file: ${join(materialized.inputDir, 'input.txt')}`,
                  `Output file: ${join(materialized.outputDir, 'result.json')}`
                ].join('\n')
              },
              identity: {
                sessionId: session.sessionId,
                providerSessionId: session.providerSessionId ?? session.sessionId,
                promptMessageId
              },
              supportedInteractionPolicies: ['deny-unresolved'],
              admit: async () => {
                active = true
                return { promptMessageId }
              },
              cancelOwnedPrompt: async (dispatch) => {
                if (active) await dispatch()
              },
              readResult: async (settlement) => {
                const usage = probe.events.findLast((event) => event.turnUsage)?.turnUsage
                return {
                  phase: settlement.cancellationRequested
                    ? 'cancelled'
                    : settlement.promptError || probe.events.some((event) => event.kind === 'error')
                      ? 'failed'
                      : 'completed',
                  ...(usage
                    ? {
                        usage: {
                          status: 'known',
                          inputTokens: usage.inputTokens + usage.cacheTokens,
                          outputTokens: usage.outputTokens
                        }
                      }
                    : {}),
                  evidence: {
                    status: 'partial',
                    scope:
                      'Original ephemeral ACP events from a synthetic opt-in live smoke; no persisted artifact/review owner',
                    text: probe.events
                      .filter((event) => event.kind === 'message' && event.role === 'assistant')
                      .map((event) => event.text ?? '')
                      .join(''),
                    artifacts: [],
                    references: [request.taskSnapshotRef, request.harnessRevisionRef],
                    limitations: [
                      'Synthetic smoke only; no ArtifactVersion persistence or general scientific-quality claim.'
                    ]
                  }
                }
              }
            }
          },
          shutdown
        }
      }
    })
    let state = emptyExecutionState()
    const core = new ExecutionCore(
      {
        load: () => structuredClone(state),
        commit: (next) => {
          state = structuredClone(next)
        }
      },
      driver
    )
    disposeCore = () => core.dispose()
    core.configureBudget('live-synthetic', 'live', 2)
    const freeze = async (label: Label): Promise<ExecutionRequest> => {
      const refs = await snapshots.freeze({
        task: {
          prompt:
            'Follow the Skill, read the synthetic input file, and write the requested JSON output.',
          files: [{ path: 'input.txt', content: 'SYNTHETIC_INPUT_V1' }]
        },
        harness: {
          instructions: `EARTHNANO_LIVE_SYSTEM_${label}\nYour assigned candidate is ${label}. Use Skill earthnano-candidate:probe, then Read the supplied input, then Write the supplied output. Write exactly one JSON object with keys candidate, input, skill; their values must be your assigned candidate, the exact input file text, and the verification value from the Skill. Do not inspect other files. Finish with only EARTHNANO_${label}_OK.`,
          skills: [
            {
              path: 'probe/SKILL.md',
              content:
                '---\nname: probe\ndescription: Synthetic verification skill\n---\nThe verification value for the output skill field is SYNTHETIC_SKILL_V1.\n'
            }
          ],
          tools: 'workspace-only'
        },
        agent: {
          backend: 'claude-code',
          model,
          providerRef: 'explicit-deepseek-live',
          runtimeVersion: '2.1.232'
        },
        environment: { isolation: 'directory-process', network: 'provider-only' }
      })
      const invocationRef = await snapshots.freezeInvocation({
        taskSnapshotRef: refs.taskSnapshotRef,
        harnessRevisionRef: refs.harnessRevisionRef,
        mission:
          'Perform the required three-tool workflow once, without retries. Use the absolute input/output paths below. Keep the final answer under 20 tokens.'
      })
      return {
        contractVersion: 1,
        requestKey: `live-${label}`,
        projectId: 'live-synthetic',
        ...refs,
        invocationRef,
        role: 'candidate',
        origin: { kind: 'optimization', optimizationId: 'manual-live-smoke', stageId: label },
        interactionPolicy: 'deny-unresolved',
        budgetRef: 'live',
        timeoutMs: 100_000
      }
    }
    const [a, b] = await Promise.all([freeze('A'), freeze('B')])
    expect(a.taskSnapshotRef).toEqual(b.taskSnapshotRef)
    expect(a.agentSpecRef).toEqual(b.agentSpecRef)
    const handles = await Promise.all([core.submit(a), core.submit(b)])
    await vi.waitFor(
      async () => {
        records = await Promise.all(handles.map((handle) => core!.get(handle.executionId)))
        expect(
          records.every((record) =>
            ['completed', 'failed', 'cancelled', 'interrupted'].includes(record.phase)
          )
        ).toBe(true)
      },
      { timeout: 110_000, interval: 100 }
    )
    for (const [label, probe] of probes) {
      let output: unknown
      try {
        output = JSON.parse(
          await readFile(join(probe.materialized.outputDir, 'result.json'), 'utf8')
        )
      } catch {
        output = undefined
      }
      probe.outputMatches = isDeepStrictEqual(output, {
        candidate: label,
        input: 'SYNTHETIC_INPUT_V1',
        skill: 'SYNTHETIC_SKILL_V1'
      })
      probe.finalMatches = probe.events
        .filter((event) => event.kind === 'message' && event.role === 'assistant')
        .map((event) => event.text ?? '')
        .join('')
        .trim()
        .endsWith(`EARTHNANO_${label}_OK`)
      expect(probe.outputMatches).toBe(true)
      expect(probe.finalMatches).toBe(true)
      expect(await readFile(join(probe.materialized.inputDir, 'input.txt'), 'utf8')).toBe(
        'SYNTHETIC_INPUT_V1'
      )
      expect(probe.reaped).toBe(true)
      expect(probe.pids.length).toBe(1)
      const own = observations.filter((item) => item.label === label)
      expect(own.some((item) => item.skillContextSeen)).toBe(true)
      expect(own.some((item) => item.inputReadResultSeen)).toBe(true)
      expect(
        ['Skill', 'Read', 'Write'].every((tool) =>
          own.some((item) => item.toolsCalled.includes(tool))
        )
      ).toBe(true)
    }
    expect(probes.size).toBe(2)
    expect(
      records.every((record) => record.phase === 'completed' && record.cleanup === 'confirmed')
    ).toBe(true)
    expect(observations.length <= maximumRequests && observations.length > 0).toBe(true)
    expect(
      observations.every(
        (item) =>
          item.status === 200 &&
          item.ownSystemOnly &&
          item.thinkingDisabled &&
          item.maxTokens <= maximumOutputTokens &&
          !item.transportFailed
      )
    ).toBe(true)
    expect(new Set(records.map((record) => record.identity.sessionId)).size).toBe(2)
  },
  130_000
)
