import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecutionRecord, ExecutionRequest, Ref } from '../../shared/earthnano/execution-port'
import type { NewCheck, ReviewWithChecks } from '../../shared/reviewer'

type ReviewAssessmentResult = { review: ReviewWithChecks; submittedChecks: NewCheck[] }
import { ExecutionCore, type ExecutionContext } from './execution-core'
import { currentExecutionScope } from './execution-scope'
import { FileExecutionStore } from './execution-store'
import { assertExecutionTimeout, MAX_TIMER_TIMEOUT_MS } from './execution-timeout'
import { semanticCanonical } from './semantic-evaluation'

const reference = (id: string, value: unknown): Ref => ({
  id,
  version: '1',
  digest: `sha256:${createHash('sha256').update(semanticCanonical(value)).digest('hex')}`
})

export interface ReviewerExecutionContext {
  readonly signal: AbortSignal
  /** Observation of the actual disposable provider session, never a fabricated durable Session. */
  providerSession(sessionId: string): void
  providerPrompt(): void
  /** Called by the original resource owner; errors and pending disposal never confirm cleanup. */
  resourcesDisposed(confirmed: boolean): void
}

export interface ReviewerExecutionOptions {
  artifactStorageRoot: string
  projectId: string
  sessionId: string
  turnMessageId: string
  parentExecutionId?: string
  reviewerTimeoutMs: number
  abortSignal?: AbortSignal
  /** Explicit, credential-free snapshots; only their hashes enter the private execution journal. */
  scope: unknown
  prompt: string
  recoveryPrompt: string
  systemPrompt: string
  mode: 'initial' | 'tracked'
  model: string
  cwd: string
}

/** The original assessment owns Review creation, MCP, submission, disposal and durable commit.
 * Core admission counts one assessment execution, including upstream's optional recovery turn;
 * it does not claim to count model requests, API calls, tokens or currency. */
