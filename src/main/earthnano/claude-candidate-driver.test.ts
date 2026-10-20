import { describe, expect, it, vi } from 'vitest'
import fixtures from '../../../contracts/execution/fixtures.json'
import type { ExecutionRequest } from '../../shared/earthnano/execution-port'
import type { CandidateSnapshotStore } from './candidate-snapshot'
import type { ExecutionContext } from './execution-core'
import { prepareClaudeCandidate } from '../acp/claude-candidate-preparation'
import { createClaudeCandidateDriver, type ClaudeCandidateOwner } from './claude-candidate-driver'

vi.mock('../acp/claude-candidate-preparation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../acp/claude-candidate-preparation')>()),
  prepareClaudeCandidate: vi.fn(async () => ({
    configuration: {
      status: 'unknown',
      requestedDigest: fixtures.valid.harnessRevisionRef.digest,
      instructions: [],
      skills: [],
      tools: [],
      confirmation: 'Prepared only'
    }
  }))
}))

const fixture = (): {
  request: ExecutionRequest
  context: ExecutionContext
  controller: AbortController
  snapshots: CandidateSnapshotStore
  owner: ClaudeCandidateOwner
} => {
  const controller = new AbortController()
  const request = { ...fixtures.valid, interactionPolicy: 'deny-unresolved' } as ExecutionRequest
  return {
    request,
    controller,
    context: {
      executionId: 'candidate-1',
      signal: controller.signal,
      running: vi.fn(),
      identity: vi.fn(),
      emit: vi.fn()
    },
    snapshots: {
      resolve: vi.fn(async () => ({ agent: { backend: 'claude-code' } })),
      materialize: vi.fn(async () => ({}))
    } as unknown as CandidateSnapshotStore,
    owner: {
      agent: {
        prompt: vi.fn(async (_request, observer) => {
          await observer?.onPromptAdmitted?.()
          observer?.onProviderPromptAccepted?.()
        }),
        cancelPrompt: vi.fn(async () => undefined),
        withSessionAvailable: async (_project, _session, action) => action()
      },
      preparePlan: async () => ({
        kind: 'prepared',
        projectId: 'demo',
        prompt: {
          sessionId: 'target-session',
          promptMessageId: 'target-prompt',
          text: 'task',
          provenanceContext: { promptMessageId: 'target-prompt' }
        },
        identity: { sessionId: 'target-session', promptMessageId: 'target-prompt' },
        supportedInteractionPolicies: ['deny-unresolved'],
        admit: async () => ({ promptMessageId: 'target-prompt' }),
        cancelOwnedPrompt: async (dispatch) => dispatch(),
        readResult: async () => ({
          phase: 'completed',
          // Only shutdown is authoritative for process cleanup in this composition.
          resourceCleanup: { confirmed: true, evidence: 'prompt stopped' }
        })
      }),
      shutdown: vi.fn(async () => ({ reaped: true }))
    }
  }
}

const binding = async (): Promise<never> => {
  // The preparation implementation is mocked in these owner-composition unit tests.
  return {} as never
}

