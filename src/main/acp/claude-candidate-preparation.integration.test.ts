import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
  chmod,
  readdir,
  lstat
} from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: true } }))

import type { ExecutionRequest, ExecutionRecord } from '../../shared/earthnano/execution-port'
import type { AcpRuntimeEvent } from '../../shared/acp'
import {
  createCandidateSnapshotStore,
  type MaterializedCandidate
} from '../earthnano/candidate-snapshot'
import { createClaudeCandidateDriver } from '../earthnano/claude-candidate-driver'
import { emptyExecutionState, ExecutionCore } from '../earthnano/execution-core'
import { AcpRuntime } from './runtime'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'
import { createAcpTaskAgentPort } from './task-agent-port'
import { createAcpCreateSessionWorkflow } from './create-session-workflow'
import type { AgentSpawnInput } from '../agent-framework/types'
import type { PreparedClaudeCandidate } from './claude-candidate-preparation'

const native = createRequire(import.meta.url).resolve(
  `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`
)
const version = '2.1.232'
type RequestBody = {
  model: string
  system: unknown
  messages: unknown[]
  tools?: Array<{ name: string }>
}
type Probe = {
  prepared: PreparedClaudeCandidate
  materialized: MaterializedCandidate
  children: ChildProcessWithoutNullStreams[]
  events: AcpRuntimeEvent[]
  reaped?: boolean
}

const send = (
  response: ServerResponse,
  body: RequestBody,
  content: { text: string } | { name: string; input: object },
  id: string
): void => {
  const tool = 'name' in content
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 11, output_tokens: 0 }
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
        usage: { output_tokens: 3 }
      }
    ],
    ['message_stop', { type: 'message_stop' }]
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  )
}

