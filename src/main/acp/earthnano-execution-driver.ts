import type { AgentTurnProvenanceContext } from '../../shared/acp'
import type {
  EffectiveConfiguration,
  ExecutionError,
  ExecutionIdentity,
  ExecutionRequest
} from '../../shared/earthnano/execution-port'
import {
  ExecutionCore,
  type ExecutionContext,
  type ExecutionDriver,
  type ExecutionOutcome,
  type ExecutionStore
} from '../earthnano/execution-core'
import { withPhysicalCancellation } from '../earthnano/execution-scope'
import type { TaskAgentPort, TaskAgentPromptRequest } from '../tasks/task-runner'

export interface AcpPromptSettlement {
  promptError: unknown
  /** Still live while an original result/Review owner is committing after the provider stopped. */
  signal: AbortSignal
  cancellationRequested: boolean
  cancellationError: unknown
}

export interface AcpExecutionOwnerResult extends Omit<ExecutionOutcome, 'cleanup'> {
  identity?: ExecutionIdentity
  /** Only a trusted resource owner may attest to retirement; a cancel RPC or signal is insufficient. */
  resourceCleanup?: { confirmed: boolean; evidence: string }
}

export interface PreparedAcpExecution {
  kind: 'prepared'
  projectId: string
  prompt: TaskAgentPromptRequest
  identity: ExecutionIdentity
  configuration?: EffectiveConfiguration
  supportedInteractionPolicies: readonly ExecutionRequest['interactionPolicy'][]
  /** Commits through the existing Session owner under the ACP prompt admission callback. */
  admit(): Promise<AgentTurnProvenanceContext | undefined>
  /** Atomically verifies the original prompt/token still owns cancellation before dispatching it.
   * Must not dispatch against another turn, even if this turn completed before this callback ran. */
  cancelOwnedPrompt(dispatch: () => Promise<void>): Promise<void>
  /** Waits for original Session/Artifact/Review result commits, including prompt rejection paths.
   * Reads pinned versions from those owners; prompt(): void and cwd are never result evidence. */
  readResult(settlement: AcpPromptSettlement): Promise<AcpExecutionOwnerResult>
}

export interface AcpExecutionResolver {
  /** Trusted, read-only resolution of every frozen reference and its digest. Reject unsupported
   * configuration/roles/isolation explicitly. Returns an already prepared, owner-bound Session;
   * snapshot compilation, Session creation and real-provider isolation are not supplied here. */
  resolve(
    request: ExecutionRequest,
    context: Pick<ExecutionContext, 'executionId' | 'signal'>
  ): Promise<PreparedAcpExecution | { kind: 'rejected'; error: ExecutionError }>
}

type ExecutionAgent = Pick<TaskAgentPort, 'prompt' | 'cancelPrompt' | 'withSessionAvailable'>
type DriverOptions = { agent: ExecutionAgent; resolver: AcpExecutionResolver }

