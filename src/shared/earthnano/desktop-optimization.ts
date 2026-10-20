import type { NotebookOptimizationSource } from './notebook-source'
import type { FrozenNotebookInput, FrozenNotebookRuntime } from './notebook-profile'
import type { OptimizationMethodOptions } from './optimization-method'
import type { OptimizationArtifactInput } from './optimization-input'
import type { ExecutionUsageSummary } from './execution-usage'
import type {
  OutputCheckSpec,
  OptimizationDomainSpec,
  ResearchOutcome,
  DomainOptimizationSummary
} from './research-outcome'

/** Desktop requests contain text task inputs, never provider credentials or host paths. */
export interface StartDesktopOptimization {
  projectId: string
  sourceSessionId: string
  requestKey: string
  prompt: string
  files: Array<{ path: string; content: string }>
  /** Same fixed source versions are shared by explicit domain tasks. Main resolves the bytes. */
  inputArtifacts?: OptimizationArtifactInput[]
  /** Re-execute the original fixed-input scientific task with its original Notebook runtime. */
  notebook?: NotebookOptimizationSource
  criteria: string
  /** Shared admission budget including both independent assessments. */
  executionLimit: number
  /** Omission retains the original sequential k=1 behavior. */
  method?: OptimizationMethodOptions
  checks?: OutputCheckSpec[]
  domain?: OptimizationDomainSpec
}
export interface OptimizationRunKey {
  projectId: string
  sourceSessionId: string
  runId: string
}
export interface SemanticAssessmentSummary {
  executionId: string
  targetExecutionId: string
  reviewId: string
  outcome: 'pass' | 'flagged'
  score: number
  rationale: string
}
export interface OptimizationSelectionSummary {
  chosenLabel: string
  candidateCount: number
  trivial: boolean
  fallback: boolean
  reason: string
}
export interface OptimizationProgress {
  runId: string
  projectId: string
  sourceSessionId: string
  state:
    | 'queued'
    | 'running'
    | 'assessing'
    | 'stopping'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
  stage: string
  /** Optional only for records created before method options were introduced. */
  method?: OptimizationMethodOptions
  selection?: OptimizationSelectionSummary
  budget: { limit: number; admitted: number; completed: number; active: number }
  /** Projection of unique Core admissions; each metric reports its own observed coverage. */
  usage?: ExecutionUsageSummary
  executions: Array<{
    executionId: string
    role: string
    phase: string
    stageId?: string
    sessionId?: string
  }>
  assessments?: { baseline: SemanticAssessmentSummary; candidate: SemanticAssessmentSummary }
  /** Verified source versions frozen at admission, retained on reopen without rerunning. */
  inputArtifacts?: OptimizationArtifactInput[]
  notebook?: {
    source: NotebookOptimizationSource
    inputs: FrozenNotebookInput[]
    runtime: FrozenNotebookRuntime
  }
  outcome?: ResearchOutcome
  domain?: DomainOptimizationSummary
  error?: string
  /** Explicit resume can be requested; main revalidates original snapshots and owners first. */
  resumeAvailable?: boolean
  updatedAt: number
}
export interface DesktopOptimizationApi {
  start(request: StartDesktopOptimization): Promise<OptimizationProgress>
  get(request: OptimizationRunKey): Promise<OptimizationProgress>
  latest(
    request: Pick<OptimizationRunKey, 'projectId' | 'sourceSessionId'>
  ): Promise<OptimizationProgress | null>
  stop(request: OptimizationRunKey): Promise<OptimizationProgress>
  /** Continue the original frozen experiment and remaining original budget, never a new task. */
  resume(request: OptimizationRunKey): Promise<OptimizationProgress>
}