type ToolResult = { type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }
interface SetupResult {
  root: string
  core: ExecutionCore
  probes: Map<string, Probe>
  requests: Array<{ label: string; body: RequestBody }>
  freeze(label: string, skills?: boolean): Promise<ExecutionRequest>
  terminal(id: string): Promise<ExecutionRecord>
}
const setup = async (
  respond: (label: string, body: RequestBody, response: ServerResponse) => void
): Promise<SetupResult> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'earthnano-real-claude-')))
  const probes = new Map<string, Probe>()
  const requests: Array<{ label: string; body: RequestBody }> = []
  const server = createServer(async (request, response) => {
    if (!request.url?.startsWith('/v1/messages')) {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestBody
    const system = JSON.stringify(body.system)
    const label = ['A', 'B'].find((candidate) => system.includes(`FROZEN_SYSTEM_${candidate}`))
    if (!label) {
      send(response, body, { text: 'background' }, 'background')
      return
    }
    requests.push({ label, body })
    respond(label, body, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const snapshots = await createCandidateSnapshotStore({
    root: join(root, 'snapshots'),
    candidatesRoot: join(root, 'candidates')
  })
  const shutdowns: Array<() => Promise<unknown>> = []
  let disposeCore = (): void => undefined
  onTestFinished(async () => {
    disposeCore()
    await Promise.allSettled(shutdowns.map((stop) => stop()))
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
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
    vi.unstubAllEnvs()
  })
  const driver = createClaudeCandidateDriver({
    snapshots,
    binding: async (agent) => ({
      executablePath: native,
      runtimeVersion: version,
      providerRef: agent.providerRef,
      provider: {
        type: 'custom',
        model: agent.model,
        key: 'synthetic-candidate-key',
        baseUrl: endpoint,
        apiEndpoints: ['messages']
      }
    }),
    openOwner: async ({ prepared, materialized, request, context }) => {
      const label = materialized.snapshots.harness.instructions.includes('SYSTEM_A') ? 'A' : 'B'
      const probe: Probe = { prepared, materialized, children: [], events: [] }
      probes.set(label, probe)
      await mkdir(join(materialized.cwd, '.claude'), { recursive: true })
      await writeFile(
        join(materialized.cwd, '.claude/settings.json'),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } })
      )
      await writeFile(join(materialized.cwd, 'CLAUDE.md'), 'UNFROZEN_PROJECT_INSTRUCTIONS')
      const backend = {
        ...prepared.backend,
        framework: {
          ...prepared.backend.framework,
          spawn: (input: AgentSpawnInput) =>
            prepared.backend.framework.spawn({
              ...input,
              spawnProcess: (command, args, options) => {
                const child = spawn(command, args, options)
                probe.children.push(child)
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
            appVersion: 'candidate-integration',
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
      shutdowns.push(() => runtime.shutdownForQuit())
      const agent = createAcpTaskAgentPort(runtime, createAcpCreateSessionWorkflow(runtime))
      return {
        agent,
        preparePlan: async () => {
          const session = await agent.createSession({
            cwd: materialized.cwd,
            projectId: request.projectId,
            memoryEnabled: false,
            permissionProfile: 'ask'
          })
          const promptMessageId = `prompt-${context.executionId}`
          return {
            kind: 'prepared',
            projectId: request.projectId,
            prompt: {
              sessionId: session.sessionId,
              promptMessageId,
              text: materialized.snapshots.invocation.mission,
              provenanceContext: { promptMessageId }
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
            readResult: async (settlement) => ({
              phase: settlement.cancellationRequested
                ? 'cancelled'
                : settlement.promptError
                  ? 'failed'
                  : 'completed',
              evidence: {
                status: 'partial',
                scope:
                  'Ephemeral original ACP runtime text; no persisted ArtifactVersion or Review owner attached',
                text: probe.events
                  .filter((event) => event.kind === 'message' && event.role === 'assistant')
                  .map((event) => event.text ?? '')
                  .join(''),
                artifacts: [],
                references: [request.taskSnapshotRef, request.harnessRevisionRef],
                limitations: [
                  'Test owner reads original runtime events only; no artifact/version/review persistence.'
                ]
              },
              configuration: {
                ...prepared.configuration,
                status: 'unknown',
                confirmation:
                  'Preparation plus original ACP owner; test assertions independently inspect local provider requests.'
              }
            })
          }
        },
        shutdown: async () => {
          const result = await runtime.shutdownForQuit()
          probe.reaped = result.reaped
          return result
        }
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
  core.configureBudget('candidate-project', 'probe', 4)
  const freeze = async (label: string, skills = false): Promise<ExecutionRequest> => {
    const refs = await snapshots.freeze({
      task: {
        prompt: 'Read frozen input and write the output',
        files: [{ path: 'input.txt', content: 'FROZEN_TASK_INPUT_BYTES' }]
      },
      harness: {
        instructions: `FROZEN_SYSTEM_${label}`,
        skills: skills
          ? [
              {
                path: 'probe/SKILL.md',
                content:
                  '---\nname: probe\ndescription: Frozen probe skill\n---\nFROZEN_SKILL_MARKER\n'
              }
            ]
          : [],
        tools: 'workspace-only'
      },
      agent: {
        backend: 'claude-code',
        model: 'claude-sonnet-4-5',
        providerRef: 'local-anthropic',
        runtimeVersion: version
      },
      environment: { isolation: 'directory-process', network: 'provider-only' }
    })
    const invocationRef = await snapshots.freezeInvocation({
      taskSnapshotRef: refs.taskSnapshotRef,
      harnessRevisionRef: refs.harnessRevisionRef,
      mission: 'Execute the frozen task without changing its inputs.'
    })
    return {
      contractVersion: 1,
      requestKey: `candidate-${label}`,
      projectId: 'candidate-project',
      ...refs,
      invocationRef,
      role: 'candidate',
      origin: { kind: 'optimization', optimizationId: 'local-probe', stageId: label },
      interactionPolicy: 'deny-unresolved',
      budgetRef: 'probe',
      timeoutMs: 100_000
    }
  }
  const terminal = async (id: string): Promise<ExecutionRecord> => {
    await vi.waitFor(
      async () =>
        expect(['completed', 'failed', 'cancelled', 'interrupted']).toContain(
          (await core.get(id)).phase
        ),
      { timeout: 95_000, interval: 50 }
    )
    return core.get(id)
  }
  return { root, core, probes, requests, freeze, terminal }
}

it('loads frozen native system/Skill configuration and isolates concurrent real Claude candidates', async () => {
  const rounds = new Map<string, number>()
  const held: Array<() => void> = []
  let ready = false
  const release = (): void => {
    if (ready && held.length === 2) held.splice(0).forEach((action) => action())
  }
  const respond = (label: string, body: RequestBody, response: ServerResponse): void => {
    const probe = f.probes.get(label)!
    const other = f.probes.get(label === 'A' ? 'B' : 'A')!
    const step = rounds.get(label) ?? 0
    rounds.set(label, step + 1)
    const actions = [
      { name: 'Skill', input: { skill: 'earthnano-candidate:probe' } },
      { name: 'Read', input: { file_path: join(probe.materialized.inputDir, 'input.txt') } },
      {
        name: 'Write',
        input: {
          file_path: join(probe.materialized.outputDir, 'result.txt'),
          content: `${label}:FROZEN_TASK_INPUT_BYTES`
        }
      },
      { name: 'Read', input: { file_path: join(other.materialized.outputDir, 'private.txt') } },
      { name: 'Read', input: { file_path: join(f.root, 'host-private.txt') } },
      {
        name: 'Write',
        input: { file_path: join(probe.materialized.inputDir, 'input.txt'), content: 'MUTATED' }
      },
      {
        name: 'Write',
        input: { file_path: join(probe.materialized.outputDir, 'dangling'), content: 'ESCAPED' }
      },
      { name: 'WebFetch', input: { url: 'http://127.0.0.1:1/forbidden', prompt: 'fetch' } }
    ]
    send(response, body, actions[step] ?? { text: `DONE_${label}` }, `${label}_${step}`)
  }
  const f = await setup((label, body, response) => {
    if (!rounds.has(label)) {
      held.push(() => respond(label, body, response))
      release()
    } else respond(label, body, response)
  })
  await writeFile(join(f.root, 'host-private.txt'), 'HOST_PRIVATE_SENTINEL')
  // Synthetic pollution only. The real personal environment/config is never read.
  vi.stubEnv('ANTHROPIC_API_KEY', 'HOST_CREDENTIAL_SENTINEL')
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'HOST_OAUTH_SENTINEL')
  const a = await f.freeze('A', true),
    b = await f.freeze('B', true)
  expect(a.taskSnapshotRef).toEqual(b.taskSnapshotRef)
  expect(a.agentSpecRef).toEqual(b.agentSpecRef)
  const handles = await Promise.all([f.core.submit(a), f.core.submit(b)])
  await vi.waitFor(() => expect(f.probes.size).toBe(2), { timeout: 30_000 })
  for (const [label, probe] of f.probes) {
    await writeFile(join(probe.materialized.outputDir, 'private.txt'), `PRIVATE_CANDIDATE_${label}`)
    await symlink(
      join(f.root, `escaped-${label}.txt`),
      join(probe.materialized.outputDir, 'dangling')
    )
  }
  ready = true
  release()
  const results = await Promise.all(handles.map((handle) => f.terminal(handle.executionId)))
  expect(results.map((result) => [result.phase, result.cleanup])).toEqual([
    ['completed', 'confirmed'],
    ['completed', 'confirmed']
  ])
  expect(new Set(results.map((result) => result.identity.sessionId)).size).toBe(2)
  for (const [label, probe] of f.probes) {
    expect(probe.reaped).toBe(true)
    expect(probe.children).toHaveLength(1)
    expect(probe.children[0]!.exitCode !== null || probe.children[0]!.signalCode !== null).toBe(
      true
    )
    expect(await readFile(join(probe.materialized.inputDir, 'input.txt'), 'utf8')).toBe(
      'FROZEN_TASK_INPUT_BYTES'
    )
    expect(await readFile(join(probe.materialized.outputDir, 'result.txt'), 'utf8')).toBe(
      `${label}:FROZEN_TASK_INPUT_BYTES`
    )
    await expect(readFile(join(f.root, `escaped-${label}.txt`))).rejects.toThrow()
    const ownRequests = f.requests.filter((record) => record.label === label)
    expect(ownRequests.length).toBeGreaterThanOrEqual(9)
    expect(ownRequests.every((record) => record.body.model === 'claude-sonnet-4-5')).toBe(true)
    const bodies = ownRequests.map((record) => JSON.stringify(record.body)).join('\n')
    expect(bodies).toContain(`FROZEN_SYSTEM_${label}`)
    expect(bodies).not.toContain(`FROZEN_SYSTEM_${label === 'A' ? 'B' : 'A'}`)
    expect(bodies).toContain('FROZEN_SKILL_MARKER')
    expect(bodies).toContain('FROZEN_TASK_INPUT_BYTES')
    expect(bodies).not.toContain('HOST_PRIVATE_SENTINEL')
    expect(bodies).not.toContain(`PRIVATE_CANDIDATE_${label === 'A' ? 'B' : 'A'}`)
    expect(bodies).not.toContain('HOST_CREDENTIAL_SENTINEL')
    expect(bodies).not.toContain('UNFROZEN_PROJECT_INSTRUCTIONS')
    const content = (ownRequests.at(-1)!.body.messages as Array<{ content?: unknown }>).flatMap(
      (message) => (Array.isArray(message.content) ? message.content : [])
    ) as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>
    const resultOf = (step: number): ToolResult | undefined =>
      content.find(
        (block) => block.type === 'tool_result' && block.tool_use_id === `call_${label}_${step}`
      )
    expect(resultOf(0)?.is_error).not.toBe(true)
    expect(JSON.stringify(resultOf(0))).toContain('Launching skill: earthnano-candidate:probe')
    expect(JSON.stringify(ownRequests[0]!.body.messages)).not.toContain('FROZEN_SKILL_MARKER')
    expect(JSON.stringify(ownRequests[1]!.body.messages)).toContain('FROZEN_SKILL_MARKER')
    expect(resultOf(1)?.is_error).not.toBe(true)
    expect(JSON.stringify(resultOf(1))).toContain('FROZEN_TASK_INPUT_BYTES')
    expect(resultOf(2)?.is_error).not.toBe(true)
    for (const step of [3, 4, 5, 6, 7]) expect(resultOf(step)?.is_error).toBe(true)
    for (const forbidden of ['Bash', 'WebFetch', 'Agent', 'Task', 'WebSearch'])
      expect(ownRequests[0]!.body.tools?.map((tool) => tool.name)).not.toContain(forbidden)
  }
  expect(new Set([...f.probes.values()].map((probe) => probe.children[0]!.pid)).size).toBe(2)
  for (const key of [
    'HOME',
    'CLAUDE_CONFIG_DIR',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME'
  ])
    expect(
      new Set([...f.probes.values()].map((probe) => probe.prepared.backend.env[key])).size
    ).toBe(2)
}, 110_000)

it('cancels one real candidate through its Session owner while the other completes', async () => {
  const pending = new Map<string, { body: RequestBody; response: ServerResponse }>()
  const f = await setup((label, body, response) => {
    pending.set(label, { body, response })
  })
  const [a, b] = await Promise.all([f.freeze('A'), f.freeze('B')])
  const [ha, hb] = await Promise.all([f.core.submit(a), f.core.submit(b)])
  await vi.waitFor(() => expect(pending.size).toBe(2), { timeout: 40_000 })
  expect((await f.core.cancel(ha.executionId)).status).toBe('requested')
  const pb = pending.get('B')!
  send(pb.response, pb.body, { text: 'B_SURVIVES_A_CANCELLATION' }, 'B_survives')
  const [ra, rb] = await Promise.all([f.terminal(ha.executionId), f.terminal(hb.executionId)])
  expect([ra.phase, ra.cleanup]).toEqual(['cancelled', 'confirmed'])
  expect([rb.phase, rb.cleanup]).toEqual(['completed', 'confirmed'])
  expect([...f.probes.values()].every((probe) => probe.reaped)).toBe(true)
}, 110_000)
