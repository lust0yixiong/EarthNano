import type { ExecutionRequest } from '../../shared/earthnano/execution-port'
import type { TaskAgentPort } from '../tasks/task-runner'
import {
  createAcpExecutionDriver,
  type PreparedAcpExecution
} from '../acp/earthnano-execution-driver'
import {
  prepareClaudeCandidate,
  type ClaudeCandidateBinding,
  type PreparedClaudeCandidate
} from '../acp/claude-candidate-preparation'
import type {
  CandidateSnapshotStore,
  MaterializedCandidate,
  ResolvedCandidateSnapshots
} from './candidate-snapshot'
import type { ExecutionContext, ExecutionDriver, ExecutionOutcome } from './execution-core'

export interface ClaudeCandidateOwner {
  agent: Pick<TaskAgentPort, 'prompt' | 'cancelPrompt' | 'withSessionAvailable'>
  plan: PreparedAcpExecution
  /** Original runtime/resource owner must confirm physical retirement, including failed startup. */
  shutdown(): Promise<{ reaped: boolean }>
}

export interface ClaudeCandidateDriverOptions {
  snapshots: CandidateSnapshotStore
  /** Resolve explicit provider credentials and the pinned executable; never use an active default. */
  binding(agent: ResolvedCandidateSnapshots['agent']): Promise<ClaudeCandidateBinding>
  /** Creates the existing Session/Artifact/Review ownership binding, not another result database.
   * Construction must be process-free. Spawn belongs to agent.prompt/admission, after this returns;
   * otherwise an openOwner rejection could lose the only handle capable of cleaning up resources. */
  openOwner(input: {
    prepared: PreparedClaudeCandidate
    materialized: MaterializedCandidate
    request: ExecutionRequest
    context: ExecutionContext
  }): Promise<ClaudeCandidateOwner>
}

/** Explicit internal composition. Desktop bootstrap is unchanged. Each accepted execution gets a
 * fresh snapshot projection and runtime; lifecycle/result handling stays in the round-two ACP driver.
 * Candidate files are retained for inspection. Deletion is never treated as process cleanup. */
export function createClaudeCandidateDriver(options: ClaudeCandidateDriverOptions): ExecutionDriver {
  return {
    async execute(request, context) {
      let owner: ClaudeCandidateOwner | undefined
      let prepared: PreparedClaudeCandidate | undefined
      let constructingOwner = false
      let outcome: ExecutionOutcome
      try {
        if (request.interactionPolicy !== 'deny-unresolved') {
          return {
            phase: 'failed',
            cleanup: 'confirmed',
            error: {
              code: 'unsupported-interaction-policy',
              message: 'Isolated Claude candidates require deny-unresolved interaction.'
            }
          }
        }
        context.signal.throwIfAborted()
        const resolved = await options.snapshots.resolve(request)
        const binding = await options.binding(structuredClone(resolved.agent))
        context.signal.throwIfAborted()
        const materialized = await options.snapshots.materialize({
          executionId: context.executionId,
          refs: request
        })
        prepared = await prepareClaudeCandidate({ resolved, materialized, binding })
        context.signal.throwIfAborted()
        constructingOwner = true
        owner = await options.openOwner({
          prepared,
          materialized,
          request: structuredClone(request),
          context
        })
        context.signal.throwIfAborted()
        const driver = createAcpExecutionDriver({
          agent: owner.agent,
          resolver: {
            resolve: async () => ({
              ...owner!.plan,
              configuration: prepared!.configuration
            })
          }
        })
        outcome = await driver.execute(request, context)
      } catch {
        // Provider binding/startup exceptions can contain credentials. Keep the persistent error
        // structural; do not serialize arbitrary error messages into a shared execution journal.
        outcome = {
          phase: context.signal.aborted ? 'cancelled' : 'failed',
          cleanup: constructingOwner ? 'unknown' : 'confirmed',
          error: {
            code: context.signal.aborted ? 'candidate-cancelled' : 'candidate-preparation-failed',
            message: context.signal.aborted
              ? 'Candidate execution was stopped.'
              : 'Candidate references, configuration or owner binding could not be prepared.'
          },
          ...(prepared ? { configuration: prepared.configuration } : {})
        }
      }
      if (owner) {
        try {
          const cleanup = await owner.shutdown()
          outcome.cleanup = cleanup.reaped === true ? 'confirmed' : 'unknown'
        } catch {
          outcome.cleanup = 'unknown'
        }
      }
      return outcome
    }
  }
}
