import type { ArtifactReference, ExecutionRecord } from '../../shared/earthnano/execution-port'
import type { ReviewWithChecks } from '../../shared/reviewer'
import type { OutputCheckSpec } from '../../shared/earthnano/research-outcome'
import type { ClaudeCandidateDriverOptions } from './claude-candidate-driver'
import type { CandidateSnapshotStore } from './candidate-snapshot'
import type { SemanticSourceEvidence } from './semantic-source-evidence'
import type {
  CandidateArtifactFile,
  CandidateBinaryArtifactFile
} from '../../shared/earthnano/candidate-artifact'

export interface SemanticCriterion {
  id: string
  text: string
}
export interface SemanticAssessmentEvidence {
  path: string
  artifactRef: ArtifactReference
  quote: string
}
export interface SemanticAssessmentDocument {
  schemaVersion: 1
  score: number
  outcome: 'pass' | 'flagged'
  rationale: string
  checks: Array<{
    criterionId: string
    status: 'pass' | 'warn' | 'fail'
    evidence: SemanticAssessmentEvidence[]
  }>
}
export interface PersistentCandidateFile {
  path: string
  content: string
  digest: string
  artifactRef: ArtifactReference
}
export interface PersistentCandidateResult {
  executionId: string
  artifacts: ArtifactReference[]
  replyText: string
  trajectoryText: string
  files: CandidateArtifactFile[]
}
export interface PersistentCandidateOwners {
  openOwner: ClaudeCandidateDriverOptions['openOwner']
  exportResult(record: ExecutionRecord): Promise<PersistentCandidateResult>
  /** Host-only exact Version projection; callers never select a destination path. */
  materializeArtifact?(
    record: ExecutionRecord,
    artifactRef: ArtifactReference,
    signal?: AbortSignal
  ): Promise<{ file: CandidateBinaryArtifactFile; assetPath: string }>
  readReviews(record: ExecutionRecord): Promise<ReviewWithChecks[]>
  readSemanticSourceEvidence(input: {
    target: ExecutionRecord
    snapshots: CandidateSnapshotStore
    signal?: AbortSignal
  }): Promise<SemanticSourceEvidence>
  commitDeterministicReview?(input: {
    target: ExecutionRecord
    checks: OutputCheckSpec[]
    signal?: AbortSignal
  }): Promise<{ reviewId: string; outcome: 'pass' | 'flagged' }>
  commitSemanticReview(input: {
    target: ExecutionRecord
    assessment: ExecutionRecord
    criteria: string
    criteriaDigest: string
    document: SemanticAssessmentDocument
    sourceEvidence?: SemanticSourceEvidence
    snapshots?: CandidateSnapshotStore
    signal?: AbortSignal
  }): Promise<{ reviewId: string; outcome: 'pass' | 'flagged' }>
  shutdown(): Promise<{ reaped: boolean }>
}
