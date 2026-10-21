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
  it.each(['notebook-python', 'notebook-r', 'notebook-compute'] as const)(
    'denies %s for a method role before provider binding or runtime construction',
    async (tools) => {
      const f = fixture()
      f.request = { ...f.request, role: 'reviewer' }
      vi.mocked(f.snapshots.resolve).mockResolvedValue({
        agent: { backend: 'claude-code' },
        harness: { tools }
      } as never)
      const resolveBinding = vi.fn(binding)
      const openOwner = vi.fn(async () => f.owner)
      expect(
        await createClaudeCandidateDriver({ ...f, binding: resolveBinding, openOwner }).execute(
          f.request,
          f.context
        )
      ).toMatchObject({ phase: 'failed', cleanup: 'confirmed' })
      expect(resolveBinding).not.toHaveBeenCalled()
      expect(openOwner).not.toHaveBeenCalled()
      expect(f.snapshots.materialize).not.toHaveBeenCalled()
    }
  )

  it.each(['baseline', 'candidate'] as const)(
    'passes the trusted %s Compute role to native preparation before opening the original owner',
    async (role) => {
      const f = fixture()
      f.request = { ...f.request, role }
      vi.mocked(f.snapshots.resolve).mockResolvedValue({
        agent: { backend: 'claude-code' },
        harness: { tools: 'notebook-compute' }
      } as never)
      const openOwner = vi.fn(async () => f.owner)
      expect(
        await createClaudeCandidateDriver({ ...f, binding, openOwner }).execute(
          f.request,
          f.context
        )
      ).toMatchObject({ phase: 'completed', cleanup: 'confirmed' })
      expect(prepareClaudeCandidate).toHaveBeenLastCalledWith(expect.objectContaining({ role }))
      expect(openOwner).toHaveBeenCalledOnce()
      expect(f.owner.agent.prompt).toHaveBeenCalledOnce()
    }
  )

  it.each(['baseline', 'candidate'] as const)(
    'keeps %s R execution on the original ACP admission and physical retirement path',
    async (role) => {
      const f = fixture()
      f.request = { ...f.request, role }
      vi.mocked(f.snapshots.resolve).mockResolvedValue({
        agent: { backend: 'claude-code' },
        harness: { tools: 'notebook-r' }
      } as never)
      expect(
        await createClaudeCandidateDriver({
          ...f,
          binding,
          openOwner: async () => f.owner
        }).execute(f.request, f.context)
      ).toMatchObject({ phase: 'completed', cleanup: 'confirmed' })
      expect(f.context.identity).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'target-session', promptMessageId: 'target-prompt' })
      )
      expect(f.owner.agent.prompt).toHaveBeenCalledOnce()
      expect(f.owner.shutdown).toHaveBeenCalledOnce()
    }
  )

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

describe('durable original owner settlement boundary', () => {
  it('persists the exact identity and outcome only after original shutdown confirms all resources', async () => {
    const f = fixture()
    let release!: (value: { reaped: boolean }) => void
    f.owner.shutdown = vi.fn(
      () =>
        new Promise<{ reaped: boolean }>((resolve) => {
          release = resolve
        })
    )
    const ownerSettled = vi.fn(async () => undefined)
    const pending = createClaudeCandidateDriver({
      ...f,
      binding,
      openOwner: async () => f.owner,
      ownerSettled
    }).execute(f.request, f.context)
    await vi.waitFor(() => expect(f.owner.shutdown).toHaveBeenCalledOnce())
    expect(ownerSettled).not.toHaveBeenCalled()
    release({ reaped: true })
    expect(await pending).toMatchObject({ phase: 'completed', cleanup: 'confirmed' })
    expect(ownerSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        request: f.request,
        executionId: f.context.executionId,
        outcome: expect.objectContaining({ phase: 'completed', cleanup: 'confirmed' })
      })
    )
  })
  it('writes no receipt for unknown retirement and fences failed durable persistence', async () => {
    const f = fixture()
    const ownerSettled = vi.fn(async () => undefined)
    f.owner.shutdown = vi.fn(async () => ({ reaped: false }))
    const options = { ...f, binding, openOwner: async () => f.owner, ownerSettled }
    expect(await createClaudeCandidateDriver(options).execute(f.request, f.context)).toMatchObject({
      cleanup: 'unknown'
    })
    expect(ownerSettled).not.toHaveBeenCalled()
    f.owner.shutdown = vi.fn(async () => ({ reaped: true }))
    ownerSettled.mockRejectedValueOnce(new Error('disk unavailable'))
    expect(await createClaudeCandidateDriver(options).execute(f.request, f.context)).toMatchObject({
      phase: 'completed',
      cleanup: 'unknown'
    })
  })
})
