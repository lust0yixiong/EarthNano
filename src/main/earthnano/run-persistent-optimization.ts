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
import {
  OptimizationResumeIndex,
  optimizationMethodDigest,
  readPersistentOptimizationResume,
  writeResumeJson,
  reuseAssessmentRequest,
  type OptimizationResumeIdentity
} from './optimization-resume'
export { readPersistentOptimizationResume } from './optimization-resume'
import { FileExecutionStore } from './execution-store'
import {
  persistCandidateOwnerSettlement,
  assertNoUnadoptedCandidateCompletion
} from './candidate-settlement-witness'
export {
  reconcilePersistentOptimization,
  type OptimizationReconciliationResult
} from './optimization-reconciliation'
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
  recordOptimizationFailure,
  type OptimizationFailureStage
} from './optimization-failure-diagnostics'
import {
  createPersistentCandidateOwners,
  type PersistentCandidateOwnersOptions
} from './persistent-candidate-owner'
import type { ResolvedOptimizationSweep } from './sweep-contract'
import {
  MAX_SWEEP_EXECUTIONS,
  type OptimizationSweepSummary
} from '../../shared/earthnano/optimization-sweep'
import { sweepTasks } from './sweep-input'
import { previewOptimizationSweep } from './sweep-plan'
import { prepareSweepSummary, sweepModeToken, type SweepMethodResult } from './sweep-results'

export interface PersistentOptimizationProgress {
  optimizationId: string
  stage: 'optimizing' | 'assessing' | 'settled'
  records: ExecutionRecord[]
  outcome?: ResearchOutcome
  domain?: DomainOptimizationSummary
  sweep?: OptimizationSweepSummary
}

