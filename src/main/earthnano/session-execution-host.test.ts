import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { AcpExecutionDispatch } from '../acp/execution-boundary-port'
import type { SessionExecutionSettlement } from './session-execution-host-port'
const state = vi.hoisted(() => ({ session: {} as PersistedChatSession, archived: false }))
vi.mock('../session-persistence/projection', () => ({
  SessionProjectionRepository: class {
    async list(): Promise<unknown[]> {
      return [{ id: 'session', projectId: 'project' }]
    }
  }
}))
vi.mock('../session-persistence/repository', () => ({
  SessionRepository: class {},
  loadSessionMutationAuthority: async (): Promise<unknown> => ({
    status: 'found',
    session: structuredClone(state.session)
  })
}))
vi.mock('../projects/repository', () => ({
  ProjectRepository: class {
    async get(): Promise<unknown> {
      return { id: 'project', archivedAt: state.archived ? 1 : undefined }
    }
  }
}))
vi.mock('../settings/repository', () => ({
  SettingsRepository: class {
    async getSettings(): Promise<unknown> {
      return {
        agentFrameworkId: 'codex',
        activeModel: 'model',
        providers: [{ apiKey: 'SECRET_PROVIDER_KEY' }]
      }
    }
  }
}))
vi.mock('../managed-file-versions/service', () => ({ ManagedFileVersionService: class {} }))
import { createSessionExecutionHost } from './session-execution-host'
import { originalEvidenceCanonical, originalEvidenceDigest } from './original-turn-evidence'

let root: string
const closes: Array<() => void> = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'session-execution-host-'))
  state.archived = false
  state.session = {
    id: 'session',
    projectId: 'project',
    title: 'Original',
    cwd: root,
    status: 'idle',
    createdAt: 1,
    updatedAt: 3,
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'task',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        turnOutcome: { kind: 'completed', settledAt: 3 }
      },
      {
        id: 'reply',
        role: 'agent',
        content: 'original answer',
        responseToMessageId: 'prompt',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
    ]
  }
})
afterEach(async () => {
  for (const close of closes.splice(0)) close()
  await rm(root, { recursive: true, force: true })
})
const input = (): AcpExecutionDispatch => ({
  attemptId: 'attempt',
  operation: 'sendPrompt',
  runtimeReviewOwner: 'renderer',
  request: {
    sessionId: 'session',
    text: 'rich task',
    currentImages: [{ mimeType: 'image/png', data: 'TRANSIENT_MEDIA_BYTES', byteLength: 12 }],
    forcedSkillIds: ['skill'],
    historyPreamble: 'history',
    memoryEnabled: false,
    referencedSessions: [{ type: 'session', sessionId: 'other', title: 'Context' }]
  },
  dispatch: vi.fn(),
  cancelOwned: vi.fn()
})
const settlement = (
  overrides: Partial<SessionExecutionSettlement> = {}
): SessionExecutionSettlement => ({
  identity: { sessionId: 'session', promptMessageId: 'prompt' },
  context: {
    executionId: 'execution',
    signal: new AbortController().signal,
    identity: vi.fn(),
    emit: vi.fn(),
    running: vi.fn()
  },
  ...overrides
})
const host = (
  flush?: (sessionId: string, promptId: string) => Promise<unknown>
): ReturnType<typeof createSessionExecutionHost> =>
  createSessionExecutionHost({
    dataRoot: root,
    configRoot: root,
    getClient: async () => ({}) as PrismaClient,
    flush
  })
const prepare = async (h = host(), i = input()): Promise<Awaited<ReturnType<typeof h.prepare>>> => {
  const result = await h.prepare(i)
  closes.push(result.close)
  return result
}

