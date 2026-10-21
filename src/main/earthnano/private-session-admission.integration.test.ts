import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: true } }))
import { SessionRepository, loadSessionMutationAuthority } from '../session-persistence/repository'
import {
  SessionPersistenceCoordinator,
  type SessionFileIndex
} from '../session-persistence/coordinator'
import { RuntimeSessionOwner } from '../session-persistence/runtime-session-owner'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { getActiveConversationContext } from '../../shared/conversation-graph'
import { initDataRoot } from '../storage-root'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const index = (): SessionFileIndex => ({
  syncSession: async () => [],
  softDeleteSession: async () => 'unused',
  restoreSession: async () => {},
  softDeleteProject: async () => 'unused',
  reconcileProjectSessions: async () => {},
  reconcileActiveSessions: async () => {},
  markReconciliationIncomplete: () => {}
})
const freshRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'earthnano-admission-race-'))
  roots.push(root)
  initDataRoot(root)
  return root
}
const stage = async (
  coordinator: SessionPersistenceCoordinator,
  root: string
): Promise<PersistedChatSession> => {
  const idle = await coordinator.saveSession(
    materializeSessionConversationGraph({
      id: 's',
      projectId: 'p',
      title: 'candidate',
      cwd: root,
      status: 'idle',
      messages: [],
      agentFrameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 1
    })
  )
  const staged = materializeSessionConversationGraph({
    ...idle,
    status: 'running',
    activeRun: { promptMessageId: 'prompt', startedAt: 2 },
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'task',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
    ],
    updatedAt: 2
  })
  await coordinator.admitTaskTurn({ session: staged, contextReset: false })
  return staged
}
const raw = async (repository: SessionRepository): Promise<PersistedChatSession> => {
  const result = await loadSessionMutationAuthority(repository, 'p', 's')
  if (result.status !== 'found') throw new Error('Missing durable Session')
  return result.session
}
const begin = (
  repository: SessionRepository,
  coordinator: SessionPersistenceCoordinator,
  staged: PersistedChatSession
): Promise<unknown> => {
  const provenance = getActiveConversationContext(staged.conversationGraph!, 'prompt')!
  const runtime = new RuntimeSessionOwner({
    loadSession: () => raw(repository),
    mutateSession: (scope, mutate) => coordinator.mutateRuntimeSession(scope, mutate),
    finalizeArtifacts: async () => [],
    scheduleFlush: () => () => undefined
  })
  return runtime.begin(
    {
      projectId: 'p',
      sessionId: 's',
      promptMessageId: 'prompt',
      executionId: 'execution',
      agentFrameId: provenance.agentFrameId,
      messageBranchId: provenance.messageBranchId,
      runtimeSegmentId: provenance.runtimeSegmentId
    },
    { reviewOwner: 'task' }
  )
}

// These controls run unchanged against the pinned OpenScience source: its recovery and admission
// assertions are correct when the app knows its original runtime, and reject an unowned activeRun.
it.each([false, true])(
  'original hydration between Task admission and runtime begin; globally live=%s',
  async (globallyLive) => {
    const root = await freshRoot()
    const privateRepository = new SessionRepository(root)
    const privateCoordinator = new SessionPersistenceCoordinator(privateRepository, index())
    const appRepository = new SessionRepository(root, { hasLiveRuntimeSession: () => globallyLive })
    const appCoordinator = new SessionPersistenceCoordinator(appRepository, index())
    const staged = await stage(privateCoordinator, root)
    expect((await raw(privateRepository)).activeRun?.promptMessageId).toBe('prompt')
    await appCoordinator.loadAll()
    const after = await raw(privateRepository)
    if (globallyLive) {
      expect(after.activeRun?.promptMessageId).toBe('prompt')
      await expect(begin(privateRepository, privateCoordinator, staged)).resolves.toBeDefined()
    } else {
      expect(after.activeRun).toBeUndefined()
      expect(after.resumeRecovery?.cause).toBe('app-restart')
      await expect(begin(privateRepository, privateCoordinator, staged)).rejects.toThrow(
        'Runtime Session turn is unknown or superseded.'
      )
    }
  }
)

it('shares original admission and hydration authority with exact revocable live-runtime scope', async () => {
  const root = await freshRoot()
  const repository = new SessionRepository(root)
  const coordinator = new SessionPersistenceCoordinator(repository, index())
  const release = repository.registerRuntimeSessionLiveness({
    projectId: 'p',
    sessionId: 's',
    isLive: () => true
  })
  expect(repository.hasLiveRuntimeSession('other-project', 's')).toBe(false)
  expect(repository.hasLiveRuntimeSession('p', 'other-session')).toBe(false)
  const staged = await stage(coordinator, root)
  await coordinator.loadAll()
  expect((await raw(repository)).activeRun?.promptMessageId).toBe('prompt')
  await expect(begin(repository, coordinator, staged)).resolves.toBeDefined()
  release()
  release()
  expect(repository.hasLiveRuntimeSession('p', 's')).toBe(false)
})

it.each(['released', 'detached', 'cold-process'] as const)(
  'restores original app-restart reconciliation after private runtime is %s',
  async (lifecycle) => {
    const root = await freshRoot()
    let live = true
    const repository = new SessionRepository(root)
    const coordinator = new SessionPersistenceCoordinator(repository, index())
    const release = repository.registerRuntimeSessionLiveness({
      projectId: 'p',
      sessionId: 's',
      isLive: () => live
    })
    const staged = await stage(coordinator, root)
    await coordinator.loadAll()
    expect((await raw(repository)).activeRun?.promptMessageId).toBe('prompt')
    if (lifecycle === 'released') release()
    if (lifecycle === 'detached') live = false
    const recoveringRepository =
      lifecycle === 'cold-process' ? new SessionRepository(root) : repository
    const recoveringCoordinator =
      lifecycle === 'cold-process'
        ? new SessionPersistenceCoordinator(recoveringRepository, index())
        : coordinator
    expect(recoveringRepository.hasLiveRuntimeSession('p', 's')).toBe(false)
    await recoveringCoordinator.loadAll()
    const recovered = await raw(recoveringRepository)
    expect(recovered.activeRun).toBeUndefined()
    expect(recovered.resumeRecovery?.cause).toBe('app-restart')
    await expect(begin(recoveringRepository, recoveringCoordinator, staged)).rejects.toThrow(
      'Runtime Session turn is unknown or superseded.'
    )
    release()
  }
)

it('revokes only its own live registration and cannot revoke a later owner', async () => {
  const repository = new SessionRepository(await freshRoot())
  const scope = { projectId: 'p', sessionId: 's', isLive: () => true }
  const releaseFirst = repository.registerRuntimeSessionLiveness(scope)
  const releaseSecond = repository.registerRuntimeSessionLiveness(scope)
  releaseFirst()
  expect(repository.hasLiveRuntimeSession('p', 's')).toBe(true)
  releaseSecond()
  expect(repository.hasLiveRuntimeSession('p', 's')).toBe(false)
  const releaseSuccessor = repository.registerRuntimeSessionLiveness(scope)
  releaseFirst()
  releaseSecond()
  expect(repository.hasLiveRuntimeSession('p', 's')).toBe(true)
  releaseSuccessor()
  expect(repository.hasLiveRuntimeSession('p', 's')).toBe(false)
})
