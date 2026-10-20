import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, chmod, lstat, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: true } }))
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { DesktopOptimizationManager } from './desktop-optimization-manager'
import type { PersistentOptimizationOptions } from './run-persistent-optimization'
import {
  minimumOptimizationExecutions,
  type OptimizationMethodOptions
} from '../../shared/earthnano/optimization-method'
import { ReviewRepository } from '../reviewer/repository'
import { runPersistentOptimization } from './run-persistent-optimization'
import { createPersistentCandidateOwners } from './persistent-candidate-owner'
import { FileExecutionStore } from './execution-store'
import { ExecutionCore } from './execution-core'
import { initDataRoot } from '../storage-root'
import {
  minimumResearchExecutions,
  type OptimizationDomainSpec,
  type OutputCheckSpec
} from '../../shared/earthnano/research-outcome'

const stream = (
  response: ServerResponse,
  model: string,
  content: { text: string } | { name: string; input: unknown }
): void => {
  const id = randomUUID(),
    tool = 'name' in content
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 }
        }
      }
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: tool
          ? { type: 'tool_use', id: `call_${id}`, name: content.name, input: {} }
          : { type: 'text', text: '' }
      }
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: tool
          ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) }
          : { type: 'text_delta', text: content.text }
      }
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 10 }
      }
    ],
    ['message_stop', { type: 'message_stop' }]
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  )
}

