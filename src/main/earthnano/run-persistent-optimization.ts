import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  normalizeOptimizationMethod,
  MAX_OPTIMIZATION_EXECUTIONS,
  type OptimizationMethodOptions
} from '../../shared/earthnano/optimization-method'
import type { ExecutionRecord } from '../../shared/earthnano/execution-port'
import { createCandidateSnapshotStore, type CandidateSnapshotInput } from './candidate-snapshot'
import {
  createClaudeCandidateDriver,
  type ClaudeCandidateDriverOptions
} from './claude-candidate-driver'
import { ExecutionCore } from './execution-core'
import { FileExecutionStore } from './execution-store'
import {
  assertExecutionTimeout,
  HARNESS_RPC_TIMEOUT_MARGIN_MS,
  MAX_HARNESS_EXECUTION_TIMEOUT_MS
} from './execution-timeout'
import type { SemanticAssessmentSummary } from '../../shared/earthnano/desktop-optimization'
import {
  evaluateOptimizationSemantics,
  semanticCriteria as validateSemanticCriteria,
  semanticDigest
} from './semantic-evaluation'
import { HarnessOptimizationBinding, runHarnessProcess } from './harness-optimization'
import {
  createPersistentCandidateOwners,
  type PersistentCandidateOwnersOptions
} from './persistent-candidate-owner'

export interface PersistentOptimizationProgress {
  optimizationId: string
  stage: 'optimizing' | 'assessing' | 'settled'
  records: ExecutionRecord[]
}

export interface PersistentOptimizationOptions {
  /** Existing project identity in the original OpenScience repositories. */
  projectId: string
  taskId: string
  input: CandidateSnapshotInput
  /** New exclusive run directory; never reuse a prior optimization workspace. */
  workRoot: string
  harnessRoot: string
  python?: string
  ownerOptions: PersistentCandidateOwnersOptions
  binding: ClaudeCandidateDriverOptions['binding']
  method?: OptimizationMethodOptions
  executionLimit?: number
  executionTimeoutMs?: number
  /** Overall execution deadline, including independent assessments; cleanup is always awaited. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Fixed before optimization; never forwarded to proposer/composer. */
  semanticCriteria?: string
  /** Projection of committed execution facts, including reviewer admissions. */
  onProgress?: (progress: PersistentOptimizationProgress) => void
}

/** Opt-in production composition. Existing Session/Artifact/Review owners remain authoritative.
 * A fresh invocation is required; interruption never silently replays a paid model request. */
