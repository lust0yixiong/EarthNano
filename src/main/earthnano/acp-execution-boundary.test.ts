import { describe, expect, it, vi } from 'vitest'
import type { PromptResponse } from '@agentclientprotocol/sdk'
import fixtures from '../../../contracts/execution/fixtures.json'
import type { AcpRuntimeState } from '../../shared/acp'
import type { ExecutionRequest } from '../../shared/earthnano/execution-port'
import type { AcpExecutionDispatch, AcpExecutionLink } from '../acp/execution-boundary-port'
import { createAcpExecutionBoundary } from './acp-execution-boundary'
import {
  emptyExecutionState,
  ExecutionCore,
  type ExecutionContext,
  type ExecutionState,
  type ExecutionStore
} from './execution-core'
import { currentExecutionScope } from './execution-scope'
import type { SessionExecutionHost } from './session-execution-host-port'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const request = (): ExecutionRequest => ({
  ...(structuredClone(fixtures.valid) as ExecutionRequest),
  timeoutMs: 0
})
const store = (): ExecutionStore => {
  let state = emptyExecutionState()
  return {
    load: () => structuredClone(state),
    commit: (next: ExecutionState) => {
      state = structuredClone(next)
    }
  }
}
const response: PromptResponse = { stopReason: 'end_turn' }
type ResultReader = Awaited<ReturnType<SessionExecutionHost['prepare']>>['readResult']
interface Setup {
  boundary: ReturnType<typeof createAcpExecutionBoundary>
  input: AcpExecutionDispatch
  prepare: ReturnType<typeof vi.fn<SessionExecutionHost['prepare']>>
  readResult: ReturnType<typeof vi.fn<ResultReader>>
  close: ReturnType<typeof vi.fn<() => void>>
  journal: ExecutionStore
  committed: Deferred<void>
  link(): AcpExecutionLink
}
function setup(): Setup {
  const journal = store()
  const close = vi.fn<() => void>()
  const readResult = vi.fn<Awaited<ReturnType<SessionExecutionHost['prepare']>>['readResult']>(
    async () => ({ phase: 'completed', cleanup: 'confirmed' })
  )
  const prepare = vi.fn<SessionExecutionHost['prepare']>(async () => ({
    request: request(),
    budgetLimit: 1,
    store: journal,
    readResult,
    close
  }))
  const boundary = createAcpExecutionBoundary({ host: { prepare } })
  let link!: AcpExecutionLink
  const committed = deferred<void>()
  const input: AcpExecutionDispatch = {
    attemptId: 'attempt-1',
    operation: 'sendPrompt',
    runtimeReviewOwner: 'renderer',
    request: {
      sessionId: 'session',
      text: 'prompt',
      provenanceContext: { promptMessageId: 'prompt' }
    },
    ownerCompletion: {
      committed: committed.promise,
      linked: (value) => {
        link = value
      }
    },
    dispatch: vi.fn(async (observer) => {
      observer.admitted({ sessionId: 'session', promptMessageId: 'prompt' })
      observer.providerAccepted()
      return response
    }),
    cancelOwned: vi.fn(async () => undefined)
  }
  return { boundary, input, prepare, readResult, close, journal, committed, link: () => link }
}