async function exercise(
  live: boolean,
  desktop = false,
  stopEarly = false,
  method?: OptimizationMethodOptions,
  failFirstProposal = false,
  research?: { domain?: OptimizationDomainSpec; checks?: OutputCheckSpec[] },
  resumeStages?: number
): Promise<void> {
  const k = method?.k ?? 1
  const taskCount = 1 + (research?.domain?.nextTasks.length ?? 0)
  const expectedAdmissions =
    (7 * k + (k > 1 ? 1 : 0) + (desktop || resumeStages ? 2 : 0) + (research?.domain ? 1 : 0)) *
    taskCount
  const executionLimit = research?.domain
    ? minimumResearchExecutions(
        method ?? { mode: 'sequential', k: 1, concurrency: 1 },
        research.domain
      ) + 3
    : method
      ? minimumOptimizationExecutions(method, desktop) + 3
      : desktop && live
        ? 12
        : 10
  const requestLimit = research?.domain ? 112 : method ? 96 : desktop ? 48 : 32
  const reflectionReply =
    '<edits>Reading and verification guidance was made explicit.</edits>\n<experience>\ncue: CSV aggregation\nlesson: Read the source, exclude the header and independently check count and sum.\nevidence: Compared baseline and candidate result.json with the frozen input CSV.\nconfidence: limited to this experiment\n</experience>'
  const root = await mkdtemp(join(tmpdir(), 'earthnano-persistent-loop-'))
  const dataRoot = join(root, 'data'),
    configRoot = join(root, 'config')
  await mkdir(configRoot)
  await mkdir(dataRoot)
  initDataRoot(dataRoot)
  const client = createProjectDbClient(configRoot)
  const controllers = new Set<AbortController>()
  let requests = 0,
    rejects = 0
  const rejectedRoutes: string[] = []
  const usage = { input: 0, cacheRead: 0, output: 0 }
  const readInputs = new Set<string>()
  const successorContexts = new Map<string, string>()
  const loopbackKey = randomUUID()
  let apiKey = ''
  let diagnosticError = ''
  let desktopRunDirectory: string | undefined
  let result!: Awaited<ReturnType<typeof runPersistentOptimization>>
  let liveReportWritten = false
  const server = createServer(async (request, response) => {
    const reject = (): void => {
      rejects++
      rejectedRoutes.push(
        `${request.method} ${new URL(request.url ?? '/', 'http://127.0.0.1').pathname}`
      )
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'Bounded optimization test rejected this request'
          }
        })
      )
    }
    if (
      request.method !== 'POST' ||
      new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/v1/messages' ||
      request.headers.authorization !== `Bearer ${loopbackKey}`
    )
      return reject()
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 512_000) return reject()
        chunks.push(Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const userText = body.messages
        .filter((message: { role: string }) => message.role === 'user')
        .flatMap((message: { content: unknown }) =>
          typeof message.content === 'string'
            ? [message.content]
            : Array.isArray(message.content)
              ? message.content.filter((block) => block.type === 'text').map((block) => block.text)
              : []
        )
        .join('\n')
      const role = /EarthNano execution role: ([a-z]+)\./.exec(userText)?.[1]
      if (!role) {
        if (live) return reject()
        stream(response, body.model, { text: 'background' })
        return
      }
      const inputDirectory = /^INPUT: (.+)$/m.exec(userText)?.[1]?.trim()
      if (research?.domain && inputDirectory && ['proposer', 'composer'].includes(role)) {
        const csv = await readFile(join(inputDirectory, 'values.csv'), 'utf8')
        if (csv.includes('three,6')) successorContexts.set(inputDirectory, userText)
      }
      const allBlocks = body.messages.flatMap((message: { content: unknown }) =>
        Array.isArray(message.content) ? message.content : []
      )
      const readIds = new Set(
        allBlocks
          .filter(
            (block: {
              type?: string
              name?: string
              id?: string
              input?: { file_path?: string }
            }) =>
              block.type === 'tool_use' &&
              block.name === 'Read' &&
              inputDirectory &&
              block.input?.file_path === join(inputDirectory, 'values.csv')
          )
          .map((block: { id: string }) => block.id)
      )
      if (
        inputDirectory &&
        (role === 'baseline' || role === 'candidate') &&
        allBlocks.some(
          (block: { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }) =>
            block.type === 'tool_result' &&
            readIds.has(block.tool_use_id) &&
            !block.is_error &&
            /three,(3|6)/.test(JSON.stringify(block.content))
        )
      )
        readInputs.add(inputDirectory)
      if (requests >= requestLimit || body.model !== 'deepseek-flash' || body.stream !== true)
        return reject()
      requests++
      if (stopEarly && role === 'baseline') return // Hold the real native prompt until Stop cancels it.
      if (live) {
        const controller = new AbortController()
        controllers.add(controller)
        const disconnected = (): void => {
          if (!response.writableEnded) controller.abort()
        }
        response.on('close', disconnected)
        try {
          body.max_tokens = Math.min(body.max_tokens ?? 1536, 1536)
          body.thinking = { type: 'disabled' }
          const upstream = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'anthropic-version': '2023-06-01',
              authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify(body),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)])
          })
          if (!upstream.ok || !upstream.body) {
            await upstream.body?.cancel()
            return reject()
          }
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          let pending = '',
            currentOutput = 0
          for await (const chunk of upstream.body) {
            response.write(chunk)
            pending += Buffer.from(chunk).toString('utf8')
            let newline: number
            while ((newline = pending.indexOf('\n')) !== -1) {
              const line = pending.slice(0, newline).trim()
              pending = pending.slice(newline + 1)
              if (!line.startsWith('data: ')) continue
              let event
              try {
                event = JSON.parse(line.slice(6))
              } catch {
                continue
              }
              if (event.type === 'message_start') {
                usage.input += event.message.usage?.input_tokens ?? 0
                usage.cacheRead += event.message.usage?.cache_read_input_tokens ?? 0
              }
              if (event.type === 'message_delta')
                currentOutput = event.usage?.output_tokens ?? currentOutput
            }
          }
          usage.output += currentOutput
          response.end()
        } finally {
          controllers.delete(controller)
          response.off('close', disconnected)
        }
      } else {
        const output = /^OUTPUT: (.+)$/m.exec(userText)?.[1]?.trim()
        if (!output) return reject()
        const alreadyWrote = body.messages.some(
          (message: { role: string; content: unknown }) =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.some((block) => block.type === 'tool_use' && block.name === 'Write')
        )
        if (alreadyWrote) {
          stream(response, body.model, {
            text:
              role === 'selector'
                ? '```choice\nB\n```\n<why>Both outputs satisfy the task; choose B as the deterministic tie-break.</why>'
                : role === 'reflection'
                  ? reflectionReply
                  : 'Completed the requested work and checked the output.'
          })
          return
        }
        if (role === 'selector') {
          expect(userText).toContain('"path":"candidates/A.md"')
          expect(userText).toContain('"path":"candidates/B.md"')
          expect(userText).not.toContain('assessment-plan.json')
          stream(response, body.model, {
            name: 'Write',
            input: {
              file_path: join(output, 'selection.md'),
              content:
                '```choice\nB\n```\n<why>Both outputs satisfy the task; choose B as the deterministic tie-break.</why>'
            }
          })
          return
        }
        if (role === 'reflection') {
          expect(userText).not.toContain('assessment-plan.json')
          stream(response, body.model, {
            name: 'Write',
            input: { file_path: join(output, 'experience.md'), content: reflectionReply }
          })
          return
        }
        if (role === 'reviewer') {
          const artifacts = JSON.parse(
            await readFile(join(inputDirectory!, 'evidence/artifacts.json'), 'utf8')
          )
          const criteria = JSON.parse(
            await readFile(join(inputDirectory!, 'evidence/criteria.json'), 'utf8')
          )
          const file = artifacts[0]
          const original = JSON.parse(
            await readFile(join(inputDirectory!, 'evidence/task.json'), 'utf8')
          )
          const source = original.files.find(
            (entry: { path: string }) => entry.path === 'values.csv'
          ).content as string
          const sum = source
            .trim()
            .split('\n')
            .slice(1)
            .reduce((total, row) => total + Number(row.split(',')[1]), 0)
          stream(response, body.model, {
            name: 'Write',
            input: {
              file_path: join(output, 'assessment.json'),
              content: JSON.stringify({
                schemaVersion: 1,
                score: 100,
                outcome: 'pass',
                rationale: `The JSON has count 3 and sum ${sum}, matching independent recomputation from input rows.`,
                checks: criteria.criteria.map((criterion: { id: string }) => ({
                  criterionId: criterion.id,
                  status: 'pass',
                  evidence: [
                    {
                      path: file.path,
                      artifactRef: file.artifactRef,
                      quote: file.content.trim()
                    }
                  ]
                }))
              })
            }
          })
          return
        }
        const editing = role === 'proposer' || role === 'composer'
        let sum = 6
        if (role === 'baseline' || role === 'candidate' || editing) {
          const csv = await readFile(join(inputDirectory!, 'values.csv'), 'utf8')
          sum = csv
            .trim()
            .split('\n')
            .slice(1)
            .reduce((total, row) => total + Number(row.split(',')[1]), 0)
          if (research?.domain && editing && sum === 15) {
            expect(userText).toContain('EXPERIENCE.md')
            expect(userText).toContain('CSV aggregation')
          }
        }
        stream(response, body.model, {
          name: 'Write',
          input: {
            file_path: join(output, editing ? 'context/harness/instructions.md' : 'result.json'),
            content: editing
              ? `Read the frozen CSV; calculate count and sum; verify both values and write compact JSON. Revision ${role}-${requests}.`
              : JSON.stringify({ count: 3, sum }) + '\n'
          }
        })
      }
    } catch {
      if (!response.headersSent) reject()
      else response.end()
    }
  })
  onTestFinished(async () => {
    if (live && desktop && !liveReportWritten && process.env.EARTHNANO_LIVE_DEEPSEEK_REPORT) {
      let records: Array<{ role: string; phase: string; cleanup: string; artifactCount: number }> =
        []
      if (desktopRunDirectory)
        try {
          const journal = JSON.parse(
            await readFile(join(desktopRunDirectory, 'execution/execution.json'), 'utf8')
          )
          records = Object.values(journal.records).map((record: unknown) => {
            const r = record as {
              request: { role: string }
              phase: string
              cleanup: string
              evidence: { artifacts: unknown[] }
            }
            return {
              role: r.request.role,
              phase: r.phase,
              cleanup: r.cleanup,
              artifactCount: r.evidence.artifacts.length
            }
          })
        } catch {
          /* Failure can precede journal creation. */
        }
      await writeFile(
        process.env.EARTHNANO_LIVE_DEEPSEEK_REPORT,
        JSON.stringify(
          {
            status: 'failed',
            error: diagnosticError,
            method,
            requests,
            rejects,
            usage,
            records,
            ...(result?.domain ? { domain: result.domain } : {})
          },
          null,
          2
        ) + '\n',
        { mode: 0o600 }
      )
    }
    for (const controller of controllers) controller.abort()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await client.$disconnect()
    const unlock = async (path: string): Promise<void> => {
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) return
      if (stat.isDirectory()) {
        await chmod(path, 0o700)
        for (const entry of await readdir(path)) await unlock(join(path, entry))
      }
    }
    await unlock(root)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    // This isolated test worker owns the root for its lifetime.
  })
  if (live) {
    const keys = new Set(
      (await readFile(process.env.EARTHNANO_LIVE_DEEPSEEK_KEY_FILE!, 'utf8')).match(
        /\bsk-[A-Za-z0-9_-]+\b/g
      ) ?? []
    )
    if (keys.size !== 1) throw new Error('Expected one API token in explicitly supplied key file')
    apiKey = [...keys][0]
  }
  await migrateApplicationDatabase(client)
  const project = await client.project.create({
    data: { name: 'Synthetic optimization validation' }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const native = createRequire(import.meta.url).resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`
  )
  const ownerOptions = { dataRoot, configRoot, getClient: async () => client }
  let bindingAttempts = 0
  const runOptions: PersistentOptimizationOptions = {
    projectId: project.id,
    taskId: 'synthetic-csv',
    workRoot: join(root, 'run'),
    harnessRoot: resolve('vendor/harness2'),
    ownerOptions,
    executionLimit,
    ...(resumeStages
      ? { semanticCriteria: 'The result excludes the header and sums the value column correctly.' }
      : {}),
    ...(research ?? {}),
    ...(method ? { method } : {}),
    executionTimeoutMs: 120_000,
    timeoutMs: 480_000,
    input: {
      task: {
        prompt:
          'Read INPUT/values.csv using the Read tool. Calculate the number of data rows and sum of the value column. Write only a JSON object with count and sum to OUTPUT/result.json, using the Write tool. Do not create other deliverables.',
        files: [{ path: 'values.csv', content: 'id,value\none,1\ntwo,2\nthree,3\n' }]
      },
      harness: {
        instructions: 'Read the input carefully and produce the requested JSON deliverable.',
        skills: [],
        tools: 'workspace-only'
      },
      agent: {
        backend: 'claude-code',
        model: 'deepseek-flash',
        providerRef: live ? 'explicit-deepseek-live' : 'local-deterministic',
        runtimeVersion: '2.1.232'
      },
      environment: { isolation: 'directory-process', network: 'provider-only' }
    },
    binding: async (agent) => {
      // In the default sequential k1 path, admission 2 is the first proposer. Fail before
      // spawning a process; original Harness² owns the retry and the charge remains durable.
      if (failFirstProposal && ++bindingAttempts === 2) throw new Error('Fixture binding failure')
      return {
        executablePath: native,
        runtimeVersion: '2.1.232',
        providerRef: agent.providerRef,
        provider: {
          type: 'custom',
          model: agent.model,
          key: loopbackKey,
          baseUrl,
          apiEndpoints: ['messages']
        }
      }
    }
  }
  let desktopRunId: string | undefined
  const observedStates = new Set<string>()
  const criteria =
    'The result reports the correct number of data rows, excluding the header.\nThe result reports the correct arithmetic sum of the value column.'
  if (desktop) {
    const sourceSessionId = randomUUID()
    await client.session.create({
      data: {
        id: sourceSessionId,
        number: 1000,
        projectId: project.id,
        title: 'Desktop source task',
        status: 'idle',
        presentedStatus: 'idle',
        createdAtMs: BigInt(Date.now()),
        updatedAtMs: BigInt(Date.now())
      }
    })
    const managerOptions = {
      root: join(root, 'desktop'),
      validateSession: async (projectId: string, sessionId: string) => {
        const session = await client.session.findFirst({
          where: { id: sessionId, projectId, deletedAtMs: null, archivedAtMs: null }
        })
        if (!session) throw new Error('Source Session unavailable')
      },
      createOptions: async () => runOptions,
      run: async (options: PersistentOptimizationOptions) => {
        try {
          result = await runPersistentOptimization(options)
          return result
        } catch (error) {
          diagnosticError = String(error instanceof Error ? error.message : 'Optimization failed')
            .replaceAll(apiKey || 'NO_TOKEN', '[redacted]')
            .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
            .slice(0, 1000)
          throw error
        }
      }
    }
    const manager = new DesktopOptimizationManager(managerOptions)
    onTestFinished(async () => {
      await manager.shutdown()
    })
    const initial = await manager.start({
      projectId: project.id,
      sourceSessionId,
      requestKey: 'desktop-synthetic',
      prompt: runOptions.input.task.prompt,
      files: [...runOptions.input.task.files],
      criteria,
      executionLimit,
      ...(method ? { method } : {}),
      ...(research ?? {})
    })
    desktopRunId = initial.runId
    desktopRunDirectory = join(root, 'desktop', initial.runId)
    if (stopEarly) {
      await vi.waitFor(() => expect(requests).toBe(k), { timeout: 30_000, interval: 100 })
      expect(
        (await manager.stop({ projectId: project.id, sourceSessionId, runId: initial.runId })).state
      ).toBe('stopping')
      await vi.waitFor(
        async () => {
          const final = await manager.get({
            projectId: project.id,
            sourceSessionId,
            runId: initial.runId
          })
          expect(final.state).toBe('cancelled')
          expect(final.budget.admitted).toBe(k)
          expect(final.budget.active).toBe(0)
          expect(final.executions.every((execution) => execution.role === 'baseline')).toBe(true)
          if (research?.domain) {
            expect(final.domain?.order).toHaveLength(taskCount)
            expect(final.domain?.tasks.every((task) => !task.experience && !task.outcome)).toBe(
              true
            )
            expect(final.domain?.library.entries).toEqual([])
            expect(final.outcome).toBeUndefined()
          }
        },
        { timeout: 30_000, interval: 100 }
      )
      expect(await manager.shutdown()).toEqual({ reaped: true })
      expect(requests).toBe(k)
      return
    }
    const deadline = Date.now() + 480_000
    while (true) {
      const progress = await manager.get({
        projectId: project.id,
        sourceSessionId,
        runId: initial.runId
      })
      observedStates.add(progress.state)
      if (['failed', 'interrupted', 'cancelled'].includes(progress.state))
        throw new Error(
          `Desktop run ended ${progress.state} after ${progress.budget.admitted} admissions: ${diagnosticError}`
        )
      if (progress.state === 'completed') {
        expect(progress.budget).toEqual({
          limit: executionLimit,
          admitted: result.records.length,
          completed: result.records.length,
          active: 0
        })
        if (research?.domain) {
          expect(progress.assessments).toBeUndefined()
          expect(progress.outcome).toBeUndefined()
          expect(progress.domain?.library).toMatchObject({
            scope: 'experiment',
            entries: expect.any(Array)
          })
          expect(progress.domain?.tasks).toHaveLength(taskCount)
          expect(
            progress.domain?.tasks.every((task) =>
              progress.domain!.library.entries.includes(task.taskId)
                ? task.experience?.scope === 'experiment'
                : task.experience === undefined
            )
          ).toBe(true)
          expect(
            progress.domain?.tasks.every((task) => task.outcome?.artifact.status === 'passed')
          ).toBe(true)
        } else if (research?.checks) {
          expect(progress.assessments?.baseline.reviewId).toBeTruthy()
          expect(progress.assessments?.candidate.reviewId).toBeTruthy()
          const expected = research.checks.every((check) => check.expected === 6)
            ? 'passed'
            : 'failed'
          expect(progress.outcome?.artifact.status).toBe(expected)
          expect(progress.outcome?.configuration.status).toBe(
            expected === 'passed' ? 'eligible' : 'blocked'
          )
        } else expect(progress.outcome?.configuration.status).toBe('unverified')
        if (method) {
          expect(progress.method).toEqual(method)
          expect(progress.selection).toMatchObject({
            candidateCount: k,
            trivial: false,
            fallback: false
          })
          expect(progress.executions.some((entry) => entry.role === 'selector')).toBe(true)
          expect(progress.executions.every((entry) => entry.stageId)).toBe(true)
        }
        break
      }
      if (Date.now() > deadline) throw new Error('Desktop integration timed out')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const plan = JSON.parse(
      await readFile(join(desktopRunDirectory!, 'execution/assessment-plan.json'), 'utf8')
    )
    expect(plan.criteria).toBe(criteria)
    expect(plan.criteriaDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    if (method) expect(plan.baselineStageId).toBe('base1')
    const methodConfig = await readFile(
      join(desktopRunDirectory!, 'execution/method-config.json'),
      'utf8'
    )
    expect(methodConfig).not.toContain(criteria)
    if (method) expect(JSON.parse(methodConfig).method).toEqual(method)
    expect(observedStates.has('assessing')).toBe(true)
    expect(await manager.shutdown()).toEqual({ reaped: true })
    const restarted = new DesktopOptimizationManager({
      ...managerOptions,
      run: async () => {
        throw new Error('Desktop restart must not replay')
      }
    })
    expect((await restarted.latest({ projectId: project.id, sourceSessionId }))?.state).toBe(
      'completed'
    )
    await restarted.shutdown()
  } else if (resumeStages) {
    const stop = new AbortController()
    let requested = false
    await expect(
      runPersistentOptimization({
        ...runOptions,
        signal: stop.signal,
        onProgress: (progress) => {
          if (
            !requested &&
            progress.records.filter((record) => record.phase === 'completed').length >= resumeStages
          ) {
            requested = true
            setImmediate(() => stop.abort())
          }
        }
      })
    ).rejects.toThrow()
    const journalPath = join(runOptions.workRoot, 'execution.json')
    const before = JSON.parse(
      await readFile(journalPath, 'utf8')
    ) as import('./execution-core').ExecutionState
    const confirmed = Object.values(before.records).filter((record) => record.phase === 'completed')
    expect(confirmed.length).toBeGreaterThanOrEqual(resumeStages)
    expect(Object.values(before.records).every((record) => record.cleanup === 'confirmed')).toBe(
      true
    )
    const pausedCount = requests
    result = await runPersistentOptimization({ ...runOptions, resume: true })
    expect(requests).toBeGreaterThan(pausedCount)
    expect(result.records.filter((record) => record.phase === 'completed')).toHaveLength(
      expectedAdmissions
    )
    for (const record of confirmed)
      expect(result.records.find((entry) => entry.executionId === record.executionId)).toEqual(
        record
      )
    const after = JSON.parse(
      await readFile(journalPath, 'utf8')
    ) as import('./execution-core').ExecutionState
    expect(Object.values(after.budgets)[0].admitted).toBe(result.records.length)
    expect(result.records.length).toBeLessThanOrEqual(executionLimit)
    expect((result.methodResult as { fallbackStages: string[] }).fallbackStages).toEqual([])
    const beforeReopen = requests
    const reopened = await runPersistentOptimization({ ...runOptions, resume: true })
    expect(requests).toBe(beforeReopen)
    expect(reopened.records).toEqual(result.records)
    expect(reopened.assessments).toEqual(result.assessments)
    expect((reopened.methodResult as { chosenArtifacts: unknown }).chosenArtifacts).toEqual(
      (result.methodResult as { chosenArtifacts: unknown }).chosenArtifacts
    )
    await expect(
      runPersistentOptimization({
        ...runOptions,
        resume: true,
        input: { ...runOptions.input, agent: { ...runOptions.input.agent, model: 'changed' } }
      })
    ).rejects.toThrow('identity changed')
    expect(requests).toBe(beforeReopen)
    const owners = createPersistentCandidateOwners(ownerOptions)
    for (const record of confirmed)
      expect((await owners.exportResult(record)).artifacts).toEqual(record.evidence.artifacts)
    await owners.shutdown()
    // The unchanged native CLI probes this optional health endpoint before each Session.
    // The bounded fixture rejects it; no admitted model request may be rejected.
    expect(new Set(rejectedRoutes)).toEqual(new Set(['HEAD /api/hello']))
    return
  } else result = await runPersistentOptimization(runOptions)
  if (live) {
    expect(result.records.length).toBeGreaterThanOrEqual(expectedAdmissions)
    expect(result.records.length).toBeLessThanOrEqual(executionLimit)
  } else expect(result.records).toHaveLength(expectedAdmissions + (failFirstProposal ? 1 : 0))
  expect(result.records.filter((record) => record.request.role === 'baseline')).toHaveLength(
    k * taskCount
  )
  expect(result.records.filter((record) => record.request.role === 'candidate')).toHaveLength(
    3 * k * taskCount
  )
  const proposals = result.records.filter((record) => record.request.role === 'proposer').length
  const compositions = result.records.filter((record) => record.request.role === 'composer').length
  if (live) {
    expect(proposals).toBeGreaterThanOrEqual(2 * k * taskCount)
    expect(compositions).toBeGreaterThanOrEqual(k * taskCount)
  } else {
    expect(proposals).toBe(2 * k * taskCount + (failFirstProposal ? 1 : 0))
    expect(compositions).toBe(k * taskCount)
  }
  expect(result.records.filter((record) => record.request.role === 'selector')).toHaveLength(
    k > 1 ? taskCount : 0
  )
  if (method)
    expect(result.methodResult).toMatchObject({
      method,
      selection: { candidateCount: k, trivial: false, fallback: false }
    })
  if (method && !live)
    expect(result.methodResult).toMatchObject({
      summary: {
        selections: {
          [method.mode === 'parallel' ? 'agg' : 'seq']: { chosen_id: 'B', fallback: false }
        }
      }
    })
  if (research?.domain) {
    const domainMethod = result.methodResult as {
      library: { files: Array<{ path: string; content: string }> }
      tasks: Array<{
        executionIds: string[]
        configurationChanged: boolean
        fallbackStages: unknown[]
      }>
    }
    expect(domainMethod.tasks).toHaveLength(taskCount)
    if (!live)
      expect(
        domainMethod.tasks.every(
          (task) => task.configurationChanged && task.fallbackStages.length === 0
        )
      ).toBe(true)
    expect(result.records.filter((record) => record.request.role === 'reflection')).toHaveLength(
      taskCount
    )
    const firstExperience = domainMethod.library.files.find((file) =>
      file.path.endsWith(`/${result.domain!.order[0]}/EXPERIENCE.md`)
    )
    if (!live) expect(firstExperience).toBeTruthy()
    if (!live) expect(successorContexts.size).toBeGreaterThanOrEqual(3)
    if (firstExperience) {
      for (const context of successorContexts.values())
        expect(context).toContain(
          JSON.stringify(firstExperience.content)
            .replaceAll('@', '\\u0040')
            .replaceAll('`', '\\u0060')
        )
    } else expect(result.domain!.tasks[0]!.experience).toBeUndefined()
  } else
    expect(result.methodResult).toMatchObject({ configurationChanged: true, fallbackStages: [] })
  const completedRecords = result.records.filter((record) => record.phase === 'completed')
  if (failFirstProposal) {
    expect(result.records.filter((record) => record.phase === 'failed')).toMatchObject([
      {
        cleanup: 'confirmed',
        request: { role: 'proposer' },
        error: { code: 'candidate-preparation-failed' }
      }
    ])
  }
  expect(completedRecords.every((record) => record.evidence.artifacts.length > 0)).toBe(true)
  const sessionIds = new Set(completedRecords.map((record) => record.identity.sessionId))
  expect(sessionIds.size).toBe(completedRecords.length)
  if (live)
    for (const record of completedRecords.filter((record) =>
      ['baseline', 'candidate'].includes(record.request.role)
    ))
      expect(
        [...readInputs].some((directory) => directory.includes(`/${record.executionId}/`))
      ).toBe(true)
  if (desktop && method) {
    const fixedBaseline = result.records.find(
      (record) => record.request.role === 'baseline' && record.request.origin.stageId === 'base1'
    )!
    expect(result.assessments?.baseline.targetExecutionId).toBe(fixedBaseline.executionId)
  }
  await client.$disconnect()
  const reopened = createProjectDbClient(configRoot)
  const owners = await createPersistentCandidateOwners({
    ...ownerOptions,
    getClient: async () => reopened
  })
  const journal = new FileExecutionStore(
    desktop
      ? join(root, 'desktop', desktopRunId!, 'execution/execution.json')
      : join(root, 'run/execution.json')
  )
  const core = new ExecutionCore(journal, {
    execute: async () => {
      throw new Error('Reopening must not launch any execution')
    }
  })
  let versionCount = 0,
    reviewCount = 0
  try {
    for (const record of result.records) {
      const restored = await core.get(record.executionId)
      expect(restored).toEqual(record)
      if (record.phase === 'failed') continue
      const exported = await owners.exportResult(restored)
      const reviews = await owners.readReviews(restored)
      expect(exported.files.length).toBeGreaterThan(0)
      expect(reviews.length).toBeGreaterThan(0)
      versionCount += exported.files.length
      reviewCount += reviews.length
      if (
        ['baseline', 'candidate'].includes(record.request.role) &&
        (!live ||
          !result.domain ||
          result.domain.tasks.some(
            (task) => task.assessments?.candidate.targetExecutionId === record.executionId
          ))
      ) {
        const taskIndex = research?.domain
          ? (result.methodResult as { tasks: Array<{ executionIds: string[] }> }).tasks.findIndex(
              (task) => task.executionIds.includes(record.executionId)
            )
          : 0
        expect(
          JSON.parse(exported.files.find((file) => file.path === 'result.json')!.content)
        ).toEqual({ count: 3, sum: taskIndex > 0 ? 15 : 6 })
      }
    }
    if (desktop) {
      if (result.domain) {
        expect(result.assessments).toBeUndefined()
        expect(result.outcome).toBeUndefined()
      } else expect(result.assessments).toBeTruthy()
      const repository = new ReviewRepository(async () => reopened, {
        snapshotStorageRoot: dataRoot
      })
      const allAssessments = result.domain
        ? result.domain.tasks.flatMap((task) => Object.values(task.assessments!))
        : Object.values(result.assessments!)
      for (const assessment of allAssessments) {
        const target = result.records.find(
          (record) => record.executionId === assessment.targetExecutionId
        )!
        const rows = await repository.getReviewsForProjectSession(
          project.id,
          target.identity.sessionId!
        )
        const semantic = rows.find((review) => review.id === assessment.reviewId)!
        const binding = semantic.reviewerLog.find(
          (entry) =>
            entry.kind === 'tool' && entry.toolName === 'earthnano.semantic-assessment-binding'
        )
        if (!binding || binding.kind !== 'tool' || !binding.rawInput)
          throw new Error('Missing original semantic provenance')
        const metadata = JSON.parse(binding.rawInput)
        const assessor = result.records.find(
          (record) => record.executionId === metadata.assessmentExecutionId
        )!
        const countBeforeReuse = await reopened.review.count()
        expect(
          await owners.commitSemanticReview({
            target,
            assessment: assessor,
            criteria: metadata.criteriaText,
            criteriaDigest: metadata.criteriaDigest,
            document: metadata.document
          })
        ).toEqual({ reviewId: semantic.id, outcome: semantic.outcome })
        expect(await reopened.review.count()).toBe(countBeforeReuse)
        expect(semantic.lifecycle).toBe('complete')
        expect(semantic.checks.length).toBe(1)
        expect(assessment.score).toBeGreaterThanOrEqual(0)
        reviewCount++
      }
      const outcomes = result.domain
        ? result.domain.tasks.map((task) => task.outcome!)
        : result.outcome
          ? [result.outcome]
          : []
      for (const outcome of outcomes) {
        if (!outcome.artifact.reviewId) continue
        const target = result.records.find(
          (record) =>
            record.request.harnessRevisionRef.id === outcome.configuration.harnessRevisionRef!.id &&
            record.request.role === 'candidate' &&
            record.evidence.artifacts.some((ref) =>
              outcome.artifact.checks.some(
                (check) => check.artifactRef?.versionId === ref.versionId
              )
            )
        )!
        const reviews = await repository.getReviewsForProjectSession(
          project.id,
          target.identity.sessionId!
        )
        const checkReview = reviews.find((review) => review.id === outcome.artifact.reviewId)!
        expect(checkReview.lifecycle).toBe('complete')
        expect(checkReview.outcome).toBe(outcome.artifact.status === 'passed' ? 'pass' : 'flagged')
        reviewCount++
      }
    }
  } finally {
    core.dispose()
    journal.close()
    await owners.shutdown()
    await reopened.$disconnect()
  }
  if (live && process.env.EARTHNANO_LIVE_DEEPSEEK_REPORT)
    await writeFile(
      process.env.EARTHNANO_LIVE_DEEPSEEK_REPORT,
      JSON.stringify(
        {
          status: 'passed',
          model: 'deepseek-flash',
          ...(method ? { method } : {}),
          executions: result.records.length,
          roles: result.records.map((record) => record.request.role),
          sessions: sessionIds.size,
          versionCount,
          reviewCount,
          verifiedInputReads: readInputs.size,
          ...(research?.domain
            ? {
                successorEditingContexts: successorContexts.size,
                verifiedSuccessorExperienceContexts: result.domain!.tasks[0]!.experience
                  ? successorContexts.size
                  : 0
              }
            : {}),
          reopened: true,
          configurationChanged: result.domain
            ? (
                result.methodResult as { tasks: Array<{ configurationChanged: boolean }> }
              ).tasks.some((task) => task.configurationChanged)
            : (result.methodResult as { configurationChanged: boolean }).configurationChanged,
          fallbackStages: result.domain
            ? (
                result.methodResult as { tasks: Array<{ fallbackStages: unknown[] }> }
              ).tasks.flatMap((task) => task.fallbackStages)
            : (result.methodResult as { fallbackStages: unknown[] }).fallbackStages,
          ...(result.domain
            ? {
                methodTasks: (
                  result.methodResult as {
                    tasks: Array<{
                      taskId: string
                      configurationChanged: boolean
                      fallbackStages: unknown[]
                    }>
                  }
                ).tasks.map((task) => ({
                  taskId: task.taskId,
                  configurationChanged: task.configurationChanged,
                  fallbackStages: task.fallbackStages
                }))
              }
            : {}),
          selection: (result.methodResult as { selection?: unknown }).selection,
          ...(result.domain ? { domain: result.domain } : {}),
          ...(result.outcome ? { outcome: result.outcome } : {}),
          ...(desktop
            ? {
                desktop: true,
                observedStates: [...observedStates],
                assessments: result.assessments,
                sharedBudget: { limit: executionLimit, admitted: result.records.length }
              }
            : {}),
          requests,
          rejects,
          usage,
          testOverrides: {
            thinking: 'disabled',
            maxOutputTokens: 1536,
            requestLimit
          },
          limitations: [
            desktop
              ? 'Independent model semantic judgments with exact quoted version evidence, not a proof of scientific validity'
              : 'Deterministic integrity/JSON review, not semantic scientific assessment',
            k > 1
              ? 'Original anonymous finals-only selector; independent comparison uses predeclared base1, not an aggregate of all baselines'
              : 'k1 trivial selection; no LLM selector',
            'Real model via test-only bounded observer',
            'No paid cancellation/adversarial replay'
          ]
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    ).then(() => {
      liveReportWritten = true
    })
}

it.skipIf(process.platform === 'win32')(
  'persists actual Sessions, versions and reviews through the original seven-stage Harness method and reopens them',
  () => exercise(false),
  480_000
)

const researchDomain: OptimizationDomainSpec = {
  name: 'csv-analysis',
  nextTasks: [
    {
      prompt:
        'Read INPUT/values.csv using Read. Calculate the number of data rows and sum of the value column. Write only JSON with count and sum to OUTPUT/result.json using Write.',
      files: [{ path: 'values.csv', content: 'id,value\none,4\ntwo,5\nthree,6\n' }],
      criteria:
        'The result excludes the header from its data row count.\nThe arithmetic sum matches the value column.',
      checks: [{ kind: 'json-value', path: 'result.json', pointer: '/sum', expected: 15 }]
    }
  ]
}
const sumCheck = (expected: number): OutputCheckSpec[] => [
  { kind: 'json-value', path: 'result.json', pointer: '/sum', expected }
]
it.skipIf(process.platform === 'win32')(
  'persists an experiment-local Library, reuses its first lesson on the second task, and separately verifies both results',
  () =>
    exercise(false, true, false, undefined, false, { domain: researchDomain, checks: sumCheck(6) }),
  480_000
)
it.skipIf(process.platform === 'win32')(
  'retains a completed lifecycle while a deterministic mismatch blocks configuration admission',
  () => exercise(false, true, false, undefined, false, { checks: sumCheck(7) }),
  480_000
)
it.skipIf(process.platform === 'win32')(
  'permits further validation only after passing pinned deterministic and independent semantic checks',
  () => exercise(false, true, false, undefined, false, { checks: sumCheck(6) }),
  480_000
)
it.skipIf(process.platform === 'win32')(
  'stops an explicit domain before any successor or experience execution is admitted',
  () =>
    exercise(false, true, true, undefined, false, { domain: researchDomain, checks: sumCheck(6) }),
  90_000
)
it.skipIf(
  process.platform === 'win32' ||
    process.env.EARTHNANO_LIVE_DEEPSEEK !== '1' ||
    !process.env.EARTHNANO_LIVE_DEEPSEEK_KEY_FILE ||
    process.env.EARTHNANO_LIVE_DOMAIN !== '1'
)(
  'validates original domain reflection and independent acceptance with authorized DeepSeek',
  () =>
    exercise(true, true, false, undefined, false, { domain: researchDomain, checks: sumCheck(6) }),
  480_000
)
it.skipIf(
  process.platform === 'win32' ||
    process.env.EARTHNANO_LIVE_DEEPSEEK !== '1' ||
    !process.env.EARTHNANO_LIVE_DEEPSEEK_KEY_FILE
)(
  'validates the persisted original Harness method with explicitly authorized DeepSeek',
  () => exercise(true),
  480_000
)

it.skipIf(process.platform === 'win32')(
  'runs desktop admission, progress and shared budget with independently persisted semantic reviews',
  () => exercise(false, true),
  480_000
)
it.skipIf(
  process.platform === 'win32' ||
    process.env.EARTHNANO_LIVE_DEEPSEEK !== '1' ||
    !process.env.EARTHNANO_LIVE_DEEPSEEK_KEY_FILE
)(
  'validates desktop optimization and independent semantic review with authorized DeepSeek',
  () => exercise(true, true),
  480_000
)

it.skipIf(process.platform === 'win32')(
  'stops a desktop optimization during a real native baseline without admitting later stages',
  () => exercise(false, true, true),
  90_000
)

for (const mode of ['sequential', 'parallel'] as const) {
  it.skipIf(process.platform === 'win32')(
    `persists desktop ${mode} k2 through the original selector and independent base1 assessment`,
    () => exercise(false, true, false, { mode, k: 2, concurrency: 2 }),
    480_000
  )
  it.skipIf(
    process.platform === 'win32' ||
      process.env.EARTHNANO_LIVE_DEEPSEEK !== '1' ||
      !process.env.EARTHNANO_LIVE_DEEPSEEK_KEY_FILE ||
      process.env.EARTHNANO_LIVE_METHOD_MODE !== mode
  )(
    `validates desktop ${mode} k2 selection with authorized DeepSeek`,
    () => exercise(true, true, false, { mode, k: 2, concurrency: 2 }),
    480_000
  )
}

it.skipIf(process.platform === 'win32')(
  'stops both concurrent native baselines without admitting a recursive successor',
  () => exercise(false, true, true, { mode: 'parallel', k: 2, concurrency: 2 }),
  90_000
)

it.skipIf(process.platform === 'win32')(
  'persists an ordinary failed proposer charge and accepts the original retry through real Sessions and reviews',
  () => exercise(false, true, false, undefined, true),
  480_000
)

it.skipIf(process.platform === 'win32')(
  'explicitly resumes partial original stages through real Sessions and Core without repeating completed model dispatches or charges',
  () => exercise(false, false, false, undefined, false, undefined, 2),
  240_000
)
