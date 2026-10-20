import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { requestDigest } from './execution-contract'
import { emptyExecutionState } from './execution-core'
import type { ExecutionRecord } from '../../shared/earthnano/execution-port'
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

const historical = async (dead = true): Promise<{ file: string; record: ExecutionRecord }> => {
  const old = await prepare()
  const now = new Date().toISOString()
  const record: ExecutionRecord = {
    executionId: 'old-execution',
    requestKey: old.request.requestKey,
    request: old.request,
    requestDigest: requestDigest(old.request),
    phase: 'running',
    cleanup: 'pending',
    identity: { sessionId: 'session', promptMessageId: 'prompt', turnToken: 'old-token' },
    createdAt: now,
    updatedAt: now,
    cancellationRequested: false,
    evidence: {
      status: 'unavailable',
      scope: 'original',
      text: '',
      artifacts: [],
      references: [],
      limitations: []
    },
    usage: { status: 'unknown' },
    configuration: {
      status: 'unknown',
      requestedDigest: old.request.harnessRevisionRef.digest,
      instructions: [],
      skills: [],
      tools: [],
      confirmation: 'unknown'
    }
  }
  const saved = emptyExecutionState()
  saved.records[record.executionId] = record
  saved.events[record.executionId] = [
    { executionId: record.executionId, sequence: 1, type: 'phase', phase: 'running', time: now }
  ]
  saved.sequences[record.executionId] = 1
  saved.budgets[JSON.stringify([old.request.projectId, old.request.budgetRef])] = {
    limit: 1,
    admitted: 1
  }
  old.store.commit(saved)
  const directory = join(
    root,
    'executions',
    'session-attempts',
    (await readdir(join(root, 'executions', 'session-attempts')))[0]
  )
  const file = join(
    directory,
    (await readdir(directory)).find((entry) => entry.endsWith('.json'))!
  )
  if (dead) {
    old.close()
    closes.pop()
    await writeFile(file + '.lock', '2147483647')
  }
  state.session.runtimeSessionAdmissions = [
    {
      executionId: 'old-token',
      promptMessageId: 'prompt',
      promptRuntimeSegmentId: 'segment',
      rootFrameId: 'frame',
      agentFrameId: 'frame',
      messageBranchId: 'branch',
      runtimeSegmentId: 'segment'
    }
  ]
  state.session.runtimeTranscriptLastRun = { promptMessageId: 'prompt', startedAt: 1 }
  return { file, record }
}
it.each(['completed', 'failed', 'cancelled'] as const)(
  'reconciles a dead original %s owner before fresh admission without replaying or refunding',
  async (kind) => {
    const old = await historical()
    state.session.messages[0].turnOutcome =
      kind === 'completed'
        ? { kind, settledAt: 3 }
        : kind === 'failed'
          ? { kind, settledAt: 3, error: 'original failure' }
          : { kind, settledAt: 3, recovery: 'resume' }
    const dispatch = input()
    dispatch.attemptId = 'new-attempt'
    await prepare(host(), dispatch)
    const saved = JSON.parse(await readFile(old.file, 'utf8'))
    expect(saved.records[old.record.executionId]).toMatchObject({
      phase: kind,
      cleanup: 'confirmed',
      evidence: { status: 'complete', text: 'original answer' }
    })
    expect((Object.values(saved.budgets)[0] as { admitted: number }).admitted).toBe(1)
    expect(dispatch.dispatch).not.toHaveBeenCalled()
  }
)
it('reconciles original interruption while permitting only the explicitly prepared newer Resume attempt', async () => {
  const old = await historical()
  state.session.messages[0].turnOutcome = {
    kind: 'interrupted',
    cause: 'app-restart',
    recovery: 'resume',
    settledAt: 3
  }
  state.session.resumeRecovery = {
    kind: 'resume-required',
    promptMessageId: 'prompt',
    cause: 'app-restart'
  }
  state.session.activeRun = { promptMessageId: 'prompt', startedAt: 4 }
  const resumed = input()
  resumed.attemptId = 'authorized-resume'
  await prepare(host(), resumed)
  const saved = JSON.parse(await readFile(old.file, 'utf8'))
  expect(saved.records[old.record.executionId]).toMatchObject({
    phase: 'interrupted',
    cleanup: 'confirmed',
    evidence: { status: 'partial' }
  })
  expect(saved.records[old.record.executionId].evidence.limitations.join(' ')).toContain(
    'preparedResume'
  )
  expect(resumed.dispatch).not.toHaveBeenCalled()
  expect(Object.keys(saved.records)).toEqual(['old-execution'])
})
it.each(['live', 'unknown', 'rearmed', 'unapproved-resume', 'other-session'] as const)(
  'does not erase an unresolved %s resource fence with a new host generation',
  async (scenario) => {
    const old = await historical(scenario !== 'live')
    if (scenario === 'unknown') {
      delete state.session.messages[0].turnOutcome
      state.session.status = 'running'
    }
    if (scenario === 'rearmed')
      state.session.runtimeSessionAdmissions!.push({
        ...state.session.runtimeSessionAdmissions![0],
        executionId: 'newer-token'
      })
    if (scenario === 'unapproved-resume') {
      state.session.messages[0].turnOutcome = {
        kind: 'interrupted',
        cause: 'app-restart',
        recovery: 'resume',
        settledAt: 3
      }
      state.session.activeRun = { promptMessageId: 'prompt', startedAt: 4 }
    }
    if (scenario === 'other-session') {
      const saved = JSON.parse(await readFile(old.file, 'utf8'))
      saved.records['old-execution'].identity.sessionId = 'other'
      await writeFile(old.file, JSON.stringify(saved))
    }
    await expect(host().prepare({ ...input(), attemptId: 'new-generation' })).rejects.toThrow()
  }
)
it('does not let another Session live journal block this original resource', async () => {
  const old = await historical(false)
  const saved = JSON.parse(await readFile(old.file, 'utf8'))
  const record = saved.records[old.record.executionId] as ExecutionRecord
  record.request.origin.sessionId = 'another-session'
  record.identity.sessionId = 'another-session'
  record.requestDigest = requestDigest(record.request)
  await writeFile(old.file, JSON.stringify(saved))
  await prepare(host(), { ...input(), attemptId: 'unrelated-resource' })
  expect(JSON.parse(await readFile(old.file, 'utf8')).records[old.record.executionId].phase).toBe(
    'running'
  )
})
it('can resolve an earlier recovery fence when an exact interrupted Resume witness arrives in this process', async () => {
  const old = await historical()
  delete state.session.messages[0].turnOutcome
  state.session.status = 'running'
  await expect(host().prepare({ ...input(), attemptId: 'before-witness' })).rejects.toThrow(
    'witness'
  )
  state.session.messages[0].turnOutcome = {
    kind: 'interrupted',
    cause: 'app-restart',
    recovery: 'resume',
    settledAt: 3
  }
  state.session.resumeRecovery = {
    kind: 'resume-required',
    promptMessageId: 'prompt',
    cause: 'app-restart'
  }
  state.session.activeRun = { promptMessageId: 'prompt', startedAt: 4 }
  await prepare(host(), { ...input(), attemptId: 'explicit-resume-after-witness' })
  expect(
    JSON.parse(await readFile(old.file, 'utf8')).records[old.record.executionId]
  ).toMatchObject({ phase: 'interrupted', cleanup: 'confirmed' })
})