describe('one ACP execution authority', () => {
  it('allows an original correction or next Send after native release while retaining the prior commit barrier and exact cancel target', async () => {
    const s = setup()
    s.prepare.mockImplementation(async (input) => ({
      request: { ...request(), requestKey: input.attemptId, budgetRef: input.attemptId },
      budgetLimit: 1,
      store: store(),
      readResult: s.readResult,
      close: s.close
    }))
    await s.boundary.execute(s.input)
    const first = s.link()
    const secondNative = deferred<PromptResponse>()
    const secondCommitted = deferred<void>()
    let second!: AcpExecutionLink
    const secondCancel = vi.fn(async () => undefined)
    const next = s.boundary.execute({
      ...s.input,
      attemptId: 'correction-attempt',
      operation: 'sendApplicationPrompt',
      request: { ...s.input.request, provenanceContext: { promptMessageId: 'correction' } },
      ownerCompletion: {
        committed: secondCommitted.promise,
        linked: (link) => {
          second = link
        }
      },
      dispatch: async (observer) => {
        observer.admitted({ sessionId: 'session', promptMessageId: 'correction' })
        return secondNative.promise
      },
      cancelOwned: secondCancel
    })
    await vi.waitFor(() => expect(second).toBeDefined())
    expect(second.executionId).not.toBe(first.executionId)
    await first.cancel!()
    expect(s.input.cancelOwned).toHaveBeenCalledOnce()
    expect(secondCancel).not.toHaveBeenCalled()
    s.committed.resolve()
    secondNative.resolve(response)
    secondCommitted.resolve()
    await next
    await Promise.all([first.settled, second.settled])
  })

  it('retains a late uncertain prior resource fence after a newer turn has settled', async () => {
    const s = setup()
    s.prepare.mockImplementation(async (input) => ({
      request: { ...request(), requestKey: input.attemptId, budgetRef: input.attemptId },
      budgetLimit: 1,
      store: store(),
      readResult: s.readResult,
      close: s.close
    }))
    s.readResult.mockImplementation(async ({ identity }) => ({
      phase: identity.promptMessageId === 'prompt' ? 'failed' : 'completed',
      cleanup: identity.promptMessageId === 'prompt' ? 'unknown' : 'confirmed'
    }))
    await s.boundary.execute(s.input)
    const first = s.link()
    const nextCommitted = deferred<void>()
    let second!: AcpExecutionLink
    await s.boundary.execute({
      ...s.input,
      attemptId: 'next',
      request: { ...s.input.request, provenanceContext: { promptMessageId: 'next' } },
      ownerCompletion: {
        committed: nextCommitted.promise,
        linked: (link) => {
          second = link
        }
      },
      dispatch: async (observer) => {
        observer.admitted({ sessionId: 'session', promptMessageId: 'next' })
        return response
      }
    })
    s.committed.resolve()
    nextCommitted.resolve()
    expect((await first.settled).cleanup).toBe('unknown')
    await second.settled
    await expect(s.boundary.execute({ ...s.input, attemptId: 'third' })).rejects.toThrow(
      'remains owned'
    )
  })

  it('returns native results before owner commit, withholds canonical terminal and reads original evidence after commit', async () => {
    const s = setup()
    expect(await s.boundary.execute(s.input)).toEqual(response)
    expect(s.readResult).not.toHaveBeenCalled()
    expect(Object.values(s.journal.load().records)[0].phase).toBe('running')
    let settled = false
    void s.link().settled.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    s.committed.resolve()
    expect((await s.link().settled).phase).toBe('completed')
    expect(s.readResult).toHaveBeenCalledWith(
      expect.objectContaining({ identity: { sessionId: 'session', promptMessageId: 'prompt' } })
    )
    expect(s.close).toHaveBeenCalledOnce()
    expect(Object.values(s.journal.load().budgets)[0].admitted).toBe(1)
  })

  it('keeps rich ACP request and transient media intact at dispatch without changing the input', async () => {
    const s = setup()
    s.input.request = {
      ...s.input.request,
      memoryEnabled: false,
      turnIntent: 'plan-first',
      currentImages: [{ byteLength: 6, data: 'transient', mimeType: 'image/png' }],
      forcedSkillIds: ['skill'],
      historyPreamble: 'history',
      contextReset: true
    }
    const original = structuredClone(s.input.request)
    s.input.dispatch = vi.fn(async (observer) => {
      expect(s.input.request).toEqual(original)
      observer.admitted({ sessionId: 'session', promptMessageId: 'prompt' })
      return response
    })
    s.committed.resolve()
    await s.boundary.execute(s.input)
    await s.link().settled
    expect(s.prepare).toHaveBeenCalledWith(s.input)
    expect(s.input.request).toEqual(original)
  })

  it('preserves original owner failure after native success and never publishes a conflicting completion', async () => {
    const s = setup()
    await s.boundary.execute(s.input)
    s.committed.reject(new Error('Artifact commit failed'))
    expect(await s.link().settled).toMatchObject({
      phase: 'failed',
      error: { code: 'original-owner-failed', message: 'Artifact commit failed' }
    })
    expect(s.readResult).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }))
  })

  it('propagates cancellation rejection without aborting or claiming cancellation', async () => {
    const s = setup()
    const stop = deferred<PromptResponse>()
    let context!: ExecutionContext
    s.input.dispatch = async (observer) => {
      context = currentExecutionScope()!.context
      observer.admitted({ sessionId: 'session', promptMessageId: 'prompt' })
      return stop.promise
    }
    s.input.cancelOwned = async () => {
      throw new Error('owner rejected')
    }
    const native = s.boundary.execute(s.input)
    await vi.waitFor(() => expect(context).toBeDefined())
    await expect(
      s.boundary.cancel(
        'session',
        async () => ({}) as AcpRuntimeState,
        () => ({}) as AcpRuntimeState
      )
    ).rejects.toThrow('owner rejected')
    expect(context.signal.aborted).toBe(false)
    expect(Object.values(s.journal.load().records)[0].cancellationRequested).toBe(false)
    stop.resolve(response)
    s.committed.resolve()
    await native
    expect((await s.link().settled).phase).toBe('completed')
  })

  it('routes accepted cancel through the exact owner once, without recursive Core admission or cancellation', async () => {
    const s = setup()
    const stop = deferred<PromptResponse>()
    const physical = vi.fn(async () => ({}) as AcpRuntimeState)
    s.input.dispatch = async (observer) => {
      observer.admitted({ sessionId: 'session', promptMessageId: 'prompt' })
      return stop.promise
    }
    s.input.cancelOwned = async () => {
      await s.boundary.cancel('session', physical, () => ({}) as AcpRuntimeState)
    }
    const native = s.boundary.execute(s.input)
    await vi.waitFor(() => expect(s.link()).toBeDefined())
    await vi.waitFor(() => expect(Object.values(s.journal.load().records)[0].phase).toBe('running'))
    await s.boundary.cancel('session', physical, () => ({}) as AcpRuntimeState)
    expect(physical).toHaveBeenCalledOnce()
    stop.resolve({ stopReason: 'cancelled' })
    s.readResult.mockResolvedValue({ phase: 'cancelled', cleanup: 'confirmed' })
    s.committed.resolve()
    await native
    expect((await s.link().settled).phase).toBe('cancelled')
  })

  it('fences same Session after unconfirmed resource cleanup while allowing unrelated Sessions', async () => {
    const s = setup()
    s.readResult.mockResolvedValue({ phase: 'failed', cleanup: 'unknown' })
    s.committed.resolve()
    await s.boundary.execute(s.input)
    await s.link().settled
    await expect(s.boundary.execute({ ...s.input, attemptId: 'attempt-2' })).rejects.toThrow(
      'remains owned'
    )
    expect(await s.boundary.settle()).toBe(false)
    expect(s.prepare).toHaveBeenCalledOnce()
  })

  it('reuses the outer Harness identity and budget and rejects cross-Session or policy escalation', async () => {
    const s = setup()
    const outerStore = store()
    const core = new ExecutionCore(outerStore, {
      async execute(_request, context) {
        context.identity({ sessionId: 'session', promptMessageId: 'prompt' })
        const q = {
          ...s.input,
          ownerCompletion: undefined,
          request: { ...s.input.request, permissionPrompts: 'none' as const }
        }
        expect(await s.boundary.execute(q)).toEqual(response)
        // Private runtime shutdown happens before its outer driver can commit terminal cleanup.
        expect(await s.boundary.settle()).toBe(true)
        await expect(
          s.boundary.execute({ ...q, request: { ...q.request, sessionId: 'other' } })
        ).rejects.toThrow('another Session')
        await expect(
          s.boundary.execute({ ...q, request: { ...q.request, permissionPrompts: undefined } })
        ).rejects.toThrow('escalate')
        return { phase: 'completed', cleanup: 'confirmed' }
      }
    })
    core.configureBudget('demo', 'trial', 1)
    const handle = await core.submit({ ...request(), interactionPolicy: 'deny-unresolved' })
    const record = await core.waitForTerminal(handle.executionId)
    await core.settle()
    expect(record.phase).toBe('completed')
    expect(s.prepare).not.toHaveBeenCalled()
    expect(Object.values(outerStore.load().budgets)[0].admitted).toBe(1)
    expect(
      Object.values(outerStore.load().events)[0].filter(
        (event) => event.type === 'session-admitted'
      )
    ).toHaveLength(1)
    core.dispose()
  })
})