export interface PersistentSingleOptimizationOptions {
  sweep?: never
  /** Existing project identity in the original OpenScience repositories. */
  projectId: string
  sourceSessionId?: string
  sourcePromptMessageId?: string
  taskId: string
  input: CandidateSnapshotInput
  /** Host-verified immutable source provenance; never an authority to read files. */
  inputArtifacts?: OptimizationArtifactInput[]
  /** New exclusive run directory; an existing directory requires explicit resume. */
  workRoot: string
  /** Explicit user continuation of this exact run; never automatic or a budget increase. */
  resume?: true
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
/** Same lifecycle, journal, owners and Core; the catalog replaces the single-task payload. */
export type PersistentSweepOptimizationOptions = Omit<
  PersistentSingleOptimizationOptions,
  | 'sweep'
  | 'input'
  | 'inputArtifacts'
  | 'sourcePromptMessageId'
  | 'method'
  | 'semanticCriteria'
  | 'checks'
  | 'domain'
> & {
  sweep: ResolvedOptimizationSweep
  input?: never
  inputArtifacts?: never
  sourcePromptMessageId?: never
  method?: never
  semanticCriteria?: never
  checks?: never
  domain?: never
}
export type PersistentOptimizationOptions =
  PersistentSingleOptimizationOptions | PersistentSweepOptimizationOptions

/** Opt-in production composition. Existing Session/Artifact/Review owners remain authoritative.
 * A fresh invocation is required; interruption never silently replays a paid model request. */
export interface PersistentOptimizationResult {
  optimizationId: string
  methodResult: unknown
  records: ExecutionRecord[]
  assessments?: { baseline: SemanticAssessmentSummary; candidate: SemanticAssessmentSummary }
  outcome?: ResearchOutcome
  domain?: DomainOptimizationSummary
  sweep?: OptimizationSweepSummary
}
export async function runPersistentOptimization(
  options: PersistentOptimizationOptions
): Promise<PersistentOptimizationResult> {
  if (options.resume !== undefined && options.resume !== true)
    throw new Error('Optimization resume requires explicit true')
  options.signal?.throwIfAborted()
  const sweep = options.sweep ? structuredClone(options.sweep) : undefined
  if (
    sweep &&
    (sweep.request.projectId !== options.projectId ||
      sweep.request.sourceSessionId !== options.sourceSessionId ||
      sweep.request.executionLimit !== options.executionLimit)
  )
    throw new Error('Sweep request belongs to another experiment authority')
  if (
    sweep &&
    [
      options.input,
      options.method,
      options.domain,
      options.semanticCriteria,
      options.checks,
      options.inputArtifacts,
      options.sourcePromptMessageId
    ].some((item) => item !== undefined)
  )
    throw new Error('Sweep replaces the single task definition; mixed authorities refused')
  const method = sweep
    ? {
        mode: sweep.plan.options.modes[0],
        k: sweep.plan.options.k,
        concurrency: sweep.plan.options.concurrency
      }
    : normalizeOptimizationMethod(options.method)
  const selectedTasks = sweep ? sweepTasks(sweep) : undefined
  const input = structuredClone(selectedTasks ? selectedTasks[0]!.input : options.input!)
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
  const scientific = input.harness.tools === 'notebook-python'
  if (
    !sweep &&
    scientific &&
    (!options.sourcePromptMessageId ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(options.sourcePromptMessageId))
  )
    throw new Error('Notebook source message identity missing')
  if (
    !sweep &&
    scientific &&
    (!input.task.managedInputs?.length ||
      !input.environment.notebook ||
      input.task.files.length ||
      inputArtifacts?.length ||
      (!sweep && domain) ||
      !sourceSessionId ||
      !options.ownerOptions.notebook)
  )
    throw new Error(
      'Notebook optimization requires one original fixed-input task and runtime owner'
    )
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.taskId) || options.taskId.endsWith('.'))
    throw new Error('Invalid optimization task identifier')
  if (domain && semanticCriteria === undefined)
    throw new Error('Domain optimization requires independent criteria')
  const tasks =
    selectedTasks ??
    (domain
      ? [
          { taskId: options.taskId + '-0001', input, criteria: semanticCriteria!, checks },
          ...domain.nextTasks.map((task, index) => ({
            taskId: `${options.taskId}-${String(index + 2).padStart(4, '0')}`,
            input: { ...input, task: { prompt: task.prompt, files: task.files } },
            criteria: task.criteria,
            checks: task.checks
          }))
        ]
      : [{ taskId: options.taskId, input, criteria: semanticCriteria, checks }])
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
    limit > (sweep ? MAX_SWEEP_EXECUTIONS : MAX_OPTIMIZATION_EXECUTIONS) ||
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
  if (sweep) {
    if (
      sweep.tasks.some((task) => task.input.harness.tools === 'notebook-python') &&
      !options.ownerOptions.notebook
    )
      throw new Error('Sweep Notebook tasks require the original runtime owner')
    const currentPlan = await previewOptimizationSweep({
      catalog: sweep.plan.catalog,
      options: sweep.plan.options,
      python: options.python ?? 'python3',
      harnessRoot: options.harnessRoot,
      signal
    })
    if (canonicalOutput(currentPlan) !== canonicalOutput(sweep.plan))
      throw new Error('Original sweep plan changed before admission')
  }
  const identity = JSON.parse(
    JSON.stringify(
      sweep
        ? {
            projectId: options.projectId,
            sourceSessionId: options.sourceSessionId,
            taskId: options.taskId,
            sweep,
            executionLimit: limit,
            executionTimeoutMs
          }
        : {
            projectId: options.projectId,
            sourceSessionId: options.sourceSessionId,
            sourcePromptMessageId: options.sourcePromptMessageId,
            taskId: options.taskId,
            input,
            inputArtifacts,
            method,
            semanticCriteria,
            checks,
            domain,
            executionLimit: limit,
            executionTimeoutMs
          }
    )
  ) as OptimizationResumeIdentity
  const methodDigest = optimizationMethodDigest(options.harnessRoot)
  const saved = options.resume ? readPersistentOptimizationResume(options.workRoot) : undefined
  if (
    saved &&
    (saved.methodDigest !== methodDigest ||
      canonicalOutput(saved.identity) !== canonicalOutput(identity))
  )
    throw new Error('Optimization resume identity changed; paid replay refused')
  if (!options.resume) await mkdir(options.workRoot, { mode: 0o700 })
  const optimizationId = saved?.optimizationId ?? randomUUID()
  if (!saved)
    writeResumeJson(join(options.workRoot, 'resume.json'), {
      schemaVersion: sweep ? 2 : 1,
      optimizationId,
      identity,
      identityDigest: outputDigest(identity),
      methodDigest
    })
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
  let sweepSummary: OptimizationSweepSummary | undefined
  const publish = (): void => {
    options.onProgress?.({
      optimizationId,
      stage,
      records: Object.values(store.load().records),
      ...(outcome ? { outcome: structuredClone(outcome) } : {}),
      ...(domainSummary ? { domain: structuredClone(domainSummary) } : {}),
      ...(sweepSummary ? { sweep: structuredClone(sweepSummary) } : {})
    })
  }
  let resumeIndex: OptimizationResumeIndex
  let previousRecords: ExecutionRecord[] = []
  const writeProjection = async (path: string, body: string): Promise<void> => {
    if (options.resume) writeResumeJson(path, JSON.parse(body))
    else await writeFile(path, body, { mode: 0o600, flag: 'wx' })
  }
  let result: PersistentOptimizationResult | undefined
  let cleanupConfirmed = false
  let core: ExecutionCore | undefined
  let binding: HarnessOptimizationBinding | HarnessDomainBinding | undefined
  let owners: ReturnType<typeof createPersistentCandidateOwners> | undefined
  let failureStage: OptimizationFailureStage = 'resume-validation'
  const rethrowCleanupFailure = (error: unknown): never => {
    recordOptimizationFailure(options.workRoot, 'cleanup', error)
    throw error
  }
  try {
    resumeIndex = new OptimizationResumeIndex(
      join(options.workRoot, 'request-tasks.json'),
      !!options.resume,
      sweep?.plan.bindingIdentity
    )
    previousRecords = Object.values(store.load().records)
    if (options.resume) {
      resumeIndex.validate(previousRecords)
      assertNoUnadoptedCandidateCompletion(options.workRoot, previousRecords)
      if (
        previousRecords.some(
          (record) =>
            record.request.projectId !== options.projectId ||
            record.request.origin.optimizationId !== optimizationId ||
            record.request.budgetRef !== optimizationId
        )
      )
        throw new Error('Optimization resume journal belongs to another experiment')
      // Re-authorize the exact original provider/model/runtime even when all stages are cached.
      await options.binding(structuredClone(input.agent))
      signal.throwIfAborted()
    }
    failureStage = 'input-projection'
    if (sweep)
      await writeProjection(
        join(options.workRoot, 'sweep-sources.json'),
        canonicalOutput({
          schemaVersion: 2,
          tasks: selectedTasks!.map((task) => ({
            taskId: task.taskId,
            domain: task.domain,
            sourceSessionId: task.sourceSessionId,
            sourcePromptMessageId: task.sourcePromptMessageId,
            inputArtifacts: task.inputArtifacts,
            task: task.input.task,
            environment: task.input.environment
          }))
        })
      )
    if (!sweep && scientific)
      await writeProjection(
        join(options.workRoot, 'notebook-task.json'),
        canonicalOutput({
          schemaVersion: 1,
          projectId: options.projectId,
          sourceSessionId,
          sourcePromptMessageId: options.sourcePromptMessageId,
          task: input.task,
          environment: input.environment
        })
      )
    if (inputArtifacts?.length)
      await writeProjection(
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
        })
      )
    if (sweep || semanticCriteria !== undefined)
      await writeProjection(
        join(options.workRoot, 'assessment-plan.json'),
        JSON.stringify({
          schemaVersion: sweep ? 2 : 1,
          ...(method.k > 1 ? { baselineStageId: 'base1' } : {}),
          ...(semanticCriteria === undefined
            ? {}
            : {
                criteria: semanticCriteria,
                criteriaDigest: semanticDigest(semanticCriteria)
              }),
          ...(checks ? { checks } : {}),
          ...(domain || sweep
            ? {
                tasks: tasks.map((task) => ({
                  taskId: task.taskId,
                  criteria: task.criteria,
                  checks: task.checks
                }))
              }
            : {})
        })
      )
    failureStage = 'owner-validation'
    owners = createPersistentCandidateOwners(options.ownerOptions)
    if (options.resume) {
      for (const record of previousRecords) {
        signal.throwIfAborted()
        if (record.phase !== 'completed') continue
        await owners.exportResult(record)
        const reviews = await owners.readReviews(record)
        if (
          !reviews.length ||
          reviews.some((review) => review.lifecycle !== 'complete' || review.outcome !== 'pass')
        )
          throw new Error('Completed optimization evidence changed before resume')
      }
    }
    failureStage = 'snapshot-validation'
    const snapshots = await createCandidateSnapshotStore({
      root: join(options.workRoot, 'snapshots'),
      candidatesRoot: join(options.workRoot, 'candidates')
    })
    // Freeze every selected payload before the first paid admission. One invalid late task
    // must not be discovered after sibling domains have already consumed model calls.
    if (sweep) for (const task of tasks) await snapshots.freeze(task.input)
    if (options.resume)
      for (const record of previousRecords) {
        signal.throwIfAborted()
        await snapshots.resolve(record.request)
      }
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
        openOwner: owners.openOwner,
        ownerSettled: async (settlement) => {
          const original = await core!.get(settlement.executionId)
          await persistCandidateOwnerSettlement(options.workRoot, {
            ...settlement,
            identity: original.identity
          })
        }
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
    const taskBindingOptions = (
      task: (typeof tasks)[number]
    ): import('./harness-optimization').HarnessOptimizationBindingOptions => ({
      ...bindingOptions,
      input: task.input,
      taskId: task.taskId,
      ...(sweep
        ? {
            bindingIdentity: sweep.plan.bindingIdentity,
            coreConcurrency: sweep.plan.options.concurrency,
            resumeScope: (key: string) => resumeIndex.scope(key)
          }
        : {}),
      ...(options.resume
        ? { resumeRecords: resumeIndex.recordsForTask(task.taskId, previousRecords) }
        : {}),
      resumeSlot: (key) => resumeIndex.slot(key),
      onFreeze: (request, slot, scope?: string) =>
        resumeIndex.remember(task.taskId, request, slot, scope)
    })
    binding =
      domain || sweep
        ? new HarnessDomainBinding(tasks.map(taskBindingOptions))
        : new HarnessOptimizationBinding(taskBindingOptions(tasks[0]))
    const config = {
      configVersion: sweep ? 2 : 1,
      ...(options.resume ? { resume: true } : {}),
      ...(sweep
        ? {
            bindingIdentity: sweep.plan.bindingIdentity,
            catalog: sweep.plan.catalog,
            tasks: selectedTasks!.map((task) => ({ taskId: task.taskId, task: task.input.task })),
            stream: sweep.plan.options.stream,
            expectedDomains: sweep.plan.domains,
            catalogDigest: sweep.plan.catalogDigest,
            planDigest: sweep.plan.digest
          }
        : {
            method,
            ...(domain
              ? {
                  domain: domain.name,
                  tasks: tasks.map((task) => ({ taskId: task.taskId, task: task.input.task }))
                }
              : { taskId: options.taskId, task: input.task })
          }),
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
    await writeProjection(configPath, JSON.stringify(config))
    failureStage = 'method-process'
    const methodResult = await runHarnessProcess({
      binding,
      python: options.python ?? 'python3',
      args: [
        '-B',
        '-m',
        sweep
          ? 'harness2.earthnano_sweep'
          : domain
            ? 'harness2.earthnano_domain'
            : 'harness2.earthnano',
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
      ...(domain || sweep ? { acceptPartial: true } : {})
    })
    failureStage = 'method-result'
    if (
      !methodResult ||
      typeof methodResult !== 'object' ||
      !['ok', ...(domain || sweep ? ['partial'] : [])].includes(
        (methodResult as { status?: string }).status ?? ''
      )
    )
      throw new Error('Harness method did not adopt a valid final result')
    failureStage = 'execution-integrity'
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
    if (sweep) {
      failureStage = 'domain-summary'
      const taskRecords = (taskId: string): ExecutionRecord[] =>
        records.filter((record) =>
          (binding as HarnessDomainBinding).executionIdsForTask(taskId).includes(record.executionId)
        )
      sweepSummary = await prepareSweepSummary({
        result: methodResult,
        plan: sweep.plan,
        recordsForTask: taskRecords,
        recordsForMode: (taskId, mode) =>
          resumeIndex.recordsForScope(
            taskId,
            sweep.plan.bindingIdentity.modeScopes[sweepModeToken(mode)]!,
            taskRecords(taskId)
          ),
        snapshots,
        owners
      })
      await writeProjection(
        join(options.workRoot, 'experiment-libraries.json'),
        canonicalOutput({
          schemaVersion: 2,
          scope: 'experiment',
          libraries: (methodResult as SweepMethodResult).libraries,
          provenance: sweepSummary
        })
      )
      publish()
      if ((methodResult as SweepMethodResult).status !== 'ok')
        throw new Error('Sweep retained partial evidence; configuration adoption blocked')
    } else if (domain) {
      const domainBinding = binding as HarnessDomainBinding
      const recordsForTask = (taskId: string): ExecutionRecord[] => {
        const ids = domainBinding.executionIdsForTask(taskId)
        return records.filter((record) => ids.includes(record.executionId))
      }
      failureStage = 'domain-summary'
      domainSummary = await prepareDomainSummary({
        result: methodResult,
        domain,
        taskIds: tasks.map((task) => task.taskId),
        recordsForTask,
        snapshots,
        owners
      })
      await writeProjection(
        join(options.workRoot, 'experiment-library.json'),
        JSON.stringify({
          schemaVersion: 1,
          scope: 'experiment',
          library: (methodResult as DomainMethodResult).library,
          provenance: domainSummary
        })
      )
      publish()
      if ((methodResult as DomainMethodResult).status !== 'ok')
        throw new Error('Domain method retained partial evidence; configuration adoption blocked')
    }
    let assessments:
      { baseline: SemanticAssessmentSummary; candidate: SemanticAssessmentSummary } | undefined
    if (sweep || semanticCriteria !== undefined) {
      signal.throwIfAborted()
      stage = 'assessing'
      publish()
      const evaluations = sweep
        ? selectedTasks!.flatMap((task) => sweep.plan.options.modes.map((mode) => ({ task, mode })))
        : tasks.map((task) => ({ task, mode: undefined }))
      for (const { task, mode } of evaluations) {
        const taskRecords =
          domain || sweep
            ? records.filter((record) =>
                (binding as HarnessDomainBinding)
                  .executionIdsForTask(task.taskId)
                  .includes(record.executionId)
              )
            : records
        const ownRecords = sweep
          ? resumeIndex.recordsForScope(
              task.taskId,
              sweep.plan.bindingIdentity.modeScopes[sweepModeToken(mode!)]!,
              taskRecords
            )
          : taskRecords
        const ownMethod = sweep
          ? (methodResult as SweepMethodResult).tasks.find((row) => row.taskId === task.taskId)!
              .modes[sweepModeToken(mode!)]!
          : domain
            ? (methodResult as DomainMethodResult).tasks.find((row) => row.taskId === task.taskId)!
            : methodResult
        failureStage = 'semantic-assessment'
        const taskAssessments = await evaluateOptimizationSemantics({
          core,
          ...(options.resume || sweep
            ? {
                reuseRequest: (request) =>
                  reuseAssessmentRequest(Object.values(store.load().records), request)
              }
            : {}),
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
        failureStage = 'research-verification'
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
        if (sweepSummary) {
          const summary = sweepSummary.domains
            .find(
              (entry) =>
                entry.mode === mode &&
                entry.summary.name === ('domain' in task ? task.domain : undefined)
            )!
            .summary.tasks.find((entry) => entry.taskId === task.taskId)!
          summary.assessments = taskAssessments
          summary.outcome = taskOutcome
        }
        if (!domain && !sweep && task === tasks[0]) {
          assessments = taskAssessments
          outcome = taskOutcome
        }
        failureStage = 'result-projection'
        await writeProjection(
          join(
            options.workRoot,
            `outcome-${task.taskId}${mode ? `-${sweepModeToken(mode)}` : ''}.json`
          ),
          canonicalOutput({
            taskId: task.taskId,
            ...(mode ? { mode } : {}),
            assessments: taskAssessments,
            outcome: taskOutcome,
            configurationPublication: 'not-published'
          })
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
      ...(domainSummary ? { domain: domainSummary } : {}),
      ...(sweepSummary ? { sweep: sweepSummary } : {})
    }
  } catch (error) {
    recordOptimizationFailure(
      options.workRoot,
      failureStage,
      error,
      options.signal?.aborted ? 'cancelled' : deadline.aborted ? 'deadline' : 'stage-failed'
    )
    throw error
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
      if (!safeToUnlock)
        recordOptimizationFailure(options.workRoot, 'cleanup', undefined, 'cleanup-unconfirmed')
      if (safeToUnlock) store.close()
    } catch (error) {
      rethrowCleanupFailure(error)
    } finally {
      core?.dispose()
    }
  }
  if (!cleanupConfirmed) {
    throw new Error('Optimization cleanup requires reconciliation')
  }
  return result!
}