it('releases a proven pre-admission failure through the real host and boundary, including after host restart', async () => {
  const { createAcpExecutionBoundary } = await import('./acp-execution-boundary')
  const boundary = createAcpExecutionBoundary({ host: host() })
  let linked!: import('../acp/execution-boundary-port').AcpExecutionLink
  const failed = {
    ...input(),
    dispatch: vi.fn(async () => {
      throw new Error('provider startup failed')
    }),
    retireUnadmitted: vi.fn(async () => ({
      attemptId: 'attempt',
      sessionId: 'session',
      reaped: true as const
    })),
    ownerCompletion: {
      committed: Promise.resolve(),
      linked: (link: typeof linked) => {
        linked = link
      }
    }
  }
  await expect(boundary.execute(failed)).rejects.toThrow('provider startup failed')
  expect(await linked.settled).toMatchObject({
    phase: 'failed',
    cleanup: 'confirmed',
    error: { code: 'original-pre-admission-failed' }
  })
  expect(failed.retireUnadmitted).toHaveBeenCalledOnce()
  expect(await boundary.settle()).toBe(true)
  await expect(
    boundary.execute({
      ...failed,
      attemptId: 'same-boundary-retry',
      retireUnadmitted: undefined,
      dispatch: async (observer) => {
        observer.admitted({ sessionId: 'session', promptMessageId: 'prompt' })
        return { stopReason: 'end_turn' }
      }
    })
  ).resolves.toEqual({ stopReason: 'end_turn' })
  expect((await linked.settled).cleanup).toBe('confirmed')
  const retry = await prepare(host(), { ...input(), attemptId: 'retry' })
  expect(retry.request.origin.sessionId).toBe('session')
})

it.each(['missing', 'foreign', 'changed'] as const)(
  'keeps pre-admission cleanup fenced for %s retirement evidence',
  async (kind) => {
    const prepared = await prepare()
    const witness = { attemptId: 'attempt', sessionId: 'session', reaped: true as const }
    if (kind === 'foreign') witness.attemptId = 'other'
    if (kind === 'changed')
      state.session.runtimeSessionAdmissions = [{ executionId: 'hidden-admission' }] as never
    await expect(
      prepared.readResult(
        settlement({
          identity: {},
          error: new Error('startup failed'),
          preAdmissionRetirement: kind === 'missing' ? undefined : witness
        })
      )
    ).rejects.toThrow()
  }
)
