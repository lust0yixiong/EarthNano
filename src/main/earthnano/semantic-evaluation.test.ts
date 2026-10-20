import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionRecord, ExecutionRequest } from '../../shared/earthnano/execution-port'
import {
  createCandidateSnapshotStore,
  type ResolvedCandidateSnapshots,
  type CandidateSnapshotInput
} from './candidate-snapshot'
import { emptyExecutionState, ExecutionCore } from './execution-core'
import type {
  PersistentCandidateFile,
  PersistentCandidateOwners,
  PersistentCandidateResult
} from './persistent-candidate-owner'
import {
  evaluateOptimizationSemantics,
  parseSemanticAssessment,
  semanticCriteria,
  semanticDigest,
  type SemanticAssessmentDocument
} from './semantic-evaluation'

const criteria = 'The count is correct.\nThe deliverable is valid JSON.'
const artifactRef = {
  artifactId: 'fixed-artifact',
  versionId: 'fixed-version',
  checksum: createHash('sha256').update('{"count":3}').digest('hex')
}
const file: PersistentCandidateFile = {
  path: 'result.json',
  content: '{"count":3}',
  digest: semanticDigest('{"count":3}'),
  artifactRef
}
const document = (files = [file], value = criteria): SemanticAssessmentDocument => ({
  schemaVersion: 1,
  score: 95,
  outcome: 'pass',
  rationale: 'The supplied output satisfies the frozen criteria.',
  checks: semanticCriteria(value).map((criterion) => ({
    criterionId: criterion.id,
    status: 'pass',
    evidence: [
      { path: files[0]!.path, artifactRef: files[0]!.artifactRef, quote: files[0]!.content }
    ]
  }))
})
const roots: string[] = [],
  cores: ExecutionCore[] = []
afterEach(async () => {
  cores.splice(0).forEach((core) => core.dispose())
  const unlock = async (path: string): Promise<void> => {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      await chmod(path, 0o700)
      for (const name of await readdir(path)) await unlock(join(path, name))
    }
  }
  for (const root of roots.splice(0)) {
    await unlock(root)
    await rm(root, { recursive: true, force: true })
  }
})

