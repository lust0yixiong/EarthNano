import type {
  OptimizationCatalogIdentity,
  OptimizationSweepOptions,
  StartDesktopSweep
} from '../../shared/earthnano/optimization-sweep'
import type { OptimizationArtifactInput } from '../../shared/earthnano/optimization-input'
import type { OutputCheckSpec } from '../../shared/earthnano/research-outcome'
import type { CandidateSnapshotInput } from './candidate-snapshot'
import type { HarnessBindingV2Identity } from './harness-binding-v2'

/** A projection made by original task_stream, not an alternative ordering algorithm. */
export interface OptimizationSweepPlan {
  schemaVersion: 2
  catalog: OptimizationCatalogIdentity[]
  catalogDigest: string
  options: OptimizationSweepOptions
  domains: Array<{ domain: string; taskIds: string[] }>
  bindingIdentity: HarnessBindingV2Identity
  methodDigest: string
  digest: string
}
/** Host-only. Method transport receives task bodies but no source credentials, runtime
 * descriptors, criteria, expected values or independent-assessment evidence. */
export interface ResolvedSweepTask extends OptimizationCatalogIdentity {
  sourceSessionId: string
  sourcePromptMessageId?: string
  input: CandidateSnapshotInput
  inputArtifacts?: OptimizationArtifactInput[]
  criteria: string
  checks?: OutputCheckSpec[]
}
export interface ResolvedOptimizationSweep {
  plan: OptimizationSweepPlan
  tasks: ResolvedSweepTask[]
  /** Original explicit DTO, reauthorized and re-frozen on a user-requested resume. */
  request: StartDesktopSweep
}
