import type { ExecutionRecord, ArtifactReference } from '../../shared/earthnano/execution-port'
import type { OutputCheckSpec, ResearchOutcome } from '../../shared/earthnano/research-outcome'
import type { SemanticAssessmentSummary } from '../../shared/earthnano/desktop-optimization'
import type { PersistentCandidateOwners } from './persistent-candidate-owner'
import { canonicalOutput, checkOutputFiles } from './output-checks'

export function chosenExecution(
  records: ExecutionRecord[],
  methodResult: unknown
): ExecutionRecord {
  const chosen = (methodResult as { chosenArtifacts?: ArtifactReference[] })?.chosenArtifacts
  if (!Array.isArray(chosen) || !chosen.length) throw new Error('No chosen fixed artifact version')
  const matches = records.filter(
    (record) =>
      record.request.role === 'candidate' &&
      record.phase === 'completed' &&
      record.cleanup === 'confirmed' &&
      canonicalOutput(record.evidence.artifacts) === canonicalOutput(chosen)
  )
  if (matches.length !== 1) throw new Error('Ambiguous chosen execution')
  return matches[0]!
}
export async function evaluateResearchOutcome(options: {
  records: ExecutionRecord[]
  methodResult: unknown
  owners: PersistentCandidateOwners
  assessments: { baseline: SemanticAssessmentSummary; candidate: SemanticAssessmentSummary }
  checks?: OutputCheckSpec[]
  signal?: AbortSignal
}): Promise<ResearchOutcome> {
  options.signal?.throwIfAborted()
  const target = chosenExecution(options.records, options.methodResult)
  if (target.executionId !== options.assessments.candidate.targetExecutionId)
    throw new Error('Verification target differs from semantic target')
  const output = await options.owners.exportResult(target)
  const checks = checkOutputFiles(output.files, options.checks ?? [])
  const review = checks.length
    ? await options.owners.commitDeterministicReview!({
        target,
        checks: options.checks!,
        signal: options.signal
      })
    : undefined
  options.signal?.throwIfAborted()
  const semanticPass = options.assessments.candidate.outcome === 'pass'
  const allChecksPass = checks.every((check) => check.status === 'pass')
  if (review && review.outcome !== (allChecksPass ? 'pass' : 'flagged'))
    throw new Error('Deterministic Review disagrees with frozen output checks')
  const status =
    !semanticPass || !allChecksPass ? 'failed' : checks.length ? 'passed' : 'unverified'
  const regressed = options.assessments.candidate.score < options.assessments.baseline.score
  return {
    artifact: { status, checks, ...(review ? { reviewId: review.reviewId } : {}) },
    configuration: {
      status:
        status === 'failed' || regressed
          ? 'blocked'
          : status === 'passed'
            ? 'eligible'
            : 'unverified',
      reasons: [
        ...(!semanticPass ? ['semantic-flagged'] : []),
        ...(!allChecksPass ? ['output-check-failed'] : []),
        ...(!checks.length ? ['no-deterministic-checks'] : []),
        ...(regressed ? ['score-regression'] : [])
      ],
      harnessRevisionRef: structuredClone(target.request.harnessRevisionRef)
    }
  }
}
