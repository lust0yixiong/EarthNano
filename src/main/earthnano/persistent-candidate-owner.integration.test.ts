import { createRequire } from 'node:module'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmod, lstat, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: true } }))
import { initDataRoot } from '../storage-root'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ReviewRepository } from '../reviewer/repository'
import { loadSessionMutationAuthority, SessionRepository } from '../session-persistence/repository'
import { createCandidateSnapshotStore } from './candidate-snapshot'
import { createClaudeCandidateDriver } from './claude-candidate-driver'
import { createPersistentCandidateOwners } from './persistent-candidate-owner'
import { emptyExecutionState, ExecutionCore } from './execution-core'
import type { ExecutionRecord, ExecutionRequest } from '../../shared/earthnano/execution-port'
type Body = { model: string; system: unknown; messages: unknown[] }
const send = (
  response: ServerResponse,
  body: Body,
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

it.skipIf(process.platform === 'win32')(
  'persists original Session, fixed output versions and scoped integrity Review across restart',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'earthnano-persistent-')))
    initDataRoot(root)
    const client = createProjectDbClient(root)
    let owners = createPersistentCandidateOwners({
      dataRoot: root,
      configRoot: root,
      getClient: async () => client
    })
    let disposeCore = (): void => undefined
    const server = createServer(async (req, response) => {
      if (!req.url?.startsWith('/v1/messages')) {
        response.writeHead(404)
        response.end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
      if (!JSON.stringify(body.system).includes('PERSISTED_SYSTEM')) {
        send(response, body, { text: 'background' }, 'background')
        return
      }
      const messages = JSON.stringify(body.messages)
      const output = /OUTPUT: ([^\n"\\]+)/.exec(messages)?.[1]
      if (!output) throw new Error('Missing explicit output location')
      if (!messages.includes('call_write'))
        send(
          response,
          body,
          {
            name: 'Write',
            input: {
              file_path: join(output, 'context/harness/instructions.md'),
              content: 'Persisted instructions'
            }
          },
          'write'
        )
      else if (!messages.includes('call_json'))
        send(
          response,
          body,
          {
            name: 'Write',
            input: { file_path: join(output, 'result.json'), content: '{"answer":42}' }
          },
          'json'
        )
      else send(response, body, { text: 'PERSISTED_FINAL_REPLY' }, 'final')
    })
    onTestFinished(async () => {
      disposeCore()
      await owners.shutdown()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await client.$disconnect()
      const unlock = async (path: string): Promise<void> => {
        const stat = await lstat(path)
        if (stat.isSymbolicLink()) return
        if (stat.isDirectory()) {
          await chmod(path, 0o700)
          for (const name of await readdir(path)) await unlock(join(path, name))
        }
      }
      await unlock(root)
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })
    await migrateApplicationDatabase(client)
    await client.project.create({
      data: { id: 'persistent-project', name: 'Synthetic persistent candidate' }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const snapshots = await createCandidateSnapshotStore({
      root: join(root, 'snapshots'),
      candidatesRoot: join(root, 'candidates')
    })
    const refs = await snapshots.freeze({
      task: {
        prompt: 'Write requested synthetic outputs',
        files: [{ path: 'input.txt', content: 'SYNTHETIC_INPUT' }]
      },
      harness: { instructions: 'PERSISTED_SYSTEM', skills: [], tools: 'workspace-only' },
      agent: {
        backend: 'claude-code',
        model: 'claude-sonnet-4-5',
        providerRef: 'synthetic-local',
        runtimeVersion: '2.1.232'
      },
      environment: { isolation: 'directory-process', network: 'provider-only' }
    })
    const invocationRef = await snapshots.freezeInvocation({
      taskSnapshotRef: refs.taskSnapshotRef,
      harnessRevisionRef: refs.harnessRevisionRef,
      mission: 'Write result.json and context/harness/instructions.md.'
    })
    const request: ExecutionRequest = {
      contractVersion: 1,
      requestKey: 'persistent-local',
      projectId: 'persistent-project',
      ...refs,
      invocationRef,
      role: 'candidate',
      origin: { kind: 'optimization', optimizationId: 'local', stageId: 'candidate' },
      interactionPolicy: 'deny-unresolved',
      budgetRef: 'synthetic',
      timeoutMs: 60000
    }
    let state = emptyExecutionState()
    const core = new ExecutionCore(
      {
        load: () => structuredClone(state),
        commit: (next) => {
          state = structuredClone(next)
        }
      },
      createClaudeCandidateDriver({
        snapshots,
        binding: async (agent) => ({
          executablePath: createRequire(import.meta.url).resolve(
            `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`
          ),
          runtimeVersion: agent.runtimeVersion,
          providerRef: agent.providerRef,
          provider: {
            type: 'custom',
            model: agent.model,
            key: 'synthetic-only',
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            apiEndpoints: ['messages']
          }
        }),
        openOwner: owners.openOwner
      })
    )
    disposeCore = () => core.dispose()
    core.configureBudget(request.projectId, request.budgetRef, 1)
    const handle = await core.submit(request)
    await vi.waitFor(
      async () =>
        expect(['completed', 'failed', 'cancelled', 'interrupted']).toContain(
          (await core!.get(handle.executionId)).phase
        ),
      { timeout: 60000, interval: 50 }
    )
    const record = await core.get(handle.executionId)
    expect(record, JSON.stringify(record)).toMatchObject({
      phase: 'completed',
      cleanup: 'confirmed',
      evidence: { status: 'complete', text: 'PERSISTED_FINAL_REPLY' }
    })
    expect(record.identity).toMatchObject({
      sessionId: expect.any(String),
      promptMessageId: expect.any(String),
      runtimeExecutionId: expect.any(String),
      promptAttemptId: expect.any(String),
      runId: expect.any(String)
    })
    expect(record.evidence.artifacts).toHaveLength(2)
    const session = await loadSessionMutationAuthority(
      new SessionRepository(root),
      request.projectId,
      record.identity.sessionId!
    )
    expect(session.status).toBe('found')
    if (session.status !== 'found') throw new Error('Session not persisted')
    expect(session.session.activeRun).toBeUndefined()
    expect(session.session.runtimeTranscriptOwner).toBe('main')
    expect(session.session.artifacts).toHaveLength(2)
    const before = await owners.exportResult(record)
    expect(before.files.map((f) => f.path).sort()).toEqual([
      'context/harness/instructions.md',
      'result.json'
    ])
    expect(before.files.find((f) => f.path === 'result.json')?.content).toBe('{"answer":42}')
    expect(await owners.readReviews(record)).toMatchObject([
      {
        lifecycle: 'complete',
        outcome: 'pass',
        model: 'deterministic-file-integrity-v1',
        checks: expect.any(Array)
      }
    ])
    expect(await client.reviewScopeSnapshot.count()).toBe(1)
    expect(await client.artifactVersion.count()).toBe(2)
    expect(await owners.shutdown()).toEqual({ reaped: true })
    expect(await owners.shutdown()).toEqual({ reaped: true })
    // A new factory must resolve originals without its predecessor's volatile maps or candidate cwd.
    owners = createPersistentCandidateOwners({
      dataRoot: root,
      configRoot: root,
      getClient: async () => client
    })
    await writeFile(
      join(root, 'candidates', record.executionId, 'workspace/outputs/result.json'),
      'MUTATED_CWD'
    )
    expect(await owners.exportResult(record)).toEqual(before)
    const forged = structuredClone(record) as ExecutionRecord
    forged.evidence.artifacts[0].checksum = '0'.repeat(64)
    await expect(owners.exportResult(forged)).rejects.toThrow()
    const review = (await owners.readReviews(record))[0]
    await new ReviewRepository(async () => client, { snapshotStorageRoot: root }).updateReview(
      review.id,
      { model: 'mutated-review-model' }
    )
    await expect(owners.readReviews(record)).rejects.toThrow('Pinned Review')
  },
  90000
)
