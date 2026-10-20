import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtures from '../../../contracts/execution/fixtures.json'
import type { AcpPromptRequest } from '../../shared/acp'
import type {
  ExecutionEvent,
  ExecutionRecord,
  ExecutionRequest
} from '../../shared/earthnano/execution-port'
import {
  emptyExecutionState,
  type ExecutionCore,
  type ExecutionStore
} from '../earthnano/execution-core'
import {
  createAcpExecutionCore,
  type AcpExecutionOwnerResult,
  type AcpExecutionResolver,
  type PreparedAcpExecution
} from './earthnano-execution-driver'
import { createAcpTaskAgentPort } from './task-agent-port'

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const request = (key = 'task'): ExecutionRequest => ({
  ...(structuredClone(fixtures.valid) as ExecutionRequest),
  requestKey: key
})
const provenance = { promptMessageId: 'prompt-original' }
const cores: ExecutionCore[] = []
afterEach(() => {
  cores.splice(0).forEach((core) => core.dispose())
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Preserve inferred mock fixture signatures.
function setup() {
  let state = emptyExecutionState()
  const store: ExecutionStore = {
    load: () => structuredClone(state),
    commit: (next) => {
      state = structuredClone(next)
    }
  }
  const outcome: AcpExecutionOwnerResult = {
    phase: 'completed',
    resourceCleanup: {
      confirmed: true,
      evidence: 'fake resource owner observed process retirement'
    },
    identity: {
      runtimeExecutionId: 'runtime-original',
      turnToken: 'turn-original',
      promptExecutionId: 'prompt-execution-original',
      promptAttemptId: 'attempt-original'
    },
    evidence: {
      status: 'partial',
      scope: 'owner-public-output',
      text: 'owner committed text',
      artifacts: [
        { artifactId: 'artifact-original', versionId: 'version-1', checksum: 'sha256:original' }
      ],
      references: [structuredClone(fixtures.valid.invocationRef)],
      limitations: ['Declared public output only']
    },
    usage: { status: 'unknown' }
  }
  const plan: PreparedAcpExecution = {
    kind: 'prepared',
    projectId: 'demo',
    prompt: {
      sessionId: 'session-original',
      promptMessageId: 'prompt-original',
      provenanceContext: provenance,
      text: 'frozen invocation'
    },
    identity: { runId: 'run-original', providerSessionId: 'provider-original' },
    supportedInteractionPolicies: ['interactive', 'deny-unresolved'],
    admit: vi.fn(async () => provenance),
    cancelOwnedPrompt: vi.fn(async (dispatch) => dispatch()),
    readResult: vi.fn(async () => outcome)
  }
  const runtime = {
    getSnapshot: () => ({ sessionIds: ['session-original'] }),
    resumeSession: vi.fn(),
    setPermissionProfile: vi.fn(),
    setMemoryEnabled: vi.fn(),
    sendPrompt: vi.fn(async () => undefined),
    sendPromptObserved: vi.fn(
      async (
        _request: AcpPromptRequest,
        accepted: () => void,
        admitted?: () => Promise<AcpPromptRequest['provenanceContext']>
      ) => {
        await admitted?.()
        accepted()
      }
    ),
    cancelPrompt: vi.fn(async () => undefined)
  }
  const notifications = { trackPrompt: vi.fn(() => ({ token: 1 })), untrackPrompt: vi.fn() }
  const archiveChecks = vi.fn()
  const archive = {
    withSessionAvailable: async <Result>(
      project: string,
      session: string,
      operation: () => Promise<Result>
    ): Promise<Result> => {
      archiveChecks(project, session, operation)
      return operation()
    }
  }
  const agent = createAcpTaskAgentPort(runtime, { create: vi.fn() }, notifications, archive)
  const resolver: AcpExecutionResolver = { resolve: vi.fn(async () => plan) }
  const core = createAcpExecutionCore({ store, agent, resolver })
  core.configureBudget('demo', 'trial', 10)
  cores.push(core)
  return { core, agent, runtime, resolver, plan, outcome, notifications, archiveChecks }
}
const finished = async (core: ExecutionCore, id: string): Promise<ExecutionRecord> => {
  await vi.waitFor(async () =>
    expect(['completed', 'failed', 'cancelled', 'interrupted']).toContain(
      (await core.get(id)).phase
    )
  )
  return core.get(id)
}
const events = async (core: ExecutionCore, id: string): Promise<ExecutionEvent[]> => {
  const result: ExecutionEvent[] = []
  for await (const event of core.events(id)) result.push(event)
  return result
}

describe('opt-in ACP ExecutionCore adapter', () => {
  it('executes ordinary and candidate requests through the extracted Task dispatch and notifications', async () => {
    const s = setup()
    const ordinary = request()
    const candidate = request('candidate')
    candidate.role = 'candidate'
    candidate.origin = {
      kind: 'optimization',
      optimizationId: 'optimization-1',
      stageId: 'candidate-1',
      sessionId: 'source-user-session',
      promptMessageId: 'source-user-prompt'
    }
    for (const input of [ordinary, candidate]) {
      const handle = await s.core.submit(input)
      expect(handle.phase).toBe('queued')
      const result = await finished(s.core, handle.executionId)
      expect(result.phase).toBe('completed')
      expect(result.request.origin).toEqual(input.origin)
      expect(result.identity.sessionId).toBe('session-original')
    }
    expect(s.resolver.resolve).toHaveBeenCalledTimes(2)
    expect(vi.mocked(s.resolver.resolve).mock.calls.map(([r]) => r.role)).toEqual([
      'task',
      'candidate'
    ])
    expect(s.runtime.sendPromptObserved).toHaveBeenCalledTimes(2)
    expect(s.runtime.sendPrompt).not.toHaveBeenCalled()
    expect(s.notifications.trackPrompt).toHaveBeenCalledTimes(2)
    expect(s.notifications.untrackPrompt).not.toHaveBeenCalled()
    expect(s.archiveChecks).toHaveBeenCalledWith('demo', 'session-original', expect.any(Function))
  })

  it('separates queued/core admission, Session admission, provider acceptance and owner result commit', async () => {
    const s = setup()
    const admission = deferred()
    const providerStop = deferred()
    const ownerCommit = deferred()
    s.runtime.sendPromptObserved.mockImplementation(async (_r, accepted, admitted) => {
      await admission.promise
      await admitted?.()
      accepted()
      await providerStop.promise
    })
    vi.mocked(s.plan.readResult).mockImplementation(async () => {
      await ownerCommit.promise
      return s.outcome
    })
    const input = request()
    const h = await s.core.submit(input)
    expect(s.runtime.sendPromptObserved).not.toHaveBeenCalled()
    input.invocationRef.id = 'later mutation'
    await vi.waitFor(() => expect(s.runtime.sendPromptObserved).toHaveBeenCalledOnce())
    expect((await s.core.get(h.executionId)).phase).toBe('preparing')
    expect((await events(s.core, h.executionId)).map((e) => e.type)).not.toContain(
      'session-admitted'
    )
    expect(vi.mocked(s.resolver.resolve).mock.calls[0][0].invocationRef.id).toBe('snapshot')
    admission.resolve()
    await vi.waitFor(async () =>
      expect((await events(s.core, h.executionId)).map((e) => e.type)).toContain(
        'provider-accepted'
      )
    )
    expect((await s.core.get(h.executionId)).phase).toBe('running')
    expect(s.plan.readResult).not.toHaveBeenCalled()
    providerStop.resolve()
    await vi.waitFor(() => expect(s.plan.readResult).toHaveBeenCalledOnce())
    expect((await s.core.get(h.executionId)).phase).toBe('running')
    ownerCommit.resolve()
    expect((await finished(s.core, h.executionId)).phase).toBe('completed')
  })

  it('returns immutable owner identities/version evidence, with unknown configuration and usage preserved', async () => {
    const s = setup()
    const h = await s.core.submit(request())
    const result = await finished(s.core, h.executionId)
    expect(result.identity).toEqual({
      runId: 'run-original',
      sessionId: 'session-original',
      promptMessageId: 'prompt-original',
      providerSessionId: 'provider-original',
      ...s.outcome.identity
    })
    expect(h.executionId).not.toBe(result.identity.runtimeExecutionId)
    expect(result.evidence).toEqual(s.outcome.evidence)
    expect(result.configuration.status).toBe('unknown')
    expect(result.configuration.model).toBeUndefined()
    expect(result.usage).toEqual({ status: 'unknown' })
    s.outcome.evidence!.artifacts[0].versionId = 'version-2'
    expect((await s.core.get(h.executionId)).evidence.artifacts[0].versionId).toBe('version-1')
  })

  it('enforces deny-unresolved through the existing ACP permission flag', async () => {
    const s = setup()
    const input = request()
    input.interactionPolicy = 'deny-unresolved'
    const h = await s.core.submit(input)
    await finished(s.core, h.executionId)
    expect(s.runtime.sendPromptObserved).toHaveBeenCalledWith(
      expect.objectContaining({ permissionPrompts: 'none' }),
      expect.any(Function),
      expect.any(Function),
      'task'
    )
    expect(s.plan.prompt.permissionPrompts).toBeUndefined()
  })

  it.each([
    [
      'project',
      (s: ReturnType<typeof setup>) => {
        s.plan.projectId = 'other'
      },
      'identity-mismatch'
    ],
    [
      'prompt',
      (s: ReturnType<typeof setup>) => {
        s.plan.identity.promptMessageId = 'other'
      },
      'identity-mismatch'
    ],
    [
      'provenance',
      (s: ReturnType<typeof setup>) => {
        s.plan.prompt.provenanceContext = { promptMessageId: 'other' }
      },
      'identity-mismatch'
    ],
    [
      'interaction',
      (s: ReturnType<typeof setup>) => {
        s.plan.supportedInteractionPolicies = []
      },
      'unsupported-interaction-policy'
    ],
    [
      'configuration',
      (s: ReturnType<typeof setup>) => {
        s.plan.configuration = {
          status: 'unknown',
          requestedDigest: 'different',
          instructions: [],
          skills: [],
          tools: [],
          confirmation: 'unknown'
        }
      },
      'configuration-mismatch'
    ],
    [
      'interactive flag',
      (s: ReturnType<typeof setup>) => {
        s.plan.prompt.permissionPrompts = 'none'
      },
      'interaction-policy-mismatch'
    ]
  ] as const)('rejects incompatible %s before provider dispatch', async (_name, change, code) => {
    const s = setup()
    change(s)
    const h = await s.core.submit(request())
    expect((await finished(s.core, h.executionId)).error?.code).toBe(code)
    expect(s.runtime.sendPromptObserved).not.toHaveBeenCalled()
    expect(s.notifications.trackPrompt).not.toHaveBeenCalled()
  })

  it('retains explicit resolver rejection for unsupported Harness configuration', async () => {
    const s = setup()
    vi.mocked(s.resolver.resolve).mockResolvedValue({
      kind: 'rejected',
      error: { code: 'unsupported-configuration', message: 'No support for this Harness policy' }
    })
    const h = await s.core.submit(request())
    const result = await finished(s.core, h.executionId)
    expect(result.error?.code).toBe('unsupported-configuration')
    expect(result.cleanup).toBe('confirmed')
    expect(s.plan.readResult).not.toHaveBeenCalled()
    expect(s.runtime.sendPromptObserved).not.toHaveBeenCalled()
  })

  it('rejects plan-first when unresolved interactions must be denied', async () => {
    const s = setup()
    s.plan.prompt.turnIntent = 'plan-first'
    const input = request()
    input.interactionPolicy = 'deny-unresolved'
    const h = await s.core.submit(input)
    expect((await finished(s.core, h.executionId)).error?.code).toBe(
      'unsupported-interaction-policy'
    )
    expect(s.runtime.sendPromptObserved).not.toHaveBeenCalled()
  })

  it('does not cancel another desktop turn before its own Session admission', async () => {
    const s = setup()
    const gate = deferred()
    s.outcome.phase = 'cancelled'
    delete s.outcome.resourceCleanup
    s.runtime.sendPromptObserved.mockImplementation(async (_r, _accepted, admitted) => {
      await gate.promise
      await admitted?.()
    })
    const h = await s.core.submit(request())
    await vi.waitFor(() => expect(s.runtime.sendPromptObserved).toHaveBeenCalledOnce())
    expect((await s.core.cancel(h.executionId)).status).toBe('requested')
    expect(s.runtime.cancelPrompt).not.toHaveBeenCalled()
    gate.resolve()
    const result = await finished(s.core, h.executionId)
    expect(result.phase).toBe('cancelled')
    expect(result.cleanup).toBe('unknown')
    expect(s.plan.admit).not.toHaveBeenCalled()
    expect(s.plan.cancelOwnedPrompt).not.toHaveBeenCalled()
    expect(s.notifications.untrackPrompt).toHaveBeenCalledWith('session-original', { token: 1 })
  })

  it('requests owned cancellation once, waits for the result owner and fences unknown cleanup', async () => {
    const s = setup()
    const stopped = deferred()
    s.outcome.phase = 'cancelled'
    delete s.outcome.resourceCleanup
    s.runtime.sendPromptObserved.mockImplementation(async (_r, accepted, admitted) => {
      await admitted?.()
      accepted()
      await stopped.promise
    })
    const h = await s.core.submit(request())
    await vi.waitFor(async () => expect((await s.core.get(h.executionId)).phase).toBe('running'))
    await s.core.cancel(h.executionId)
    await s.core.cancel(h.executionId)
    await vi.waitFor(() => expect(s.runtime.cancelPrompt).toHaveBeenCalledOnce())
    expect(s.plan.cancelOwnedPrompt).toHaveBeenCalledOnce()
    expect((await s.core.get(h.executionId)).phase).toBe('running')
    stopped.resolve()
    const result = await finished(s.core, h.executionId)
    expect(result.phase).toBe('cancelled')
    expect(result.cleanup).toBe('unknown')
    await expect(s.core.submit(request('next'))).rejects.toMatchObject({
      code: 'cleanup-unconfirmed'
    })
  })

  it('lets the trusted ownership guard refuse cancellation after a turn was superseded', async () => {
    const s = setup()
    const stopped = deferred()
    delete s.outcome.resourceCleanup
    vi.mocked(s.plan.cancelOwnedPrompt).mockImplementation(async () => {
      /* Original token no longer owns this Session. */
    })
    s.runtime.sendPromptObserved.mockImplementation(async (_r, accepted, admitted) => {
      await admitted?.()
      accepted()
      await stopped.promise
    })
    const h = await s.core.submit(request())
    await vi.waitFor(async () => expect((await s.core.get(h.executionId)).phase).toBe('running'))
    await s.core.cancel(h.executionId)
    await vi.waitFor(() => expect(s.plan.cancelOwnedPrompt).toHaveBeenCalledOnce())
    expect(s.runtime.cancelPrompt).not.toHaveBeenCalled()
    stopped.resolve()
    expect((await finished(s.core, h.executionId)).phase).toBe('completed')
  })

  it('reports unavailable owner results as failure with unknown cleanup, without inventing evidence', async () => {
    const s = setup()
    vi.mocked(s.plan.readResult).mockRejectedValue(new Error('Owner commit cannot be read'))
    const h = await s.core.submit(request())
    const result = await finished(s.core, h.executionId)
    expect(result.phase).toBe('failed')
    expect(result.cleanup).toBe('unknown')
    expect(result.error).toEqual({
      code: 'owner-result-unavailable',
      message: 'Owner commit cannot be read'
    })
    expect(result.evidence.status).toBe('unavailable')
    expect(result.evidence.artifacts).toEqual([])
  })

  it('keeps the cancellation signal live for result/Review owners after the provider stopped', async () => {
    const s = setup()
    const commit = deferred()
    s.outcome.phase = 'cancelled'
    delete s.outcome.resourceCleanup
    vi.mocked(s.plan.readResult).mockImplementation(async () => {
      await commit.promise
      return s.outcome
    })
    const h = await s.core.submit(request())
    await vi.waitFor(() => expect(s.plan.readResult).toHaveBeenCalledOnce())
    const settlement = vi.mocked(s.plan.readResult).mock.calls[0][0]
    expect(settlement.signal.aborted).toBe(false)
    await s.core.cancel(h.executionId)
    expect(settlement.signal.aborted).toBe(true)
    expect(s.runtime.cancelPrompt).not.toHaveBeenCalled()
    commit.resolve()
    expect((await finished(s.core, h.executionId)).cleanup).toBe('unknown')
  })

  it('defers cancellation during an admission commit until this turn has acquired ownership', async () => {
    const s = setup()
    const admission = deferred()
    s.outcome.phase = 'cancelled'
    delete s.outcome.resourceCleanup
    vi.mocked(s.plan.admit).mockImplementation(async () => {
      await admission.promise
      return provenance
    })
    const h = await s.core.submit(request())
    await vi.waitFor(() => expect(s.plan.admit).toHaveBeenCalledOnce())
    await s.core.cancel(h.executionId)
    expect(s.runtime.cancelPrompt).not.toHaveBeenCalled()
    admission.resolve()
    expect((await finished(s.core, h.executionId)).phase).toBe('cancelled')
    expect(s.plan.cancelOwnedPrompt).toHaveBeenCalledOnce()
    expect(s.runtime.cancelPrompt).toHaveBeenCalledOnce()
    expect(s.plan.readResult).toHaveBeenCalledWith(
      expect.objectContaining({
        promptError: expect.any(Error),
        cancellationRequested: true
      })
    )
  })

  it('passes a rejected cancellation RPC to the owner and never upgrades it to cleanup confirmation', async () => {
    const s = setup()
    const stop = deferred()
    const error = new Error('Cancellation transport rejected')
    s.runtime.cancelPrompt.mockRejectedValue(error)
    s.outcome.phase = 'failed'
    s.outcome.error = { code: 'owner-failed', message: 'Original owner failed' }
    s.outcome.resourceCleanup = { confirmed: true, evidence: '  ' }
    s.runtime.sendPromptObserved.mockImplementation(async (_r, accepted, admitted) => {
      await admitted?.()
      accepted()
      await stop.promise
    })
    const h = await s.core.submit(request())
    await vi.waitFor(async () => expect((await s.core.get(h.executionId)).phase).toBe('running'))
    await expect(s.core.cancel(h.executionId)).rejects.toBe(error)
    expect((await s.core.get(h.executionId)).cancellationRequested).toBe(false)
    await vi.waitFor(() => expect(s.runtime.cancelPrompt).toHaveBeenCalledOnce())
    stop.resolve()
    const result = await finished(s.core, h.executionId)
    expect(result.error?.code).toBe('owner-failed')
    expect(result.cleanup).toBe('unknown')
    expect(s.plan.readResult).toHaveBeenCalledWith(
      expect.objectContaining({ cancellationError: error })
    )
  })

  it('rejects admission provenance that names another prompt before provider acceptance', async () => {
    const s = setup()
    vi.mocked(s.plan.admit).mockResolvedValue({ promptMessageId: 'other-prompt' })
    const h = await s.core.submit(request())
    const result = await finished(s.core, h.executionId)
    expect(result.error?.code).toBe('missing-admission')
    expect((await events(s.core, h.executionId)).map((event) => event.type)).not.toContain(
      'provider-accepted'
    )
    expect(s.plan.readResult).toHaveBeenCalledWith(
      expect.objectContaining({ promptError: expect.any(Error) })
    )
  })

  it('does not infer completion from a prompt Promise that never admitted its Session turn', async () => {
    const s = setup()
    s.runtime.sendPromptObserved.mockResolvedValue(undefined)
    const h = await s.core.submit(request())
    const result = await finished(s.core, h.executionId)
    expect(result.error?.code).toBe('missing-admission')
    expect(result.cleanup).toBe('unknown')
  })
})
