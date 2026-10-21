import { describe, expect, it } from 'vitest'
import type { SemanticAssessmentSummary } from '../../shared/earthnano/desktop-optimization'
import { chosenExecution, evaluateResearchOutcome } from './research-verification'
import { fixture } from '../../../test/earthnano/research-domain'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Preserve the exact inferred composite fixture type for adversarial mutations.
async function setup() {
  const f = await fixture()
  const baseline = await f.record('baseline', 'base1')
  const candidate = await f.record('candidate', 'final1', {
    harness: 'Selected configuration, awaiting validation.'
  })
  const assessment = (targetExecutionId: string, score: number): SemanticAssessmentSummary => ({
    executionId: `reviewer-${targetExecutionId}`,
    targetExecutionId,
    reviewId: `semantic-${targetExecutionId}`,
    outcome: 'pass',
    score,
    rationale: 'Frozen criteria satisfied.'
  })
  return {
    ...f,
    candidate,
    options: {
      records: [baseline, candidate],
      methodResult: { status: 'ok', chosenArtifacts: candidate.evidence.artifacts },
      owners: f.owners,
      assessments: {
        baseline: assessment(baseline.executionId, 80),
        candidate: assessment(candidate.executionId, 90)
      }
    }
  }
}
const check = { kind: 'json-value' as const, path: 'result.json', pointer: '/sum', expected: 6 }

describe('artifact acceptance and configuration admission', () => {
  it.each([undefined, []])(
    'keeps semantic pass unverified without supplied deterministic checks: %j',
    async (checks) => {
      const f = await setup()
      const outcome = await evaluateResearchOutcome({ ...f.options, checks })
      expect(outcome.artifact).toEqual({ status: 'unverified', checks: [] })
      expect(outcome.configuration).toMatchObject({
        status: 'unverified',
        reasons: ['no-deterministic-checks'],
        harnessRevisionRef: f.candidate.request.harnessRevisionRef
      })
      expect(f.commitDeterministicReview).not.toHaveBeenCalled()
    }
  )
  it('permits only further configuration validation when exact pinned checks and semantic assessment pass', async () => {
    const f = await setup()
    const outcome = await evaluateResearchOutcome({ ...f.options, checks: [check] })
    expect(outcome).toMatchObject({
      artifact: {
        status: 'passed',
        reviewId: 'deterministic-review',
        checks: [{ status: 'pass', artifactRef: f.candidate.evidence.artifacts[0] }]
      },
      configuration: {
        status: 'eligible',
        reasons: [],
        harnessRevisionRef: f.candidate.request.harnessRevisionRef
      }
    })
    expect(f.commitDeterministicReview).toHaveBeenCalledExactlyOnceWith({
      target: f.candidate,
      checks: [check],
      signal: undefined
    })
    expect(Object.keys(outcome).sort()).toEqual(['artifact', 'configuration'])
    expect(outcome).not.toHaveProperty('published')
  })
  it('blocks a fluent semantic pass when its persisted output fails the frozen expectation', async () => {
    const f = await setup()
    f.commitDeterministicReview.mockResolvedValue({
      reviewId: 'failed-check-review',
      outcome: 'flagged'
    })
    const outcome = await evaluateResearchOutcome({
      ...f.options,
      checks: [{ ...check, expected: 99 }]
    })
    expect(outcome).toMatchObject({
      artifact: { status: 'failed', reviewId: 'failed-check-review' },
      configuration: { status: 'blocked', reasons: ['output-check-failed'] }
    })
  })
  it('blocks semantic flagged and score regression independently of passing deterministic checks', async () => {
    const f = await setup()
    f.options.assessments.candidate.outcome = 'flagged'
    expect(await evaluateResearchOutcome({ ...f.options, checks: [check] })).toMatchObject({
      artifact: { status: 'failed' },
      configuration: { status: 'blocked', reasons: ['semantic-flagged'] }
    })
    f.options.assessments.candidate.outcome = 'pass'
    f.options.assessments.candidate.score = 79
    expect(await evaluateResearchOutcome({ ...f.options, checks: [check] })).toMatchObject({
      artifact: { status: 'passed' },
      configuration: { status: 'blocked', reasons: ['score-regression'] }
    })
  })
  it('refuses an authoritative Review that disagrees with the frozen check result', async () => {
    const f = await setup()
    f.commitDeterministicReview.mockResolvedValue({
      reviewId: 'flagged-review',
      outcome: 'flagged'
    })
    await expect(evaluateResearchOutcome({ ...f.options, checks: [check] })).rejects.toThrow(
      'Review'
    )
    f.commitDeterministicReview.mockResolvedValue({ reviewId: 'passing-review', outcome: 'pass' })
    await expect(
      evaluateResearchOutcome({ ...f.options, checks: [{ ...check, expected: 99 }] })
    ).rejects.toThrow('Review')
  })
  it('requires the semantic and deterministic checks to target the same selected immutable execution', async () => {
    const f = await setup()
    f.options.assessments.candidate.targetExecutionId = 'another-task-final'
    await expect(evaluateResearchOutcome({ ...f.options, checks: [check] })).rejects.toThrow(
      'target'
    )
    expect(f.exportResult).not.toHaveBeenCalled()
    expect(f.commitDeterministicReview).not.toHaveBeenCalled()
  })
  it('rejects duplicate chosen provenance and incomplete or cancelled candidates', async () => {
    const f = await setup()
    expect(() =>
      chosenExecution(
        [f.candidate, { ...f.candidate, executionId: 'other' }],
        f.options.methodResult
      )
    ).toThrow('Ambiguous')
    for (const phase of ['queued', 'running', 'failed', 'cancelled', 'interrupted'] as const)
      expect(() => chosenExecution([{ ...f.candidate, phase }], f.options.methodResult)).toThrow(
        'Ambiguous'
      )
    expect(() =>
      chosenExecution([{ ...f.candidate, cleanup: 'unknown' }], f.options.methodResult)
    ).toThrow('Ambiguous')
  })
  it('stops before writing acceptance evidence when already cancelled', async () => {
    const f = await setup()
    await expect(
      evaluateResearchOutcome({ ...f.options, checks: [check], signal: AbortSignal.abort() })
    ).rejects.toThrow()
    expect(f.exportResult).not.toHaveBeenCalled()
    expect(f.commitDeterministicReview).not.toHaveBeenCalled()
  })
})
