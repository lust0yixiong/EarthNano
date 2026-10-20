import { useTranslation } from 'react-i18next'
import type {
  ResearchOutcome,
  ExperienceProvenance
} from '../../../../shared/earthnano/research-outcome'

export function ResearchOutcomeView({
  outcome,
  sessionId,
  onOpenReview
}: {
  outcome: ResearchOutcome
  sessionId?: string
  onOpenReview?: (sessionId: string, reviewId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const checkReason = (reason: ResearchOutcome['artifact']['checks'][number]['reason']): string => {
    switch (reason) {
      case 'matched':
        return t('Expected value matched')
      case 'missing-file':
        return t('Output file missing')
      case 'invalid-json':
        return t('Output JSON is invalid')
      case 'missing-value':
        return t('JSON pointer value missing')
      case 'mismatch':
        return t('Expected value did not match')
    }
  }
  const admissionReason = (reason: string): string => {
    switch (reason) {
      case 'semantic-flagged':
        return t('Independent assessment flagged the selected result.')
      case 'output-check-failed':
        return t('An expected output check failed.')
      case 'no-deterministic-checks':
        return t('No deterministic output checks were supplied.')
      case 'score-regression':
        return t('The candidate scored below the baseline.')
      default:
        return t('Configuration admission needs further review.')
    }
  }
  return (
    <div className="space-y-1 rounded border border-border p-2" data-testid="research-outcome">
      <p>
        {outcome.artifact.status === 'passed'
          ? t('Output checks passed')
          : outcome.artifact.status === 'failed'
            ? t('Output checks failed')
            : t('Output checks unverified')}
      </p>
      <p>
        {outcome.configuration.status === 'eligible'
          ? t('Eligible for further configuration validation')
          : outcome.configuration.status === 'blocked'
            ? t('Configuration admission blocked')
            : t('Configuration admission unverified')}
      </p>
      {outcome.artifact.checks.map((check, index) => (
        <p key={index}>
          {t('Output check {{path}}{{pointer}}: {{result}}', {
            path: check.path,
            pointer: check.pointer,
            result: checkReason(check.reason)
          })}
        </p>
      ))}
      {outcome.configuration.reasons.map((reason, index) => (
        <p key={index} className="whitespace-pre-wrap break-words">
          {admissionReason(reason)}
        </p>
      ))}
      {outcome.configuration.harnessRevisionRef && (
        <p className="break-all text-xs">
          {t('Selected harness: {{id}} · version {{version}}', {
            id: outcome.configuration.harnessRevisionRef.id,
            version: outcome.configuration.harnessRevisionRef.version
          })}
        </p>
      )}
      {outcome.artifact.reviewId && sessionId && onOpenReview && (
        <button
          type="button"
          className="text-primary underline"
          onClick={() => onOpenReview(sessionId, outcome.artifact.reviewId!)}
        >
          {t('Open output check review')}
        </button>
      )}
    </div>
  )
}
export function ExperimentExperienceView({
  experience
}: {
  experience: ExperienceProvenance
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-1 text-xs text-text-400">
      <p>{t('Recorded experiment experience')}</p>
      <p className="break-all">
        {t('Selected harness: {{id}} · version {{version}}', {
          id: experience.selectedHarnessRevisionRef.id,
          version: experience.selectedHarnessRevisionRef.version
        })}
      </p>
      <p className="break-all">
        {t('Selected execution: {{id}}', { id: experience.selectedExecutionId })}
      </p>
      <p className="break-all">
        {t('Reflection execution: {{id}}', { id: experience.reflectionExecutionId })}
      </p>
      <p className="break-all">
        {t('Experience library digest: {{digest}}', { digest: experience.libraryDigest })}
      </p>
      {experience.reflectionArtifacts.map((artifact) => (
        <p key={artifact.versionId} className="break-all">
          {t('Reflection artifact: {{artifact}} · version {{version}}', {
            artifact: artifact.artifactId,
            version: artifact.versionId
          })}
        </p>
      ))}
    </div>
  )
}

export function IndependentAssessmentsView({
  assessments,
  executions,
  onOpenReview
}: {
  assessments: NonNullable<
    import('../../../../shared/earthnano/desktop-optimization').OptimizationProgress['assessments']
  >
  executions: import('../../../../shared/earthnano/desktop-optimization').OptimizationProgress['executions']
  onOpenReview?: (sessionId: string, reviewId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <p className="text-xs text-text-400">
        {t('Results compare independent assessments; improvement is not guaranteed.')}
      </p>
      {(['baseline', 'candidate'] as const).map((kind) => {
        const assessment = assessments[kind]
        const session = executions.find(
          (entry) => entry.executionId === assessment.targetExecutionId
        )?.sessionId
        return (
          <div key={kind} className="rounded border border-border p-2">
            <p className="font-medium">
              {kind === 'baseline' ? t('Baseline assessment') : t('Candidate assessment')}
            </p>
            <p>
              {t('Score: {{score}} · {{outcome}}', {
                score: assessment.score,
                outcome: assessment.outcome === 'pass' ? t('Passed') : t('Flagged')
              })}
            </p>
            <p className="whitespace-pre-wrap break-words">{assessment.rationale}</p>
            {session && onOpenReview && (
              <button
                type="button"
                className="text-primary underline"
                onClick={() => onOpenReview(session, assessment.reviewId)}
              >
                {t('Open assessment')}
              </button>
            )}
          </div>
        )
      })}
    </>
  )
}
