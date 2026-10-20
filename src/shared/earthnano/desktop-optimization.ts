/** Desktop requests contain text task inputs, never provider credentials or host paths. */
export interface StartDesktopOptimization {
  projectId: string
  sourceSessionId: string
  requestKey: string
  prompt: string
  files: Array<{ path: string; content: string }>
  criteria: string
  /** Shared admission budget including both independent assessments. */
  executionLimit: number
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
  budget: { limit: number; admitted: number; completed: number; active: number }
  executions: Array<{ executionId: string; role: string; phase: string; sessionId?: string }>
  assessments?: { baseline: SemanticAssessmentSummary; candidate: SemanticAssessmentSummary }
  error?: string
  updatedAt: number
}
export interface DesktopOptimizationApi {
  start(request: StartDesktopOptimization): Promise<OptimizationProgress>
  get(request: OptimizationRunKey): Promise<OptimizationProgress>
  latest(
    request: Pick<OptimizationRunKey, 'projectId' | 'sourceSessionId'>
  ): Promise<OptimizationProgress | null>
  stop(request: OptimizationRunKey): Promise<OptimizationProgress>
}