type FixtureFault = 'none' | 'quote' | 'extra' | 'hang' | 'integrity' | 'tamper'
type Fixture = {
  snapshots: Awaited<ReturnType<typeof createCandidateSnapshotStore>>
  input: CandidateSnapshotInput
  core: ExecutionCore
  records: ExecutionRecord[]
  reviewerInputs: ResolvedCandidateSnapshots[]
  admissions: ExecutionRequest[]
  committed: Array<Parameters<PersistentCandidateOwners['commitSemanticReview']>[0]>
  owners: PersistentCandidateOwners
  setFault(value: FixtureFault): void
  options: Parameters<typeof evaluateOptimizationSemantics>[0]
}
async function setup(limit = 9): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'earthnano-semantic-unit-'))
  roots.push(root)
  const snapshots = await createCandidateSnapshotStore({
    root: join(root, 'snapshots'),
    candidatesRoot: join(root, 'candidates')
  })
  const input: CandidateSnapshotInput = {
    task: {
      prompt: 'Count the synthetic data rows.',
      files: [{ path: 'values.txt', content: 'ONE\nTWO\nTHREE\n@inert `evidence`' }]
    },
    harness: { instructions: 'SECRET_SOLVER_HARNESS', skills: [], tools: 'workspace-only' },
    agent: {
      backend: 'claude-code',
      model: 'synthetic-model',
      providerRef: 'synthetic-provider',
      runtimeVersion: '2.1.232'
    },
    environment: { isolation: 'directory-process', network: 'provider-only' }
  }
  const refs = await snapshots.freeze(input)
  const invocationRef = await snapshots.freezeInvocation({
    taskSnapshotRef: refs.taskSnapshotRef,
    harnessRevisionRef: refs.harnessRevisionRef,
    mission: 'Original method.'
  })
  let state = emptyExecutionState()
  const results = new Map<string, PersistentCandidateResult>()
  const reviewerInputs: ResolvedCandidateSnapshots[] = []
  const admissions: ExecutionRequest[] = []
  let fault: FixtureFault = 'none'
  const core = new ExecutionCore(
    {
      load: () => structuredClone(state),
      commit: (next) => {
        state = structuredClone(next)
      }
    },
    {
      execute: async (request, context) => {
        context.running()
        context.identity({
          sessionId: `session-${randomUUID()}`,
          promptMessageId: `prompt-${randomUUID()}`
        })
        const isReviewer = request.role === 'reviewer'
        let content = '{"count":3}',
          path = 'result.json'
        if (request.role === 'baseline') content = '{"count":2}'
        if (isReviewer) {
          const resolved = await snapshots.resolve(request)
          reviewerInputs.push(resolved)
          if (fault === 'hang')
            return new Promise((resolve) =>
              context.signal.addEventListener(
                'abort',
                () => resolve({ phase: 'cancelled', cleanup: 'confirmed' }),
                { once: true }
              )
            )
          const targets = JSON.parse(
            resolved.task.files.find((item) => item.path === 'evidence/artifacts.json')!.content
          ) as PersistentCandidateFile[]
          const criteriaPayload = JSON.parse(
            resolved.task.files.find((item) => item.path === 'evidence/criteria.json')!.content
          )
          expect(criteriaPayload.criteriaDigest).toBe(semanticDigest(criteria))
          const doc = document(targets)
          if (targets[0]!.content.includes(':2')) {
            doc.score = 40
            doc.outcome = 'flagged'
            doc.checks[0]!.status = 'fail'
          }
          if (fault === 'quote') doc.checks[0]!.evidence[0]!.quote = 'INVENTED QUOTE'
          content = JSON.stringify(doc)
          path = 'assessment.json'
        }
        const outputRef = {
          artifactId: randomUUID(),
          versionId: randomUUID(),
          checksum: createHash('sha256').update(content).digest('hex')
        }
        const files = [{ path, content, digest: semanticDigest(content), artifactRef: outputRef }]
        if (isReviewer && fault === 'extra')
          files.push({
            path: 'unexpected.txt',
            content,
            digest: semanticDigest(content),
            artifactRef: outputRef
          })
        results.set(context.executionId, {
          executionId: context.executionId,
          artifacts: [outputRef],
          replyText: 'SOLVER_REVIEW_ANSWER_DO_NOT_EXPOSE',
          trajectoryText: 'SOLVER_TRAJECTORY_DO_NOT_EXPOSE',
          files
        })
        return {
          phase: 'completed',
          cleanup: 'confirmed',
          evidence: {
            status: 'complete',
            scope: 'synthetic fixed version',
            text: 'not a semantic result',
            artifacts: [outputRef],
            references: [],
            limitations: []
          },
          configuration: {
            status: 'unknown',
            requestedDigest: request.harnessRevisionRef.digest,
            model: 'synthetic-model',
            instructions: [],
            skills: [],
            tools: [],
            confirmation: 'Fixture, no provider invocation'
          }
        }
      }
    }
  )
  cores.push(core)
  core.configureBudget('project', 'budget', limit)
  const roles: ExecutionRequest['role'][] = [
    'baseline',
    'proposer',
    'proposer',
    'candidate',
    'candidate',
    'composer',
    'candidate'
  ]
  const records: ExecutionRecord[] = []
  for (const [index, role] of roles.entries()) {
    const request: ExecutionRequest = {
      contractVersion: 1,
      requestKey: `seed-${index}`,
      projectId: 'project',
      ...refs,
      invocationRef,
      role,
      origin: { kind: 'optimization', optimizationId: 'optimization', stageId: `seed-${index}` },
      interactionPolicy: 'deny-unresolved',
      budgetRef: 'budget',
      timeoutMs: 5000
    }
    const handle = await core.submit(request)
    await vi.waitFor(async () =>
      expect((await core.get(handle.executionId)).phase).toBe('completed')
    )
    records.push(await core.get(handle.executionId))
  }
  const submit = core.submit.bind(core)
  vi.spyOn(core, 'submit').mockImplementation(async (request) => {
    admissions.push(structuredClone(request))
    return submit(request)
  })
  const committed: Array<Parameters<PersistentCandidateOwners['commitSemanticReview']>[0]> = []
  const owners = {
    exportResult: vi.fn(async (record: ExecutionRecord) => {
      const value = structuredClone(results.get(record.executionId)!)
      if (fault === 'tamper' && record.request.role !== 'reviewer')
        value.files[0]!.content += 'changed'
      return value
    }),
    readReviews: vi.fn(async () => [
      { lifecycle: 'complete', outcome: fault === 'integrity' ? 'flagged' : 'pass' }
    ]),
    commitSemanticReview: vi.fn(
      async (value: Parameters<PersistentCandidateOwners['commitSemanticReview']>[0]) => {
        committed.push(value)
        return { reviewId: `semantic-review-${committed.length}`, outcome: value.document.outcome }
      }
    )
  } as unknown as PersistentCandidateOwners
  return {
    snapshots,
    input,
    core,
    records,
    reviewerInputs,
    admissions,
    committed,
    owners,
    setFault: (value: typeof fault) => {
      fault = value
    },
    options: {
      core,
      snapshots,
      owners,
      input,
      records,
      methodResult: { status: 'ok', chosenArtifacts: records[6]!.evidence.artifacts },
      projectId: 'project',
      optimizationId: 'optimization',
      taskId: 'task',
      budgetRef: 'budget',
      criteria,
      timeoutMs: 5000
    }
  }
}

