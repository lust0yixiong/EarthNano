import type { PromptResponse } from '@agentclientprotocol/sdk'
import type { AcpRuntimeState } from '../../shared/acp'
import type { ExecutionIdentity, ExecutionRecord } from '../../shared/earthnano/execution-port'
import type {
  AcpExecutionBoundary,
  AcpExecutionDispatch,
  AcpExecutionObservation
} from '../acp/execution-boundary-port'
import { ExecutionCore, type ExecutionContext } from './execution-core'
import { currentExecutionScope, isPhysicalCancellation } from './execution-scope'
import type { SessionExecutionHost } from './session-execution-host-port'

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
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

const observation = (
  context: ExecutionContext,
  input: AcpExecutionDispatch,
  observed: ExecutionIdentity
): AcpExecutionObservation => ({
  admitted(identity) {
    if (
      identity.sessionId !== input.request.sessionId ||
      (input.request.provenanceContext?.promptMessageId !== undefined &&
        identity.promptMessageId !== input.request.provenanceContext.promptMessageId)
    )
      throw new Error('Original Session admission does not match dispatched turn')
    context.identity(identity)
    Object.assign(observed, identity)
    context.running()
    context.emit('session-admitted')
  },
  providerAccepted() {
    context.emit('provider-accepted')
  }
})

/** The sole ACP model-dispatch authority. Hosts describe original facts and resources only. */
export function createAcpExecutionBoundary({
  host
}: {
  host: SessionExecutionHost
}): AcpExecutionBoundary {
  const active = new Map<string, { core: ExecutionCore; executionId: string }>()
  const owners = new Set<ExecutionCore>()

  return {
    async execute(input) {
      const inherited = currentExecutionScope()
      if (inherited) {
        const identity = inherited.identity()
        if (
          identity.sessionId !== input.request.sessionId ||
          (identity.promptMessageId !== undefined &&
            input.request.provenanceContext?.promptMessageId !== identity.promptMessageId)
        )
          throw new Error('Execution scope cannot dispatch another Session or turn')
        if (
          inherited.request.interactionPolicy === 'deny-unresolved' &&
          input.request.permissionPrompts !== 'none'
        )
          throw new Error('Execution scope cannot escalate its interaction policy')
        if (inherited.context.signal.aborted) inherited.context.signal.throwIfAborted()
        const entry = { core: inherited.core, executionId: inherited.context.executionId }
        active.set(input.request.sessionId, entry)
        try {
          return await input.dispatch(observation(inherited.context, input, {}))
        } finally {
          void inherited.core
            .waitForTerminal(entry.executionId)
            .then((record) => {
              if (record.cleanup === 'confirmed' && active.get(input.request.sessionId) === entry)
                active.delete(input.request.sessionId)
            })
            .catch(() => undefined)
        }
      }

      if (active.has(input.request.sessionId))
        throw new Error(
          'Session execution remains owned pending original result and resource settlement'
        )

      const prepared = await host.prepare(input)
      const native = deferred<PromptResponse>()
      let nativeFinished = false
      let core!: ExecutionCore
      core = new ExecutionCore(prepared.store, {
        async execute(_request, context) {
          const identity: ExecutionIdentity = {}
          let response: PromptResponse | undefined
          let error: unknown
          const releaseCancellation = context.onCancellation?.(input.cancelOwned)
          try {
            context.signal.throwIfAborted()
            try {
              response = await input.dispatch(observation(context, input, identity))
              native.resolve(response)
            } catch (failure) {
              error = failure
              native.reject(failure)
            } finally {
              nativeFinished = true
            }
            try {
              await input.ownerCompletion?.committed
            } catch (failure) {
              error ??= failure
            }
            const outcome = await prepared.readResult({ response, error, context, identity })
            // Durable owner failures outrank a superficially successful native response.
            if (error !== undefined && outcome.phase === 'completed')
              return {
                ...outcome,
                phase: 'failed' as const,
                error: {
                  code: 'original-owner-failed',
                  message: error instanceof Error ? error.message : String(error)
                }
              }
            return outcome
          } finally {
            releaseCancellation?.()
          }
        }
      })
      owners.add(core)
      let executionId: string
      try {
        core.configureBudget(
          prepared.request.projectId,
          prepared.request.budgetRef,
          prepared.budgetLimit
        )
        executionId = (await core.submit(prepared.request)).executionId
      } catch (error) {
        owners.delete(core)
        core.dispose()
        prepared.close()
        throw error
      }
      const entry = { core, executionId }
      active.set(input.request.sessionId, entry)
      const terminal = core.waitForTerminal(executionId)
      const settled: Promise<ExecutionRecord> = terminal.then(async (record) => {
        if (!nativeFinished)
          native.reject(
            new Error(record.error?.message ?? `Execution ${record.phase} before dispatch settled`)
          )
        // Timeout may leave original owners committing. Never release their resource fence early.
        if (await core.settle()) {
          if (record.cleanup === 'confirmed') {
            if (active.get(input.request.sessionId) === entry)
              active.delete(input.request.sessionId)
            owners.delete(core)
            core.dispose()
            prepared.close()
          }
        }
        return record
      })
      void settled.catch((error) => native.reject(error))
      input.ownerCompletion?.linked?.({ executionId, settled })
      return native.promise
    },
    async cancel(sessionId, cancelOriginal, readState: () => AcpRuntimeState) {
      if (isPhysicalCancellation()) return cancelOriginal()
      const entry = active.get(sessionId)
      if (!entry) return cancelOriginal()
      await entry.core.cancel(entry.executionId)
      return readState()
    },
    async settle() {
      const results = await Promise.all([...owners].map((owner) => owner.settle()))
      if (!results.every(Boolean)) return false
      for (const entry of active.values()) {
        if ((await entry.core.get(entry.executionId)).cleanup !== 'confirmed') return false
      }
      return true
    }
  }
}