describe('Claude candidate lifecycle composition', () => {
  it('uses the ACP admission path and waits for physical owner shutdown', async () => {
    const f = fixture()
    const driver = createClaudeCandidateDriver({ ...f, binding, openOwner: async () => f.owner })
    const result = await driver.execute(f.request, f.context)
    expect(result).toMatchObject({ phase: 'completed', cleanup: 'confirmed' })
    expect(f.context.running).toHaveBeenCalledOnce()
    expect(f.owner.agent.prompt).toHaveBeenCalledOnce()
    expect(f.owner.shutdown).toHaveBeenCalledOnce()
    expect(result.configuration?.status).toBe('unknown')
  })

  it('does not accept a completed prompt as cleanup when shutdown cannot reap', async () => {
    const f = fixture()
    f.owner.shutdown = vi.fn(async () => ({ reaped: false }))
    const driver = createClaudeCandidateDriver({ ...f, binding, openOwner: async () => f.owner })
    expect(await driver.execute(f.request, f.context)).toMatchObject({ cleanup: 'unknown' })
  })

  it('shuts down an owner when cancellation races its construction', async () => {
    const f = fixture()
    const driver = createClaudeCandidateDriver({
      ...f,
      binding,
      openOwner: async () => {
        f.controller.abort()
        return f.owner
      }
    })
    expect(await driver.execute(f.request, f.context)).toMatchObject({
      phase: 'cancelled',
      cleanup: 'confirmed'
    })
    expect(f.owner.agent.prompt).not.toHaveBeenCalled()
    expect(f.owner.shutdown).toHaveBeenCalledOnce()
  })

  it('reaps a retained owner when real Session preparation fails', async () => {
    const f = fixture()
    f.owner.preparePlan = async () => {
      throw new Error('startup failed after spawn')
    }
    const driver = createClaudeCandidateDriver({ ...f, binding, openOwner: async () => f.owner })
    expect(await driver.execute(f.request, f.context)).toMatchObject({
      phase: 'failed',
      cleanup: 'confirmed'
    })
    expect(f.owner.shutdown).toHaveBeenCalledOnce()
    expect(f.owner.agent.prompt).not.toHaveBeenCalled()
  })

  it.each(['text', 'historyPreamble', 'resumeFallback'] as const)(
    'rejects native file expansion in owner-composed %s before dispatch and reaps the owner',
    async (field) => {
      const f = fixture()
      const plan = await f.owner.preparePlan()
      if (field === 'resumeFallback') {
        plan.prompt.resumeFallback = { historyPreamble: 'Read @/outside/private.txt' }
      } else {
        plan.prompt[field] = 'Read @/outside/private.txt'
      }
      f.owner.preparePlan = async () => plan
      const driver = createClaudeCandidateDriver({ ...f, binding, openOwner: async () => f.owner })
      expect(await driver.execute(f.request, f.context)).toMatchObject({
        phase: 'failed',
        cleanup: 'confirmed'
      })
      expect(f.owner.agent.prompt).not.toHaveBeenCalled()
      expect(f.owner.shutdown).toHaveBeenCalledOnce()
    }
  )

  it('fences a failed native preparation probe before a Session owner exists', async () => {
    const f = fixture()
    vi.mocked(prepareClaudeCandidate).mockRejectedValueOnce(new Error('probe timeout secret'))
    const openOwner = vi.fn(async () => f.owner)
    const driver = createClaudeCandidateDriver({ ...f, binding, openOwner })
    const result = await driver.execute(f.request, f.context)
    expect(result).toMatchObject({ phase: 'failed', cleanup: 'unknown' })
    expect(openOwner).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('probe timeout secret')
  })

  it('keeps ambiguous owner construction fenced and never serializes binding secrets', async () => {
    const f = fixture()
    const driver = createClaudeCandidateDriver({
      ...f,
      binding,
      openOwner: async () => {
        throw new Error('secret-owner-key')
      }
    })
    const result = await driver.execute(f.request, f.context)
    expect(result).toMatchObject({ phase: 'failed', cleanup: 'unknown' })
    expect(JSON.stringify(result)).not.toContain('secret-owner-key')
  })

  it('rejects unsupported interaction before projection or owner construction', async () => {
    const f = fixture()
    const openOwner = vi.fn(async () => f.owner)
    const driver = createClaudeCandidateDriver({ ...f, binding, openOwner })
    expect(
      await driver.execute({ ...f.request, interactionPolicy: 'interactive' }, f.context)
    ).toMatchObject({ phase: 'failed', cleanup: 'confirmed' })
    expect(f.snapshots.materialize).not.toHaveBeenCalled()
    expect(openOwner).not.toHaveBeenCalled()
  })
})