export interface PersistentOptimizationResult {
  optimizationId: string
  methodResult: unknown
  records: ExecutionRecord[]
  assessments?: { baseline: SemanticAssessmentSummary; candidate: SemanticAssessmentSummary }
}
export async function runPersistentOptimization(
  options: PersistentOptimizationOptions
): Promise<PersistentOptimizationResult> {
  options.signal?.throwIfAborted()
  const method = normalizeOptimizationMethod(options.method)
  const input = structuredClone(options.input)
  const semanticCriteria = options.semanticCriteria
  if (semanticCriteria !== undefined) validateSemanticCriteria(semanticCriteria)
  if (!isAbsolute(options.workRoot) || !isAbsolute(options.harnessRoot))
    throw new Error('Optimization paths must be absolute')
  const limit = options.executionLimit ?? 10
  const executionTimeoutMs = options.executionTimeoutMs ?? 120_000
  const timeoutMs = options.timeoutMs ?? 600_000
  if (
    limit > MAX_OPTIMIZATION_EXECUTIONS ||
    ![limit, executionTimeoutMs, timeoutMs].every(
      (value) => Number.isSafeInteger(value) && value > 0
    )
  )
    throw new Error('Invalid optimization limits')
  // Reject before allocating timers, creating a run directory, or opening persistent owners.
  assertExecutionTimeout(timeoutMs)
  assertExecutionTimeout(executionTimeoutMs, MAX_HARNESS_EXECUTION_TIMEOUT_MS)
  const deadline = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  await mkdir(options.workRoot, { mode: 0o700 })
  const optimizationId = randomUUID()
  const store = new FileExecutionStore(join(options.workRoot, 'execution.json'))
  let stage: PersistentOptimizationProgress['stage'] = 'optimizing'
  const publish = (): void => {
    options.onProgress?.({ optimizationId, stage, records: Object.values(store.load().records) })
  }
  let result: PersistentOptimizationResult | undefined
  let cleanupConfirmed = false
  let core: ExecutionCore | undefined
  let binding: HarnessOptimizationBinding | undefined
  let owners: ReturnType<typeof createPersistentCandidateOwners> | undefined
  try {
    if (semanticCriteria !== undefined)
      await writeFile(
        join(options.workRoot, 'assessment-plan.json'),
        JSON.stringify({
          schemaVersion: 1,
          ...(method.k > 1 ? { baselineStageId: 'base1' } : {}),
          criteria: semanticCriteria,
          criteriaDigest: semanticDigest(semanticCriteria)
        }),
        { mode: 0o600, flag: 'wx' }
      )
    owners = createPersistentCandidateOwners(options.ownerOptions)
    const snapshots = await createCandidateSnapshotStore({
      root: join(options.workRoot, 'snapshots'),
      candidatesRoot: join(options.workRoot, 'candidates')
    })
    core = new ExecutionCore(
      {
        load: () => store.load(),
        commit: (state) => {
          store.commit(state)
          publish()
        }
      },
      createClaudeCandidateDriver({
        snapshots,
        binding: options.binding,
        openOwner: owners.openOwner
      }),
      256,
      { concurrency: method.concurrency }
    )
    core.configureBudget(options.projectId, optimizationId, limit)
    binding = new HarnessOptimizationBinding({
      core,
      snapshots,
      input,
      projectId: options.projectId,
      optimizationId,
      taskId: options.taskId,
      budgetRef: optimizationId,
      timeoutMs: executionTimeoutMs,
      exportResult: owners.exportResult
    })
    const config = {
      configVersion: 1,
      method,
      taskId: options.taskId,
      task: input.task,
      baseHarnessFiles: [
        { path: 'instructions.md', content: input.harness.instructions },
        ...input.harness.skills.map((file) => ({
          path: `skills/${file.path}`,
          content: file.content
        }))
      ],
      workRoot: join(options.workRoot, 'method'),
      model: input.agent.model,
      executionTimeoutMs,
      rpcTimeoutMs: executionTimeoutMs + HARNESS_RPC_TIMEOUT_MARGIN_MS
    }
    const configPath = join(options.workRoot, 'method-config.json')
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' })
    const methodResult = await runHarnessProcess({
      binding,
      python: options.python ?? 'python3',
      args: ['-B', '-m', 'harness2.earthnano', '--config', configPath],
      cwd: options.harnessRoot,
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        PYTHONPATH: options.harnessRoot,
        PYTHONDONTWRITEBYTECODE: '1',
        HOME: options.workRoot
      },
      timeoutMs,
      signal
    })
    if (
      !methodResult ||
      typeof methodResult !== 'object' ||
      (methodResult as { status?: string }).status !== 'ok'
    )
      throw new Error('Harness method did not adopt a valid final result')
    const records = await Promise.all(binding.executionIds.map((id) => core!.get(id)))
    // Match upstream PortMethodExecution's control stops. Ordinary failed attempts remain
    // charged and recorded, but a successful upstream retry may still produce a valid result.
    const controlCodes = new Set([
      'budget-exhausted',
      'budget-rejected',
      'cleanup-unconfirmed',
      'timeout',
      'cancelled',
      'interrupted',
      'process_restarted',
      'invalid-request',
      'request-conflict',
      'not-found'
    ])
    if (
      !records.length ||
      !records.some((record) => record.phase === 'completed') ||
      records.some(
        (record) =>
          !['completed', 'failed'].includes(record.phase) ||
          record.cleanup !== 'confirmed' ||
          controlCodes.has(record.error?.code ?? '')
      )
    )
      throw new Error('Optimization has incomplete executions')
    // Re-read original owners after the method ends; Python summaries cannot attest persistence.
    for (const record of records) {
      if (record.phase === 'failed') continue
      await owners.exportResult(record)
      const reviews = await owners.readReviews(record)
      if (
        !reviews.length ||
        reviews.some((review) => review.lifecycle !== 'complete' || review.outcome !== 'pass')
      )
        throw new Error('Optimization result lacks a complete passing integrity review')
    }
    let assessments:
      { baseline: SemanticAssessmentSummary; candidate: SemanticAssessmentSummary } | undefined
    if (semanticCriteria !== undefined) {
      signal.throwIfAborted()
      stage = 'assessing'
      publish()
      assessments = await evaluateOptimizationSemantics({
        core,
        snapshots,
        owners,
        input,
        records,
        methodResult,
        projectId: options.projectId,
        optimizationId,
        taskId: options.taskId,
        budgetRef: optimizationId,
        criteria: semanticCriteria,
        timeoutMs: executionTimeoutMs,
        signal
      })
    }
    result = {
      optimizationId,
      methodResult,
      records: Object.values(store.load().records),
      ...(assessments ? { assessments } : {})
    }
  } finally {
    try {
      await binding?.stop()
      const cleanup = owners ? await owners.shutdown() : { reaped: true }
      const state = store.load()
      stage = 'settled'
      publish()
      const safeToUnlock =
        cleanup.reaped &&
        Object.values(state.records).every(
          (record) =>
            ['completed', 'failed', 'cancelled'].includes(record.phase) &&
            record.cleanup === 'confirmed'
        )
      // Unknown cleanup retains the single-writer lock for explicit reconciliation. No auto-replay.
      cleanupConfirmed = safeToUnlock
      if (safeToUnlock) store.close()
    } finally {
      core?.dispose()
    }
  }
  if (!cleanupConfirmed) throw new Error('Optimization cleanup requires reconciliation')
  return result!
}