const failure = (code: string, message: string): ExecutionOutcome => ({
  phase: 'failed',
  // Resolution is read-only and no prompt has been dispatched at these rejection points.
  cleanup: 'confirmed',
  error: { code, message }
})
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const createAcpExecutionDriver = ({ agent, resolver }: DriverOptions): ExecutionDriver => ({
  async execute(request, context) {
    let resolution: Awaited<ReturnType<AcpExecutionResolver['resolve']>>
    try {
      resolution = await resolver.resolve(structuredClone(request), {
        executionId: context.executionId,
        signal: context.signal
      })
    } catch (error) {
      return failure('resolution-failed', message(error))
    }
    if (resolution.kind === 'rejected')
      return failure(resolution.error.code, resolution.error.message)
    const plan = resolution
    const requestedConfiguration = plan.configuration
      ? structuredClone(plan.configuration)
      : undefined
    if (context.signal.aborted) return { phase: 'cancelled', cleanup: 'confirmed' }
    const prompt = structuredClone(plan.prompt)
    const identity = {
      ...structuredClone(plan.identity),
      sessionId: prompt.sessionId,
      promptMessageId: prompt.promptMessageId
    }
    if (
      plan.projectId !== request.projectId ||
      prompt.provenanceContext.promptMessageId !== prompt.promptMessageId ||
      (plan.identity.sessionId !== undefined && plan.identity.sessionId !== prompt.sessionId) ||
      (plan.identity.promptMessageId !== undefined &&
        plan.identity.promptMessageId !== prompt.promptMessageId)
    )
      return failure(
        'identity-mismatch',
        'Resolved turn does not match its Project/Session/prompt identity'
      )
    if (!plan.supportedInteractionPolicies.includes(request.interactionPolicy)) {
      return failure(
        'unsupported-interaction-policy',
        'Resolved backend cannot enforce the requested interaction policy'
      )
    }
    if (request.interactionPolicy === 'deny-unresolved') {
      if (prompt.turnIntent === 'plan-first')
        return failure('unsupported-interaction-policy', 'Plan-first requires a human approver')
      prompt.permissionPrompts = 'none'
    } else if (prompt.permissionPrompts === 'none') {
      return failure(
        'interaction-policy-mismatch',
        'Interactive execution resolved to a noninteractive prompt'
      )
    }
    if (
      requestedConfiguration &&
      requestedConfiguration.requestedDigest !== request.harnessRevisionRef.digest
    ) {
      return failure(
        'configuration-mismatch',
        'Configuration facts refer to a different Harness revision'
      )
    }
    context.identity(identity)
    let admitted = false
    let settled = false
    let providerAccepted = false
    let cancellation: Promise<void> | undefined
    let cancellationError: unknown
    const cancelOwned = (): Promise<void> => {
      // Before admission another desktop turn may own this Session. Never cancel it.
      if (!admitted || settled) return Promise.resolve()
      if (cancellation) return cancellation
      const pending = withPhysicalCancellation(() =>
        plan.cancelOwnedPrompt(() => agent.cancelPrompt(prompt.sessionId))
      )
      cancellation = pending
      void pending.catch((error: unknown) => {
        cancellationError = error
        if (cancellation === pending) cancellation = undefined
      })
      return pending
    }
    const cancel = (): void => {
      void cancelOwned().catch(() => undefined)
    }
    const releaseCancellation = context.onCancellation?.(cancelOwned)
    context.signal.addEventListener('abort', cancel, { once: true })
    let promptError: unknown
    try {
      await agent.withSessionAvailable(request.projectId, prompt.sessionId, async () => {
        context.signal.throwIfAborted()
      })
      await agent.prompt(prompt, {
        onPromptAdmitted: async () => {
          const provenance = await agent.withSessionAvailable(
            request.projectId,
            prompt.sessionId,
            async () => {
              context.signal.throwIfAborted()
              return plan.admit()
            }
          )
          if (provenance && provenance.promptMessageId !== prompt.promptMessageId) {
            throw new Error('Admission returned provenance for a different prompt')
          }
          admitted = true
          context.running()
          context.emit('session-admitted')
          if (context.signal.aborted) {
            cancel()
            context.signal.throwIfAborted()
          }
          return provenance
        },
        onProviderPromptAccepted: () => {
          if (!admitted || settled || providerAccepted) return
          providerAccepted = true
          context.emit('provider-accepted')
        }
      })
    } catch (error) {
      promptError = error
    } finally {
      settled = true
      context.signal.removeEventListener('abort', cancel)
    }
    await cancellation?.catch(() => undefined)
    try {
      const result = await plan.readResult({
        promptError,
        signal: context.signal,
        cancellationRequested: context.signal.aborted,
        cancellationError
      })
      if (result.identity) context.identity(result.identity)
      if (result.phase === 'completed' && !admitted) {
        return {
          phase: 'failed',
          cleanup: 'unknown',
          error: {
            code: 'missing-admission',
            message: 'Owner reported completion without Session admission'
          }
        }
      }
      const configuration = result.configuration ?? requestedConfiguration
      if (configuration && configuration.requestedDigest !== request.harnessRevisionRef.digest) {
        throw new Error('Result configuration facts refer to a different Harness revision')
      }
      return {
        phase: result.phase,
        ...(result.evidence ? { evidence: result.evidence } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(configuration ? { configuration: structuredClone(configuration) } : {}),
        cleanup:
          result.resourceCleanup?.confirmed && result.resourceCleanup.evidence.trim()
            ? 'confirmed'
            : 'unknown'
      }
    } catch (error) {
      return {
        phase: 'failed',
        cleanup: 'unknown',
        error:
          promptError !== undefined
            ? {
                code: admitted
                  ? 'prompt-failed-result-unavailable'
                  : 'prompt-rejected-before-admission',
                message: `${message(promptError)}\nOwner result unavailable: ${message(error)}`
              }
            : { code: 'owner-result-unavailable', message: message(error) }
      }
    } finally {
      releaseCancellation?.()
    }
  }
})

/** Explicit opt-in seam. Callers provide a durable store, admission budget and trusted bindings.
 * Existing desktop/Task bootstrap keeps its own admission and result-owner lifecycle unchanged. */
export const createAcpExecutionCore = (
  options: DriverOptions & { store: ExecutionStore; eventLimit?: number }
): ExecutionCore =>
  new ExecutionCore(options.store, createAcpExecutionDriver(options), options.eventLimit)
