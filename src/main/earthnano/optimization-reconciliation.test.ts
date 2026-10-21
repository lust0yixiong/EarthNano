import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import fixtures from '../../../contracts/execution/fixtures.json'
import type { ExecutionRecord, ExecutionRequest } from '../../shared/earthnano/execution-port'
import { ExecutionCore, type ExecutionState } from './execution-core'
import { FileExecutionStore } from './execution-store'
import {
  persistCandidateOwnerSettlement,
  readCandidateOwnerSettlement,
  assertNoUnadoptedCandidateCompletion
} from './candidate-settlement-witness'
import { reconcilePersistentOptimization } from './optimization-reconciliation'
import { outputDigest } from './output-checks'
import { writeResumeJson, type OptimizationResumeIdentity } from './optimization-resume'

const roots: string[] = []
const cores: ExecutionCore[] = []
afterEach(() => {
  cores.splice(0).forEach((core) => core.dispose())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
const setup = async (): Promise<{
  root: string
  filename: string
  record: ExecutionRecord
  dispatch: ReturnType<typeof vi.fn>
  load(): ExecutionState
}> => {
  const root = mkdtempSync(join(tmpdir(), 'earthnano-reconcile-'))
  roots.push(root)
  const filename = join(root, 'execution.json')
  const store = new FileExecutionStore(filename)
  const dispatch = vi.fn(async (_request, context) => {
    context.identity({ sessionId: 'session', promptMessageId: 'prompt' })
    context.running()
    return new Promise<never>(() => undefined)
  })
  const core = new ExecutionCore(store, { execute: dispatch })
  cores.push(core)
  core.configureBudget('demo', 'trial', 10)
  const request: ExecutionRequest = {
    ...(structuredClone(fixtures.valid) as ExecutionRequest),
    role: 'baseline',
    origin: { kind: 'optimization', optimizationId: 'trial', stageId: 'base1' },
    interactionPolicy: 'deny-unresolved'
  }
  const handle = await core.submit(request)
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  const record = await core.get(handle.executionId)
  const identity = {
    projectId: 'demo',
    sourceSessionId: 'source',
    executionLimit: 10
  } as OptimizationResumeIdentity
  writeResumeJson(join(root, 'resume.json'), {
    schemaVersion: 1,
    optimizationId: 'trial',
    identity,
    identityDigest: outputDigest(identity),
    methodDigest: `sha256:${'a'.repeat(64)}`
  })
  core.dispose()
  // Same verified-dead PID lock fixture as the original FileExecutionStore recovery regressions.
  // No receipt ever treats this writer PID fact as proof that child resources were reaped.
  writeFileSync(filename + '.lock', '2147483647')
  return {
    root,
    filename,
    record,
    dispatch,
    load: (): ExecutionState => JSON.parse(readFileSync(filename, 'utf8'))
  }
}
const reconcile = (root: string): ReturnType<typeof reconcilePersistentOptimization> =>
  reconcilePersistentOptimization({
    workRoot: root,
    projectId: 'demo',
    sourceSessionId: 'source',
    authorize: async () => undefined
  })
const persist = (
  f: Awaited<ReturnType<typeof setup>>,
  phase: 'completed' | 'failed' | 'cancelled' = 'completed'
): ReturnType<typeof persistCandidateOwnerSettlement> =>
  persistCandidateOwnerSettlement(f.root, {
    request: f.record.request,
    executionId: f.record.executionId,
    identity: f.record.identity,
    outcome: {
      phase,
      cleanup: 'confirmed',
      ...(phase === 'failed'
        ? { error: { code: 'original-failure', message: 'Original failure' } }
        : {})
    }
  })

it('never takes over a dead writer or confirms resources without an original durable settlement witness', async () => {
  const f = await setup()
  const before = readFileSync(f.filename, 'utf8')
  expect(await reconcile(f.root)).toMatchObject({
    status: 'fenced',
    resumeAllowed: false,
    reasons: ['owner-witness-unavailable']
  })
  expect(readFileSync(f.filename, 'utf8')).toBe(before)
  expect(readFileSync(f.filename + '.lock', 'utf8')).toBe('2147483647')
  expect(f.dispatch).toHaveBeenCalledOnce()
})
it('reconciles only resources through original Core without promoting interrupted work, refunding, dispatching or duplicate evidence', async () => {
  const f = await setup()
  await persist(f)
  const beforeBudget = f.load().budgets
  expect(await reconcile(f.root)).toMatchObject({
    status: 'settled',
    resumeAllowed: false,
    reasons: ['historical-result-not-adopted'],
    records: [{ phase: 'interrupted', cleanup: 'confirmed' }]
  })
  const after = f.load()
  const record = after.records[f.record.executionId]
  expect(record.error?.code).toBe('process_restarted')
  expect(record.evidence.references).toHaveLength(1)
  expect(after.budgets).toEqual(beforeBudget)
  expect(f.dispatch).toHaveBeenCalledOnce()
  expect(() => assertNoUnadoptedCandidateCompletion(f.root, [record])).toThrow(
    'paid replay refused'
  )
  const repeat = await reconcile(f.root)
  expect(repeat.status).toBe('settled')
  expect(f.load()).toEqual(after)
})
it.each(['failed', 'cancelled'] as const)(
  'preserves original %s history while confirming exact owner retirement',
  async (phase) => {
    const f = await setup()
    const state = f.load()
    const historical = state.records[f.record.executionId]
    historical.phase = phase
    historical.cleanup = 'unknown'
    historical.error = { code: 'original-history', message: 'Preserve this failure' }
    writeResumeJson(f.filename, state)
    await persist(f, phase)
    expect(await reconcile(f.root)).toMatchObject({ status: 'settled', resumeAllowed: true })
    expect(f.load().records[f.record.executionId]).toMatchObject({
      phase,
      cleanup: 'confirmed',
      error: historical.error,
      usage: historical.usage,
      configuration: historical.configuration
    })
    expect(f.load().budgets).toEqual(state.budgets)
  }
)
it('refuses early, wrong-request, wrong-owner, damaged and replaced witnesses', async () => {
  const f = await setup()
  await expect(
    persistCandidateOwnerSettlement(f.root, {
      request: f.record.request,
      executionId: f.record.executionId,
      identity: f.record.identity,
      outcome: { phase: 'completed', cleanup: 'unknown' }
    })
  ).rejects.toThrow()
  await persist(f)
  await persist(f)
  await expect(persist(f, 'failed')).rejects.toThrow('cannot be replaced')
  const path = join(f.root, 'owner-settlements', `${f.record.executionId}.json`)
  const original = JSON.parse(readFileSync(path, 'utf8'))
  for (const change of [
    { requestDigest: `sha256:${'b'.repeat(64)}` },
    { identity: { sessionId: 'wrong-owner' } },
    { executionId: 'different-execution' },
    { digest: 'damaged' }
  ]) {
    const modified = { ...original, ...change }
    if (!('digest' in change)) {
      const payload = { ...modified }
      delete payload.digest
      modified.digest = outputDigest(payload)
    }
    writeResumeJson(path, modified)
    expect(await reconcile(f.root)).toMatchObject({
      status: 'fenced',
      reasons: ['owner-witness-invalid']
    })
    expect(f.load().records[f.record.executionId].cleanup).toBe('pending')
    expect(readFileSync(f.filename + '.lock', 'utf8')).toBe('2147483647')
  }
})
it('never steals a live original writer even with a valid resource settlement receipt', async () => {
  const f = await setup()
  await persist(f)
  writeFileSync(f.filename + '.lock', String(process.pid))
  expect(await reconcile(f.root)).toMatchObject({
    status: 'fenced',
    reasons: ['owner-lock-unverified']
  })
  expect(f.load().records[f.record.executionId].cleanup).toBe('pending')
})
it('requires exact host scope authorization before reading or changing the original journal', async () => {
  const f = await setup()
  const authorize = vi.fn(async () => undefined)
  await expect(
    reconcilePersistentOptimization({
      workRoot: f.root,
      projectId: 'other',
      sourceSessionId: 'source',
      authorize
    })
  ).rejects.toThrow('scope mismatch')
  expect(authorize).not.toHaveBeenCalled()
  await expect(
    reconcilePersistentOptimization({
      workRoot: f.root,
      projectId: 'demo',
      sourceSessionId: 'source',
      authorize: async () => {
        throw new Error('source unavailable')
      }
    })
  ).rejects.toThrow('source unavailable')
  expect(readFileSync(f.filename + '.lock', 'utf8')).toBe('2147483647')
  expect(readCandidateOwnerSettlement(f.root, f.record)).toBeUndefined()
})

it('does not convert a historical timeout into a completed result even with a late completed owner receipt', async () => {
  const f = await setup()
  const state = f.load()
  state.records[f.record.executionId].phase = 'failed'
  state.records[f.record.executionId].cleanup = 'unknown'
  state.records[f.record.executionId].error = {
    code: 'timeout',
    message: 'Original deadline failed'
  }
  writeResumeJson(f.filename, state)
  await persist(f, 'completed')
  expect(await reconcile(f.root)).toMatchObject({
    status: 'settled',
    resumeAllowed: false,
    reasons: ['historical-result-not-adopted']
  })
  const current = f.load().records[f.record.executionId]
  expect(current).toMatchObject({
    phase: 'failed',
    cleanup: 'confirmed',
    error: state.records[f.record.executionId].error
  })
  expect(() => assertNoUnadoptedCandidateCompletion(f.root, [current])).toThrow(
    'paid replay refused'
  )
  expect(f.load().budgets).toEqual(state.budgets)
})

it('retires only a verified-dead writer lock when the original journal already confirms cleanup', async () => {
  const f = await setup()
  const state = f.load()
  state.records[f.record.executionId].phase = 'failed'
  state.records[f.record.executionId].cleanup = 'confirmed'
  state.records[f.record.executionId].error = {
    code: 'original-failed',
    message: 'Original failed attempt'
  }
  writeResumeJson(f.filename, state)
  expect(await reconcile(f.root)).toMatchObject({ status: 'settled', resumeAllowed: true })
  expect(f.load()).toEqual(state)
})