describe('strict grounded semantic assessment parser', () => {
  it('accepts exact pinned evidence and complete criteria coverage', () => {
    expect(parseSemanticAssessment(JSON.stringify(document()), [file], criteria)).toEqual(
      document()
    )
    expect(semanticCriteria(' one \n\n two ')).toEqual([
      { id: 'c1', text: 'one' },
      { id: 'c2', text: 'two' }
    ])
  })
  it.each([
    'score',
    'extra',
    'quote',
    'version',
    'path',
    'missing',
    'duplicate',
    'contradiction',
    'noEvidence'
  ])('rejects invalid or ungrounded %s', (fault) => {
    const doc = structuredClone(document()) as SemanticAssessmentDocument & { extra?: string }
    if (fault === 'score') doc.score = 101
    if (fault === 'extra') doc.extra = 'unknown'
    if (fault === 'quote') doc.checks[0]!.evidence[0]!.quote = 'NOT IN THE FILE'
    if (fault === 'version') doc.checks[0]!.evidence[0]!.artifactRef.versionId = 'latest-not-pinned'
    if (fault === 'path') doc.checks[0]!.evidence[0]!.path = 'other.json'
    if (fault === 'missing') doc.checks.pop()
    if (fault === 'duplicate') doc.checks[1]!.criterionId = 'c1'
    if (fault === 'contradiction') doc.checks[0]!.status = 'fail'
    if (fault === 'noEvidence') doc.checks[0]!.evidence = []
    expect(() => parseSemanticAssessment(doc, [file], criteria)).toThrow()
  })
  it('rejects input-source citations paired with a target artifact reference', () => {
    const doc = document()
    doc.checks[0]!.evidence[0] = {
      path: 'evidence/task.json (frozen input values.csv)',
      artifactRef: structuredClone(artifactRef),
      quote: 'value\n1\n2\n3'
    }
    expect(() => parseSemanticAssessment(doc, [file], criteria)).toThrow(
      'existing exact artifact version'
    )
  })
  it('rejects string pass and more than sixteen criteria', () => {
    expect(() => parseSemanticAssessment('pass', [file], criteria)).toThrow()
    expect(() =>
      semanticCriteria(Array.from({ length: 17 }, (_, n) => `criterion ${n}`).join('\n'))
    ).toThrow()
  })
})

