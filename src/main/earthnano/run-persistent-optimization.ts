import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  normalizeOptimizationArtifactInputs,
  type OptimizationArtifactInput
} from '../../shared/earthnano/optimization-input'
import {
  normalizeOptimizationMethod,
  MAX_OPTIMIZATION_EXECUTIONS,
  type OptimizationMethodOptions
} from '../../shared/earthnano/optimization-method'
import type { ExecutionRecord } from '../../shared/earthnano/execution-port'
import {
  normalizeOutputChecks,
  normalizeOptimizationDomain,
  type OutputCheckSpec,
  type OptimizationDomainSpec,
  type ResearchOutcome,
  type DomainOptimizationSummary
} from '../../shared/earthnano/research-outcome'
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
import { HarnessDomainBinding } from './harness-domain-binding'
import { prepareDomainSummary, type DomainMethodResult } from './domain-results'
import { evaluateResearchOutcome } from './research-verification'
import { canonicalOutput, outputDigest } from './output-checks'
import {
  createPersistentCandidateOwners,
  type PersistentCandidateOwnersOptions
} from './persistent-candidate-owner'

export interface PersistentOptimizationProgress {
  optimizationId: string
  stage: 'optimizing' | 'assessing' | 'settled'
  records: ExecutionRecord[]
  outcome?: ResearchOutcome
  domain?: DomainOptimizationSummary
}

