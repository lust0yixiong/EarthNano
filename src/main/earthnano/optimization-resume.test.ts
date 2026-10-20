import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import fixtures from '../../../contracts/execution/fixtures.json'
import type { ExecutionRecord, ExecutionRequest } from '../../shared/earthnano/execution-port'
import { emptyExecutionState, ExecutionCore, type ExecutionContext } from './execution-core'
import {
  OptimizationResumeIndex,
  optimizationMethodDigest,
  readPersistentOptimizationResume,
  reuseAssessmentRequest,
  sameExecutionInputs,
  writeResumeJson,
  type OptimizationResumeIdentity
} from './optimization-resume'
import { outputDigest } from './output-checks'

const roots: string[] = []
const cores: ExecutionCore[] = []
afterEach(() => {
  cores.splice(0).forEach((core) => core.dispose())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), 'earthnano-resume-'))
  roots.push(value)
  return value
}
const request = (): ExecutionRequest => ({
  ...(structuredClone(fixtures.valid) as ExecutionRequest),
  role: 'reviewer',
  origin: { kind: 'optimization', optimizationId: 'trial', stageId: 'semantic:one' },
  interactionPolicy: 'deny-unresolved'
})
const completed = async (): Promise<{
  record: ExecutionRecord
  core: ExecutionCore
  dispatch: ReturnType<typeof vi.fn>
}> => {
  let state = emptyExecutionState()
  const dispatch = vi.fn(async (_request: ExecutionRequest, context: ExecutionContext) => {
    context.running()
    return { phase: 'completed' as const, cleanup: 'confirmed' as const }
  })
  const core = new ExecutionCore(
    {
      load: () => structuredClone(state),
      commit: (value) => {
        state = structuredClone(value)
      }
    },
    { execute: dispatch }
  )
  cores.push(core)
  core.configureBudget('demo', 'trial', 10)
  const handle = await core.submit(request())
  const record = await core.waitForTerminal(handle.executionId)
  return { record, core, dispatch }
}

it('keeps the original admission and dispatch when an exact completed reviewer is restored', async () => {
  const f = await completed()
  const fresh = {
    ...request(),
    requestKey: 'new',
    origin: { ...request().origin, stageId: 'semantic:two' }
  }
  const restored = reuseAssessmentRequest([f.record], fresh)
  expect(restored).toEqual(f.record.request)
  const handle = await f.core.submit(restored)
  expect(handle.executionId).toBe(f.record.executionId)
  expect(f.dispatch).toHaveBeenCalledOnce()
  expect(await f.core.get(handle.executionId)).toEqual(f.record)
})

it('does not reuse changed scientific evidence, model, harness, environment, task, policy or budget', async () => {
  const { record } = await completed()
  const changes: Array<Partial<ExecutionRequest>> = [
    ...(
      [
        'taskSnapshotRef',
        'agentSpecRef',
        'harnessRevisionRef',
        'environmentSpecRef',
        'invocationRef'
      ] as const
    ).map((key) => ({ [key]: { ...request()[key], digest: `sha256:${'b'.repeat(64)}` } })),
    { projectId: 'other' },
    { role: 'candidate' },
    { budgetRef: 'other' },
    { timeoutMs: 9999 },
    { interactionPolicy: 'interactive' },
    { origin: { ...request().origin, optimizationId: 'other' } }
  ]
  for (const change of changes) {
    const fresh = { ...request(), ...change, requestKey: 'new' }
    expect(sameExecutionInputs(record.request, fresh)).toBe(false)
    expect(reuseAssessmentRequest([record], fresh)).toEqual(fresh)
  }
  for (const phase of ['failed', 'cancelled', 'interrupted', 'running'] as const)
    expect(reuseAssessmentRequest([{ ...record, phase }], request())).toEqual(request())
  expect(reuseAssessmentRequest([{ ...record, cleanup: 'unknown' }], request())).toEqual(request())
})

it('keeps the routing index separate from confirmed journal settlement and duplicate-byte task identity', async () => {
  const { record } = await completed()
  const filename = join(root(), 'routing.json')
  const index = new OptimizationResumeIndex(filename, false)
  index.remember('first', record.request, 'slot')
  const other = { ...record, executionId: 'second', requestKey: 'second' }
  index.remember('second', { ...record.request, requestKey: 'second' }, 'slot')
  expect(index.recordsForTask('first', [record, other])).toEqual([record])
  expect(index.recordsForTask('second', [record, other])).toEqual([other])
  expect(() => index.remember('second', record.request, 'slot')).toThrow('ownership changed')
  for (const phase of ['running', 'queued', 'interrupted'] as const)
    expect(() => index.validate([{ ...record, phase }])).toThrow('reconciliation')
  expect(() => index.validate([{ ...record, cleanup: 'unknown' }])).toThrow('reconciliation')
  expect(() => index.validate([{ ...record, requestDigest: `sha256:${'b'.repeat(64)}` }])).toThrow()
  expect(() => index.validate([{ ...record, phase: 'failed' }])).not.toThrow()
  expect(() => index.validate([{ ...record, phase: 'cancelled' }])).not.toThrow()
  expect(new OptimizationResumeIndex(filename, true).slot(record.requestKey)).toBe('slot')
  const altered = JSON.parse(readFileSync(filename, 'utf8'))
  altered.entries[record.requestKey].taskId = 'different-owner'
  writeResumeJson(filename, altered)
  expect(() => new OptimizationResumeIndex(filename, true)).toThrow('routing index changed')
  for (const malformed of [null, [], {}, { schemaVersion: 1 }]) {
    writeResumeJson(filename, malformed)
    expect(() => new OptimizationResumeIndex(filename, true)).toThrow()
  }
})

it('pins method source bytes and immutable descriptor identity while excluding generated Python cache files', () => {
  const directory = root()
  mkdirSync(join(directory, 'harness2'))
  writeFileSync(join(directory, 'harness2/schedule.py'), 'original schedule')
  const methodDigest = optimizationMethodDigest(directory)
  mkdirSync(join(directory, 'harness2/__pycache__'))
  writeFileSync(join(directory, 'harness2/__pycache__/schedule.pyc'), 'compiled')
  expect(optimizationMethodDigest(directory)).toBe(methodDigest)
  writeFileSync(join(directory, 'harness2/schedule.py'), 'changed schedule')
  expect(optimizationMethodDigest(directory)).not.toBe(methodDigest)
  const identity = { taskId: 'fixed' } as OptimizationResumeIdentity
  writeResumeJson(join(directory, 'resume.json'), {
    schemaVersion: 1,
    optimizationId: 'fixed',
    identity,
    identityDigest: outputDigest(identity),
    methodDigest
  })
  expect(readPersistentOptimizationResume(directory).identity).toEqual(identity)
  const value = JSON.parse(readFileSync(join(directory, 'resume.json'), 'utf8'))
  writeResumeJson(join(directory, 'resume.json'), { ...value, identity: { taskId: 'changed' } })
  expect(() => readPersistentOptimizationResume(directory)).toThrow('changed')
})