describe('independent semantic execution', () => {
  it('adds exactly two budgeted isolated reviewers after seven original admissions and blinds both contexts', async () => {
    const f = await setup()
    const result = await evaluateOptimizationSemantics(f.options)
    expect(f.admissions).toHaveLength(2)
    expect(
      f.admissions.every((request) => request.role === 'reviewer' && request.budgetRef === 'budget')
    ).toBe(true)
    expect(result.baseline).toMatchObject({
      outcome: 'flagged',
      score: 40,
      targetExecutionId: f.records[0]!.executionId
    })
    expect(result.candidate).toMatchObject({
      outcome: 'pass',
      score: 95,
      targetExecutionId: f.records[6]!.executionId
    })
    expect(new Set(f.committed.map((value) => value.assessment.identity.sessionId)).size).toBe(2)
    expect(f.committed).toHaveLength(2)
    for (const context of f.reviewerInputs) {
      const all = JSON.stringify(context)
      expect(all).not.toContain('SECRET_SOLVER_HARNESS')
      expect(all).not.toContain('SOLVER_TRAJECTORY_DO_NOT_EXPOSE')
      expect(all).not.toContain('SOLVER_REVIEW_ANSWER_DO_NOT_EXPOSE')
      expect(context.harness.skills).toEqual([])
      expect(context.task.files.map((entry) => entry.path).sort()).toEqual([
        'evidence/artifacts.json',
        'evidence/criteria.json',
        'evidence/task.json'
      ])
      expect(
        JSON.parse(context.task.files.find((entry) => entry.path === 'evidence/task.json')!.content)
      ).toEqual(f.input.task)
      expect(context.invocation.mission).not.toContain('@')
      expect(context.invocation.mission).not.toContain('`')
      expect(context.invocation.mission).toContain('EarthNano execution role: reviewer.')
    }
  })
  it('fails instead of falling back when the shared ninth admission is refused', async () => {
    const f = await setup(8)
    await expect(evaluateOptimizationSemantics(f.options)).rejects.toThrow('budget')
    expect(f.committed).toHaveLength(1)
    expect(f.admissions).toHaveLength(2)
  })
  it.each(['quote', 'extra', 'integrity', 'tamper'] as const)(
    'rejects %s without accepting a pass or assessing the second target',
    async (fault) => {
      const f = await setup()
      f.setFault(fault)
      await expect(evaluateOptimizationSemantics(f.options)).rejects.toThrow()
      expect(f.committed).toHaveLength(0)
      expect(f.admissions.length).toBeLessThanOrEqual(1)
    }
  )
  it('cancels the admitted reviewer on stop and never starts the second assessment', async () => {
    const f = await setup()
    f.setFault('hang')
    const controller = new AbortController()
    const pending = evaluateOptimizationSemantics({ ...f.options, signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(f.reviewerInputs).toHaveLength(1))
    controller.abort(new Error('User stopped'))
    await rejected
    expect(f.admissions).toHaveLength(1)
    expect(f.committed).toHaveLength(0)
  })
  it.each(['resolve', 'reject'] as const)(
    'holds stop completion until an in-flight semantic Review commit %s settles',
    async (settlement) => {
      const f = await setup()
      const controller = new AbortController()
      let entered!: () => void
      const committing = new Promise<void>((resolve) => {
        entered = resolve
      })
      let finish!: () => void
      f.owners.commitSemanticReview = vi.fn(async (value) => {
        expect(value.signal?.aborted).toBe(false)
        entered()
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        expect(value.signal?.aborted).toBe(true)
        if (settlement === 'reject') throw new Error('Commit abort-to-error cleanup settled')
        // Model a binding that has just committed but does not itself throw on abort.
        return { reviewId: 'late-committed-review', outcome: value.document.outcome }
      })
      const pending = evaluateOptimizationSemantics({ ...f.options, signal: controller.signal })
      let settled = false
      void pending.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      const rejected = expect(pending).rejects.toThrow()
      await committing
      controller.abort(new Error('User stopped during Review commit'))
      // An abort Promise.race would already reject here and let the manager release its lease.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(f.admissions).toHaveLength(1)
      finish()
      await rejected
      expect(settled).toBe(true)
      expect(f.admissions).toHaveLength(1)
      expect(f.owners.commitSemanticReview).toHaveBeenCalledTimes(1)
    }
  )
  it('does not let an unresponsive preparatory snapshot block cancellation', async () => {
    const f = await setup()
    vi.spyOn(f.snapshots, 'freeze').mockImplementationOnce(() => new Promise(() => undefined))
    const controller = new AbortController()
    const pending = evaluateOptimizationSemantics({ ...f.options, signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow()
    controller.abort(new Error('Stopped during freeze'))
    await rejected
    expect(f.admissions).toHaveLength(0)
  })
  it('rejects reviewer deadline expiry without manufacturing an assessment', async () => {
    const f = await setup()
    f.setFault('hang')
    await expect(evaluateOptimizationSemantics({ ...f.options, timeoutMs: 100 })).rejects.toThrow()
    expect(f.admissions.length).toBeLessThanOrEqual(1)
    expect(f.committed).toHaveLength(0)
  })
  it('rejects an ambiguous chosen version and a pre-cancelled scope before any reviewer admission', async () => {
    const f = await setup()
    await expect(
      evaluateOptimizationSemantics({
        ...f.options,
        methodResult: { status: 'ok', chosenArtifacts: [] }
      })
    ).rejects.toThrow()
    await expect(
      evaluateOptimizationSemantics({
        ...f.options,
        records: [...f.records, structuredClone(f.records[6]!)]
      })
    ).rejects.toThrow('unambiguous')
    const controller = new AbortController()
    controller.abort()
    await expect(
      evaluateOptimizationSemantics({ ...f.options, signal: controller.signal })
    ).rejects.toThrow()
    expect(f.admissions).toHaveLength(0)
  })
})