export interface PersistentOptimizationOptions {
  /** Existing project identity in the original OpenScience repositories. */
  projectId: string
  sourceSessionId?: string
  taskId: string
  input: CandidateSnapshotInput
  /** Host-verified immutable source provenance; never an authority to read files. */
  inputArtifacts?: OptimizationArtifactInput[]
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
  checks?: OutputCheckSpec[]
  domain?: OptimizationDomainSpec
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
  outcome?: ResearchOutcome
  domain?: DomainOptimizationSummary
}
export async function runPersistentOptimization(
  options: PersistentOptimizationOptions
): Promise<PersistentOptimizationResult> {
  options.signal?.throwIfAborted()
  const method = normalizeOptimizationMethod(options.method)
  const input = structuredClone(options.input)
  const inputArtifacts = normalizeOptimizationArtifactInputs(options.inputArtifacts)
  const sourceSessionId = options.sourceSessionId
  if (
    inputArtifacts?.length &&
    (!sourceSessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sourceSessionId))
  )
    throw new Error('Optimization source Session identity missing')
  const semanticCriteria = options.semanticCriteria
  const checks = normalizeOutputChecks(options.checks)
  const domain = normalizeOptimizationDomain(options.domain)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.taskId) || options.taskId.endsWith('.'))
    throw new Error('Invalid optimization task identifier')
  if (domain && semanticCriteria === undefined)
    throw new Error('Domain optimization requires independent criteria')
  const tasks = domain
    ? [
        { taskId: options.taskId + '-0001', input, criteria: semanticCriteria!, checks },
        ...domain.nextTasks.map((task, index) => ({
          taskId: `${options.taskId}-${String(index + 2).padStart(4, '0')}`,
          input: { ...input, task: { prompt: task.prompt, files: task.files } },
          criteria: task.criteria,
          checks: task.checks
        }))
      ]
    : [{ taskId: options.taskId, input, criteria: semanticCriteria, checks }]
  for (const task of tasks)
    for (const ref of inputArtifacts ?? []) {
      const file = task.input.task.files.find((file) => file.path === ref.path)
      if (!file || createHash('sha256').update(file.content, 'utf8').digest('hex') !== ref.checksum)
        throw new Error('Frozen optimization input differs from its source version')
    }
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
  let outcome: ResearchOutcome | undefined
  let domainSummary: DomainOptimizationSummary | undefined = domain
    ? {
        name: domain.name,
        order: tasks.map((task) => task.taskId),
        tasks: tasks.map((task) => ({ taskId: task.taskId })),
        library: { scope: 'experiment', entries: [], digest: outputDigest([]) }
      }
    : undefined
  const publish = (): void => {
    options.onProgress?.({
      optimizationId,
      stage,
      records: Object.values(store.load().records),
      ...(outcome ? { outcome: structuredClone(outcome) } : {}),
      ...(domainSummary ? { domain: structuredClone(domainSummary) } : {})
    })
  }
  let result: PersistentOptimizationResult | undefined
  let cleanupConfirmed = false
  let core: ExecutionCore | undefined
  let binding: HarnessOptimizationBinding | HarnessDomainBinding | undefined
  let owners: ReturnType<typeof createPersistentCandidateOwners> | undefined
  try {
    if (inputArtifacts?.length)
      await writeFile(
        join(options.workRoot, 'input-artifacts.json'),
        canonicalOutput({
          schemaVersion: 1,
          projectId: options.projectId,
          sourceSessionId,
          artifacts: inputArtifacts,
          tasks: tasks.map((task) => ({
            taskId: task.taskId,
            inputDigest: outputDigest(task.input.task)
          }))
        }),
        { mode: 0o600, flag: 'wx' }
      )
    if (semanticCriteria !== undefined)
      await writeFile(
        join(options.workRoot, 'assessment-plan.json'),
        JSON.stringify({
          schemaVersion: 1,
          ...(method.k > 1 ? { baselineStageId: 'base1' } : {}),
          criteria: semanticCriteria,
          criteriaDigest: semanticDigest(semanticCriteria),
          ...(checks ? { checks } : {}),
          ...(domain
            ? {
                tasks: tasks.map((task) => ({
                  taskId: task.taskId,
                  criteria: task.criteria,
                  checks: task.checks
                }))
              }
            : {})
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
    const bindingOptions = {
      core,
      snapshots,
      projectId: options.projectId,
      optimizationId,
      budgetRef: optimizationId,
      timeoutMs: executionTimeoutMs,
      exportResult: owners.exportResult
    }
    binding = domain
      ? new HarnessDomainBinding(
          tasks.map((task) => ({ ...bindingOptions, input: task.input, taskId: task.taskId }))
        )
      : new HarnessOptimizationBinding({ ...bindingOptions, input, taskId: options.taskId })
    const config = {
      configVersion: 1,
      method,
      ...(domain
        ? {
            domain: domain.name,
            tasks: tasks.map((task) => ({ taskId: task.taskId, task: task.input.task }))
          }
        : { taskId: options.taskId, task: input.task }),
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
      args: [
        '-B',
        '-m',
        domain ? 'harness2.earthnano_domain' : 'harness2.earthnano',
        '--config',
        configPath
      ],
      cwd: options.harnessRoot,
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        PYTHONPATH: options.harnessRoot,
        PYTHONDONTWRITEBYTECODE: '1',
        HOME: options.workRoot
      },
      timeoutMs,
      signal,
      ...(domain ? { acceptPartial: true } : {})
    })
    if (
      !methodResult ||
      typeof methodResult !== 'object' ||
      !['ok', ...(domain ? ['partial'] : [])].includes(
        (methodResult as { status?: string }).status ?? ''
      )
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
    if (domain) {
      const domainBinding = binding as HarnessDomainBinding
      const recordsForTask = (taskId: string): ExecutionRecord[] => {
        const ids = domainBinding.executionIdsForTask(taskId)
        return records.filter((record) => ids.includes(record.executionId))
      }
      domainSummary = await prepareDomainSummary({
        result: methodResult,
        domain,
        taskIds: tasks.map((task) => task.taskId),
        recordsForTask,
        snapshots,
        owners
      })
      await writeFile(
        join(options.workRoot, 'experiment-library.json'),
        JSON.stringify({
          schemaVersion: 1,
          scope: 'experiment',
          library: (methodResult as DomainMethodResult).library,
          provenance: domainSummary
        }),
        { mode: 0o600, flag: 'wx' }
      )
      publish()
      if ((methodResult as DomainMethodResult).status !== 'ok')
        throw new Error('Domain method retained partial evidence; configuration adoption blocked')
    }
    let assessments:
      { baseline: SemanticAssessmentSummary; candidate: SemanticAssessmentSummary } | undefined
    if (semanticCriteria !== undefined) {
      signal.throwIfAborted()
      stage = 'assessing'
      publish()
      for (const task of tasks) {
        const ownRecords = domain
          ? records.filter((record) =>
              (binding as HarnessDomainBinding)
                .executionIdsForTask(task.taskId)
                .includes(record.executionId)
            )
          : records
        const ownMethod = domain
          ? (methodResult as DomainMethodResult).tasks.find((row) => row.taskId === task.taskId)!
          : methodResult
        const taskAssessments = await evaluateOptimizationSemantics({
          core,
          snapshots,
          owners,
          input: task.input,
          records: ownRecords,
          methodResult: ownMethod,
          projectId: options.projectId,
          optimizationId,
          taskId: task.taskId,
          budgetRef: optimizationId,
          criteria: task.criteria!,
          timeoutMs: executionTimeoutMs,
          signal
        })
        const taskOutcome = await evaluateResearchOutcome({
          records: ownRecords,
          methodResult: ownMethod,
          owners,
          assessments: taskAssessments,
          checks: task.checks,
          signal
        })
        if (domainSummary) {
          const summary = domainSummary.tasks.find((row) => row.taskId === task.taskId)!
          summary.assessments = taskAssessments
          summary.outcome = taskOutcome
        }
        if (!domain && task === tasks[0]) {
          assessments = taskAssessments
          outcome = taskOutcome
        }
        await writeFile(
          join(options.workRoot, `outcome-${task.taskId}.json`),
          canonicalOutput({
            taskId: task.taskId,
            assessments: taskAssessments,
            outcome: taskOutcome,
            configurationPublication: 'not-published'
          }),
          { mode: 0o600, flag: 'wx' }
        )
        publish()
      }
    }
    result = {
      optimizationId,
      methodResult,
      records: Object.values(store.load().records),
      ...(assessments ? { assessments } : {}),
      ...(outcome ? { outcome } : {}),
      ...(domainSummary ? { domain: domainSummary } : {})
    }
  } finally {
    try {
      await binding?.stop()
      const cleanup = owners ? await owners.shutdown() : { reaped: true }
      const settled = (await core?.settle()) ?? true
      const state = store.load()
      stage = 'settled'
      publish()
      const safeToUnlock =
        cleanup.reaped &&
        settled &&
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
