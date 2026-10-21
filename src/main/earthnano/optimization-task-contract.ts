import type { CandidateSnapshotInput } from './candidate-snapshot'
import type { OptimizationArtifactInput } from '../../shared/earthnano/optimization-input'
import type {
  OutputCheckSpec,
  OptimizationDomainSpec
} from '../../shared/earthnano/research-outcome'
import type { OptimizationMethodOptions } from '../../shared/earthnano/optimization-method'

export interface OptimizationTaskInput {
  /** Existing project identity in the original OpenScience repositories. */
  projectId: string
  sourceSessionId?: string
  sourcePromptMessageId?: string
  taskId: string
  input: CandidateSnapshotInput
  /** Host-verified immutable source provenance; never an authority to read files. */
  inputArtifacts?: OptimizationArtifactInput[]
  /** Fixed before optimization; never forwarded to proposer/composer. */
  semanticCriteria?: string
  checks?: OutputCheckSpec[]
  domain?: OptimizationDomainSpec
  method?: OptimizationMethodOptions
}
