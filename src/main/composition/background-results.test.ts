import { describe, expect, it, vi } from 'vitest'
import type {
  CandidateContinuationTarget,
  ResolveCandidateDelivery
} from '../earthnano/compute-candidate-ports'
import { ApplicationEventHub } from '../application-events'
import { composeBackgroundResults, routeCandidateContinuations } from './background-results'

const deferred = <T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Preserve exact inferred original callback mock signatures.
const target = () => ({
  sendContinuation: vi.fn<CandidateContinuationTarget['sendContinuation']>(() => ({
    admitted: Promise.resolve(),
    result: Promise.resolve({ stopReason: 'end_turn', continuationMessageId: 'message' })
  })),
  isContinuationSaved: vi.fn<CandidateContinuationTarget['isContinuationSaved']>(async () => true),
  canStartSessionTurn: vi.fn<CandidateContinuationTarget['canStartSessionTurn']>(() => true)
})
const request = {
  sessionId: 'private',
  text: 'original delivery text',
  deliveryIds: ['delivery-1', 'delivery-2'],
  continuationMessageId: 'message'
}

describe('original background result continuation routing', () => {
  it('preserves the ordinary callbacks and their synchronous shape when no resolver was installed', () => {
    const ordinary = target()
    expect(routeCandidateContinuations(ordinary)).toBe(ordinary)
    expect(routeCandidateContinuations(ordinary).canStartSessionTurn('ordinary')).toBe(true)
  })
  it.each(['ordinary', 'private'] as const)(
    'routes all three callbacks through the same %s resolver',
    async (kind) => {
      const ordinary = target(),
        candidate = target()
      const resolve: ResolveCandidateDelivery = vi.fn(async () =>
        kind === 'ordinary' ? { kind } : { kind, target: candidate }
      )
      const routed = routeCandidateContinuations(ordinary, resolve)
      expect(await routed.canStartSessionTurn(request.sessionId)).toBe(true)
      expect(await routed.isContinuationSaved(request)).toBe(true)
      const dispatch = routed.sendContinuation(request)
      await dispatch.admitted
      await expect(dispatch.result).resolves.toMatchObject({ continuationMessageId: 'message' })
      expect(resolve).toHaveBeenCalledTimes(3)
      for (const call of vi.mocked(resolve).mock.calls) expect(call).toEqual(['private'])
      const selected = kind === 'ordinary' ? ordinary : candidate
      const unused = kind === 'ordinary' ? candidate : ordinary
      expect(selected.sendContinuation).toHaveBeenCalledExactlyOnceWith(request)
      expect(selected.isContinuationSaved).toHaveBeenCalledExactlyOnceWith(request)
      expect(selected.canStartSessionTurn).toHaveBeenCalledExactlyOnceWith('private')
      expect(unused.sendContinuation).not.toHaveBeenCalled()
      expect(unused.isContinuationSaved).not.toHaveBeenCalled()
      expect(unused.canStartSessionTurn).not.toHaveBeenCalled()
    }
  )
  it('keeps original admission and result promises independent, including a result rejected after admission', async () => {
    const ordinary = target(),
      candidate = target(),
      admitted = deferred<void>(),
      result = deferred<{ stopReason: string; continuationMessageId: string }>()
    candidate.sendContinuation.mockReturnValue({
      admitted: admitted.promise,
      result: result.promise
    })
    const routed = routeCandidateContinuations(ordinary, async () => ({
      kind: 'private',
      target: candidate
    }))
    const dispatch = routed.sendContinuation(request)
    let accepted = false,
      completed = false
    void dispatch.admitted.then(() => {
      accepted = true
    })
    void dispatch.result.then(
      () => {
        completed = true
      },
      () => undefined
    )
    await vi.waitFor(() => expect(candidate.sendContinuation).toHaveBeenCalledOnce())
    expect(accepted).toBe(false)
    expect(completed).toBe(false)
    admitted.resolve()
    await dispatch.admitted
    expect(accepted).toBe(true)
    expect(completed).toBe(false)
    const error = new Error('Original private terminal commit failed')
    result.reject(error)
    await expect(dispatch.result).rejects.toBe(error)
  })
  it('retains known-private unavailable delivery pending without ordinary runtime or saved-message fallback', async () => {
    const ordinary = target()
    const resolve = vi.fn<ResolveCandidateDelivery>(async () => ({ kind: 'private-unavailable' }))
    const routed = routeCandidateContinuations(ordinary, resolve)
    expect(await routed.canStartSessionTurn('private')).toBe(false)
    expect(await routed.isContinuationSaved(request)).toBe(false)
    const dispatch = routed.sendContinuation(request)
    await expect(dispatch.admitted).rejects.toThrow('Private result delivery owner is unavailable')
    await expect(dispatch.result).rejects.toThrow('Private result delivery owner is unavailable')
    expect(ordinary.sendContinuation).not.toHaveBeenCalled()
    expect(ordinary.canStartSessionTurn).not.toHaveBeenCalled()
    expect(ordinary.isContinuationSaved).not.toHaveBeenCalled()
  })
  it('propagates resolver failures and never treats them as ordinary delivery', async () => {
    const ordinary = target(),
      failure = new Error('Original ownership lookup unavailable')
    const routed = routeCandidateContinuations(ordinary, async () => {
      throw failure
    })
    const dispatch = routed.sendContinuation(request)
    await expect(dispatch.admitted).rejects.toBe(failure)
    await expect(dispatch.result).rejects.toBe(failure)
    await expect(routed.canStartSessionTurn('private')).rejects.toBe(failure)
    await expect(routed.isContinuationSaved(request)).rejects.toBe(failure)
    expect(ordinary.sendContinuation).not.toHaveBeenCalled()
  })
})

it('installs one private resolver into the original composition owner callbacks without touching ordinary runtime state', async () => {
  let callbacks!: CandidateContinuationTarget
  const privateTarget = target()
  const ordinaryRead = vi.fn(() => {
    throw new Error('Ordinary services must not handle a private delivery')
  })
  const applicationEvents = new ApplicationEventHub()
  try {
    await composeBackgroundResults({
      applicationEvents,
      resolveSessionAgentTarget: async () => {
        throw new Error('Ordinary agent resolution must not run')
      },
      runtimeRef: { current: undefined },
      getSessionRepository: ordinaryRead,
      getSessionPersistenceCoordinator: ordinaryRead,
      getNotebookCommands: ordinaryRead,
      getJobRepository: ordinaryRead,
      getHostRepository: ordinaryRead,
      resolveCandidateDelivery: async () => ({ kind: 'private', target: privateTarget }),
      modules: {
        async add(dependencies) {
          // Capture the actual original owner options; no DB/Job owner is replaced or executed here.
          callbacks = dependencies as unknown as CandidateContinuationTarget
          return {} as never
        }
      }
    })
    expect(await callbacks.canStartSessionTurn('private')).toBe(true)
    expect(await callbacks.isContinuationSaved(request)).toBe(true)
    const dispatch = callbacks.sendContinuation(request)
    await dispatch.admitted
    await dispatch.result
    expect(privateTarget.sendContinuation).toHaveBeenCalledExactlyOnceWith(request)
    expect(ordinaryRead).not.toHaveBeenCalled()
  } finally {
    applicationEvents.dispose()
  }
})