it('does not retire a runtime after any observed admission, even when dispatch later rejects', async () => {
  const s = setup()
  const retireUnadmitted = vi.fn(async () => ({
    attemptId: 'attempt-1',
    sessionId: 'session',
    reaped: true as const
  }))
  s.committed.resolve()
  await expect(
    s.boundary.execute({
      ...s.input,
      retireUnadmitted,
      dispatch: async (observer) => {
        observer.admitted({ sessionId: 'session', promptMessageId: 'prompt' })
        throw new Error('failed after admission')
      }
    })
  ).rejects.toThrow('failed after admission')
  await s.link().settled
  expect(retireUnadmitted).not.toHaveBeenCalled()
})

async function applicationExecution(
  work: (fixture: {
    boundary: ReturnType<typeof createAcpExecutionBoundary>
    input: (message?: string) => AcpExecutionDispatch
    owner: import('../acp/execution-boundary-port').TrustedApplicationExecutionOwner
    host: SessionExecutionHost
  }) => Promise<void>
): Promise<{
  record: import('../../shared/earthnano/execution-port').ExecutionRecord
  journal: ExecutionStore
}> {
  const s = setup(),
    journal = store()
  let executionId: string | undefined
  const owner: import('../acp/execution-boundary-port').TrustedApplicationExecutionOwner = {
    projectId: 'demo',
    sourceSessionId: 'source',
    ownsExecution: (id) => id === executionId,
    ownsSession: (id) => id === 'session',
    ownsTurn: (provenance) =>
      ['continuation-1', 'continuation-2'].includes(provenance?.promptMessageId ?? ''),
    ownsApplicationDispatch: (input) =>
      input.attribution?.feature === 'background-results' &&
      input.attribution.deliveryIds.length === 1 &&
      input.attribution.deliveryIds[0] ===
        `owned-${input.request.provenanceContext?.promptMessageId}`
  }
  const host = { prepare: s.prepare }
  const boundary = createAcpExecutionBoundary({ host, applicationOwner: owner })
  const input = (message = 'continuation-1'): AcpExecutionDispatch => ({
    ...s.input,
    ownerCompletion: undefined,
    operation: 'sendApplicationPrompt',
    attribution: {
      kind: 'application',
      feature: 'background-results',
      purpose: 'agent-result-delivery',
      deliveryKey: `agent-result-delivery:${message}`,
      deliveryIds: [`owned-${message}`]
    },
    request: {
      sessionId: 'session',
      text: 'original background result',
      permissionPrompts: 'none',
      provenanceContext: { promptMessageId: message }
    },
    dispatch: vi.fn(async (observer) => {
      observer.admitted({
        sessionId: 'session',
        promptMessageId: message,
        turnToken: `native-${message}`
      })
      observer.providerAccepted()
      return response
    })
  })
  const core = new ExecutionCore(journal, {
    async execute(_request, context) {
      executionId = context.executionId
      context.identity({
        sessionId: 'session',
        promptMessageId: 'prompt',
        turnToken: 'initial-token'
      })
      context.running()
      await work({ boundary, input, owner, host })
      return { phase: 'completed', cleanup: 'confirmed' }
    }
  })
  core.configureBudget('demo', 'trial', 1)
  try {
    const handle = await core.submit({
      ...request(),
      origin: { kind: 'interactive', sessionId: 'source' },
      interactionPolicy: 'deny-unresolved'
    })
    const record = await core.waitForTerminal(handle.executionId)
    await core.settle()
    expect(record.phase, record.error?.message).toBe('completed')
    expect(s.prepare).not.toHaveBeenCalled()
    return { record, journal }
  } finally {
    core.dispose()
  }
}