export async function runReviewerExecution(
  options: ReviewerExecutionOptions,
  assess: (context: ReviewerExecutionContext) => Promise<ReviewAssessmentResult>
): Promise<ReviewAssessmentResult> {
  assertExecutionTimeout(options.reviewerTimeoutMs)
  const parent = currentExecutionScope()
  const invocation = randomUUID()
  const directory = join(options.artifactStorageRoot, 'earthnano', 'reviewer-executions')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const store = new FileExecutionStore(join(directory, `${invocation}.json`))
  const request: ExecutionRequest = {
    contractVersion: 1,
    projectId: options.projectId,
    requestKey: `reviewer-assessment:${invocation}`,
    role: 'reviewer',
    origin: {
      kind: parent?.request.origin.kind ?? 'interactive',
      sessionId: options.sessionId,
      promptMessageId: options.turnMessageId,
      ...(parent?.request.origin.optimizationId
        ? { optimizationId: parent.request.origin.optimizationId }
        : {}),
      ...(parent?.request.origin.stageId ? { stageId: parent.request.origin.stageId } : {}),
      ...(options.parentExecutionId || parent
        ? { parentExecutionId: options.parentExecutionId ?? parent!.context.executionId }
        : {})
    },
    taskSnapshotRef: reference(`reviewer-scope:${invocation}`, options.scope),
    invocationRef: reference(`reviewer-invocation:${invocation}`, {
      mode: options.mode,
      initialPrompt: options.prompt,
      recoveryPrompt: options.recoveryPrompt,
      maxProviderTurns: 2
    }),
    agentSpecRef: reference('reviewer-agent', { model: options.model, role: 'reviewer' }),
    harnessRevisionRef: reference('reviewer-harness', {
      systemPrompt: options.systemPrompt,
      tools: 'reviewer-only-mcp',
      maxProviderTurns: 2,
      reviewerTimeoutMs: options.reviewerTimeoutMs
    }),
    environmentSpecRef: reference(`reviewer-environment:${invocation}`, { cwd: options.cwd }),
    interactionPolicy: 'deny-unresolved',
    budgetRef: `reviewer-assessment:${invocation}`,
    // Preserve the existing per-drive timeout. This shared deadline bounds both declared drives
    // plus setup/disposal/commit, using the same timer limits as every other Core execution.
    timeoutMs: Math.min(MAX_TIMER_TIMEOUT_MS, options.reviewerTimeoutMs * 2 + 30_000)
  }
  let result: ReviewAssessmentResult | undefined
  let failure: unknown
  let failed = false
  let core: ExecutionCore | undefined
  try {
    core = new ExecutionCore(store, {
      execute: async (_request, context: ExecutionContext) => {
        const cancellation = new AbortController()
        const signal = options.abortSignal
          ? AbortSignal.any([context.signal, cancellation.signal, options.abortSignal])
          : AbortSignal.any([context.signal, cancellation.signal])
        let cleanupConfirmed = true
        // Acknowledges original drive's abort signal. Cleanup remains pending until its owner
        // reports the actual disposal facts; cancellation acknowledgment is not cleanup proof.
        const unregister = context.onCancellation?.(async () => cancellation.abort())
        const cancel = (): void => {
          void core!.cancel(context.executionId).catch(() => undefined)
        }
        options.abortSignal?.addEventListener('abort', cancel, { once: true })
        try {
          if (options.abortSignal?.aborted) cancel()
          context.running()
          result = await assess({
            signal,
            providerSession: (sessionId) => {
              cleanupConfirmed = false
              context.identity({ providerSessionId: sessionId })
              context.emit('session-admitted')
            },
            providerPrompt: () => {
              cleanupConfirmed = false
              context.emit('provider-accepted')
            },
            resourcesDisposed: (confirmed) => {
              cleanupConfirmed = confirmed
            }
          })
          const unsuccessful = result.review.lifecycle === 'error'
          const cancelled =
            signal.aborted &&
            result.review.errorMessage === 'reviewer session was aborted before stopping'
          return {
            phase: cancelled
              ? ('cancelled' as const)
              : unsuccessful
                ? ('failed' as const)
                : ('completed' as const),
            cleanup: cleanupConfirmed ? ('confirmed' as const) : ('unknown' as const),
            evidence: {
              status: 'complete' as const,
              scope: 'original-review-assessment',
              text: `Review ${result.review.id}: ${result.review.lifecycle}`,
              artifacts: [],
              references: [reference(`review:${result.review.id}`, result)],
              limitations: ['Assessment budget counts executions, not provider requests or tokens.']
            },
            ...(unsuccessful
              ? {
                  error: {
                    code: 'review-failed',
                    message: result.review.errorMessage ?? 'Review assessment failed'
                  }
                }
              : {})
          }
        } catch (error) {
          failed = true
          failure = error
          return {
            phase: 'failed' as const,
            cleanup: cleanupConfirmed ? ('confirmed' as const) : ('unknown' as const),
            error: {
              code: 'review-owner-failed',
              message: error instanceof Error ? error.message : String(error)
            }
          }
        } finally {
          options.abortSignal?.removeEventListener('abort', cancel)
          unregister?.()
        }
      }
    })
    core.configureBudget(options.projectId, request.budgetRef, 1)
    const handle = await core.submit(request)
    await new Promise<void>((resolve) => setImmediate(resolve))
    // A Core persistence failure can retire the driver before assess is entered.
    // Waiting for the registered drive also observes that failure without fabricating a result.
    while (!(await core.settle(Math.min(request.timeoutMs, 25_000)))) {
      // Keep original owner authority: timeout has fenced the journal, but cannot attest that a
      // still-pending MCP/runtime disposal or Review commit has finished.
    }
    const record: ExecutionRecord = await core.get(handle.executionId)
    if (failed) throw failure
    if (!result) throw new Error(record.error?.message ?? 'Reviewer result owner did not complete')
    return result
  } finally {
    core?.dispose()
    store.close()
  }
}
