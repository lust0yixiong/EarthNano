import type { PromptResponse } from '@agentclientprotocol/sdk'
import type { AcpRuntimeState } from '../../shared/acp'
import type { ExecutionIdentity, ExecutionRecord } from '../../shared/earthnano/execution-port'
import type {
  AcpExecutionBoundary,
  AcpExecutionDispatch,
  AcpExecutionObservation,
  TrustedDelegatedExecutionOwner
} from '../acp/execution-boundary-port'
import { ExecutionCore, type ExecutionContext } from './execution-core'
import {
  currentExecutionScope,
  findOwnedExecutionScope,
  isPhysicalCancellation,
  withExecutionScope
} from './execution-scope'
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
  host,
  delegatedOwner
}: {
  host: SessionExecutionHost
  delegatedOwner?: TrustedDelegatedExecutionOwner
}): AcpExecutionBoundary {
  const active = new Map<string, { core: ExecutionCore; executionId: string; owned: boolean }>()
  const owners = new Set<ExecutionCore>()

  return {
    async execute(input) {
      const inherited = delegatedOwner
        ? findOwnedExecutionScope(delegatedOwner)
        : currentExecutionScope()
      if (delegatedOwner && !inherited)
        throw new Error('Delegated dispatch has no active shared execution owner')
      if (inherited) {
        const record = await inherited.core.get(inherited.context.executionId)
        if (!['preparing', 'running'].includes(record.phase))
          throw new Error('Execution scope is no longer active')
        const identity = inherited.identity()
        if (delegatedOwner) {
          if (
            !delegatedOwner.ownsSession(input.request.sessionId) ||
            !delegatedOwner.ownsTurn(input.request.provenanceContext) ||
            input.request.provenanceContext?.agentFrameId !== delegatedOwner.frameId ||
            identity.sessionId !== input.request.sessionId
          )
            throw new Error('Delegated dispatch does not match its original private turn owner')
        } else if (
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
        const entry = {
          core: inherited.core,
          executionId: inherited.context.executionId,
          owned: false
        }
        active.set(input.request.sessionId, entry)
        try {
          const observer = delegatedOwner
            ? {
                admitted(value: ExecutionIdentity) {
                  if (
                    value.sessionId !== input.request.sessionId ||
                    value.promptMessageId !== input.request.provenanceContext?.promptMessageId
                  )
                    throw new Error('Delegated admission does not match its exact owned turn')
                  // Original delegation records per-turn identity; mission identity stays immutable.
                  inherited.context.running()
                  inherited.context.emit('session-admitted')
                },
                providerAccepted() {
                  inherited.context.emit('provider-accepted')
                }
              }
            : observation(inherited.context, input, {})
          return await withExecutionScope(inherited, () => input.dispatch(observer))
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
      const core = new ExecutionCore(prepared.store, {
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
      const entry = { core, executionId, owned: true }
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
        // An inherited driver's terminal depends on this runtime's physical shutdown. Its original
        // outer owner must join that Core after shutdown; waiting here would create a cycle.
        if (!entry.owned) continue
        try {
          if ((await entry.core.get(entry.executionId)).cleanup !== 'confirmed') return false
        } catch {
          return false
        }
      }
      return true
    }
  }
}