it('freezes the entire rich request before awaiting original owners without dispatching or persisting media/secrets', async () => {
  const dispatch = input()
  const expected = originalEvidenceDigest(originalEvidenceCanonical(dispatch.request))
  const pending = prepare(host(), dispatch)
  dispatch.request.text = 'mutated'
  dispatch.request.currentImages![0].data = 'mutated'
  const prepared = await pending
  expect(prepared.request.taskSnapshotRef.digest).toBe(expected)
  expect(dispatch.dispatch).not.toHaveBeenCalled()
  expect(prepared.request).toMatchObject({
    role: 'task',
    timeoutMs: 0,
    interactionPolicy: 'interactive',
    origin: { kind: 'interactive' }
  })
  prepared.store.commit(prepared.store.load())
  const walk = async (path: string): Promise<string[]> => {
    const entries = await readdir(path, { withFileTypes: true })
    return (
      await Promise.all(
        entries.map((entry) =>
          entry.isDirectory()
            ? walk(join(path, entry.name))
            : readFile(join(path, entry.name), 'utf8').then((s) => [s])
        )
      )
    ).flat()
  }
  expect(JSON.stringify(await walk(root))).not.toMatch(
    /TRANSIENT_MEDIA_BYTES|SECRET_PROVIDER_KEY|currentImages/
  )
})
it('reserves exactly one ordinary admission and gives rearmed dispatches and host generations distinct keys', async () => {
  const h = host()
  const a = await prepare(h)
  const b = await prepare(h, { ...input(), attemptId: 'rearmed' })
  const c = await prepare(host())
  expect(new Set([a.request.requestKey, b.request.requestKey, c.request.requestKey]).size).toBe(3)
  expect(a.budgetLimit).toBe(1)
})
it('derives unattended policy from original request while retaining task role', async () => {
  const i = input()
  i.runtimeReviewOwner = 'task'
  i.request.permissionPrompts = 'none'
  expect((await prepare(host(), i)).request).toMatchObject({
    role: 'task',
    origin: { kind: 'automation' },
    interactionPolicy: 'deny-unresolved'
  })
})
it('flushes and reads the exact admitted original turn and leaves shared runtime retirement to its owner', async () => {
  const flush = vi.fn(async () => undefined)
  const result = await (await prepare(host(flush))).readResult(settlement())
  expect(flush).toHaveBeenCalledWith('session', 'prompt')
  expect(result).toMatchObject({
    phase: 'completed',
    cleanup: 'confirmed',
    evidence: { text: 'original answer', status: 'complete' },
    configuration: { status: 'unknown' }
  })
})
it.each(['failed', 'cancelled'] as const)(
  'preserves authoritative %s despite a successful provider return',
  async (kind) => {
    state.session.messages[0].turnOutcome =
      kind === 'failed'
        ? { kind, settledAt: 3, error: 'ORIGINAL_FAILURE' }
        : { kind, settledAt: 3, recovery: 'resume' }
    const result = await (await prepare()).readResult(settlement())
    expect(result.phase).toBe(kind)
    expect(result.cleanup).toBe('confirmed')
  }
)
it('never upgrades interrupted or still leased original turn to completion', async () => {
  const prepared = await prepare()
  state.session.messages[0].turnOutcome = {
    kind: 'interrupted',
    cause: 'app-restart',
    recovery: 'resume',
    settledAt: 3
  }
  expect(await prepared.readResult(settlement())).toMatchObject({
    phase: 'failed',
    cleanup: 'unknown'
  })
  state.session.messages[0].turnOutcome = { kind: 'completed', settledAt: 3 }
  state.session.activeRun = { promptMessageId: 'prompt', startedAt: 1 }
  expect(await prepared.readResult(settlement())).toMatchObject({
    phase: 'failed',
    cleanup: 'unknown'
  })
})
it('does not borrow the latest turn when original admission identity is absent or mismatched', async () => {
  const prepared = await prepare()
  await expect(
    prepared.readResult(settlement({ identity: { sessionId: 'session' } }))
  ).rejects.toThrow('identity')
  await expect(
    prepared.readResult(settlement({ identity: { sessionId: 'other', promptMessageId: 'prompt' } }))
  ).rejects.toThrow('identity')
})
it('retains dispatch rejection even when original Session has a completion witness', async () => {
  expect(
    await (await prepare()).readResult(settlement({ error: new Error('dispatch failure') }))
  ).toMatchObject({ phase: 'failed', cleanup: 'confirmed' })
})
it('rejects imported or archived original authority before opening a journal', async () => {
  state.archived = true
  await expect(host().prepare(input())).rejects.toThrow('Project')
  state.archived = false
  state.session.packageOrigin = {} as NonNullable<PersistedChatSession['packageOrigin']>
  await expect(host().prepare(input())).rejects.toThrow('Imported')
})