it('admits exact original application result Turns into one Core without rewriting initial identity or budget', async () => {
  const { AsyncResource } = await import('node:async_hooks')
  const outside = new AsyncResource('original-delivery-owner')
  try {
    const { record, journal } = await applicationExecution(async ({ boundary, input }) => {
      for (const message of ['continuation-1', 'continuation-2']) {
        await outside.runInAsyncScope(async () => {
          expect(currentExecutionScope()).toBeUndefined()
          expect(await boundary.execute(input(message))).toEqual(response)
        })
      }
      expect(await boundary.settle()).toBe(true)
    })
    expect(record.identity).toEqual({
      sessionId: 'session',
      promptMessageId: 'prompt',
      turnToken: 'initial-token'
    })
    expect(Object.values(journal.load().records)).toHaveLength(1)
    expect(Object.values(journal.load().budgets)[0].admitted).toBe(1)
  } finally {
    outside.emitDestroy()
  }
})
it.each([
  'operation',
  'attribution',
  'delivery-key',
  'delivery-ids',
  'model-trusted-field',
  'session',
  'turn',
  'policy',
  'owner',
  'admission',
  'missing-admission',
  'acceptance-before-admission'
])('rejects an application continuation that fails exact original ownership: %s', async (fault) => {
  await applicationExecution(async ({ boundary, input, owner, host }) => {
    const dispatch = input()
    let selected = boundary
    if (fault === 'operation') dispatch.operation = 'sendPrompt'
    else if (fault === 'attribution')
      dispatch.attribution = {
        kind: 'application',
        feature: 'reviewer',
        purpose: 'correction',
        causeReviewId: 'foreign'
      }
    else if (fault === 'delivery-key')
      dispatch.attribution = {
        ...input().attribution!,
        deliveryKey: 'foreign'
      } as AcpExecutionDispatch['attribution']
    else if (fault === 'delivery-ids')
      dispatch.attribution = {
        kind: 'application',
        feature: 'background-results',
        purpose: 'agent-result-delivery',
        deliveryKey: 'agent-result-delivery:continuation-1',
        deliveryIds: ['foreign-job']
      }
    else if (fault === 'model-trusted-field')
      dispatch.attribution = Object.assign(input().attribution!, { trusted: true })
    else if (fault === 'session') dispatch.request = { ...dispatch.request, sessionId: 'foreign' }
    else if (fault === 'turn')
      dispatch.request = { ...dispatch.request, provenanceContext: { promptMessageId: 'foreign' } }
    else if (fault === 'policy')
      dispatch.request = { ...dispatch.request, permissionPrompts: undefined }
    else if (fault === 'owner')
      selected = createAcpExecutionBoundary({
        host,
        applicationOwner: { ...owner, ownsApplicationDispatch: () => false }
      })
    else if (fault === 'admission')
      dispatch.dispatch = async (observer) => {
        observer.admitted({ sessionId: 'session', promptMessageId: 'foreign' })
        return response
      }
    else if (fault === 'acceptance-before-admission')
      dispatch.dispatch = async (observer) => {
        observer.providerAccepted()
        return response
      }
    else dispatch.dispatch = async () => response
    await expect(selected.execute(dispatch)).rejects.toThrow()
  })
})
it.each(['project', 'source-session', 'execution'])(
  'rejects a trusted application owner without the exact live %s scope',
  async (fault) => {
    await applicationExecution(async ({ owner, host, input }) => {
      const boundary = createAcpExecutionBoundary({
        host,
        applicationOwner: {
          ...owner,
          ...(fault === 'project'
            ? { projectId: 'foreign' }
            : fault === 'source-session'
              ? { sourceSessionId: 'foreign' }
              : { ownsExecution: () => false })
        }
      })
      await expect(boundary.execute(input())).rejects.toThrow('no active shared execution owner')
    })
  }
)
it('retains the ordinary second-Turn gate even with a valid background attribution', async () => {
  await applicationExecution(async ({ input, host }) => {
    await expect(createAcpExecutionBoundary({ host }).execute(input())).rejects.toThrow(
      'another Session or turn'
    )
  })
})
