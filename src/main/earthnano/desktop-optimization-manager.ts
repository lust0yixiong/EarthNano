import { normalizeDesktopSweep } from './desktop-sweep-validation'
import type { StartDesktopSweep } from '../../shared/earthnano/optimization-sweep'
import { canonicalOutput } from './output-checks'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  fsyncSync
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { summarizeExecutionUsage } from '../../shared/earthnano/execution-usage'
import type {
  DesktopOptimizationApi,
  OptimizationProgress,
  OptimizationRunKey,
  StartDesktopOptimization
} from '../../shared/earthnano/desktop-optimization'
import type {
  PersistentOptimizationOptions,
  PersistentOptimizationProgress
} from './run-persistent-optimization'
import {
  normalizeOptimizationMethod,
  MAX_OPTIMIZATION_EXECUTIONS
} from '../../shared/earthnano/optimization-method'
import {
  normalizeOutputChecks,
  normalizeOptimizationDomain,
  minimumResearchExecutions,
  type ResearchOutcome,
  type DomainOptimizationSummary
} from '../../shared/earthnano/research-outcome'
import {
  runPersistentOptimization,
  readPersistentOptimizationResume
} from './run-persistent-optimization'
import type { PersistentOptimizationResume } from './optimization-resume'
import { normalizeNotebookOptimizationSource } from '../../shared/earthnano/notebook-source'
import { normalizeOptimizationArtifactInputs } from '../../shared/earthnano/optimization-input'

type DesktopRequest = StartDesktopOptimization | StartDesktopSweep
const isSweepRequest = (request: DesktopRequest): request is StartDesktopSweep =>
  'catalog' in request
const validateRequest = (request: DesktopRequest): void => {
  if (isSweepRequest(request)) normalizeDesktopSweep(request)
  else validate(request)
}

export interface DesktopOptimizationManagerOptions {
  root: string
  /** Resolve the current data root only after acquiring its lifetime writer lease. */
  executionRoot?: () => string
  /** Read only immutable resume metadata while holding the original data-root lifetime lease. */
  readResume?(runId: string): Promise<DesktopOptimizationResumeData>
  validateSession(projectId: string, sessionId: string): Promise<void>
  createOptions(
    request: StartDesktopOptimization,
    signal?: AbortSignal
  ): Promise<
    PersistentOptimizationOptions & {
      releaseAdmission?: () => void | Promise<void>
    }
  >
  createSweepOptions?(
    request: StartDesktopSweep,
    signal?: AbortSignal
  ): Promise<PersistentOptimizationOptions & { releaseAdmission?: () => void | Promise<void> }>
  /** Test seam only. Production always uses the original persisted method composition. */
  run?: typeof runPersistentOptimization
}
/** Only fixed, application-authored setup messages may cross the desktop boundary. */
export class DesktopOptimizationSetupError extends Error {}

interface SavedRun {
  kind?: 'sweep-v2'
  digest: string
  requestKey: string
  progress: OptimizationProgress
}
export interface DesktopOptimizationResumeData {
  manifest: PersistentOptimizationResume
  records: Array<{ phase?: string; cleanup?: string }>
}
export function readDesktopOptimizationResume(workRoot: string): DesktopOptimizationResumeData {
  if (existsSync(join(workRoot, 'execution.json.lock')))
    throw new Error('Original experiment still owns its execution journal')
  const manifest = readPersistentOptimizationResume(workRoot)
  const state = JSON.parse(readFileSync(join(workRoot, 'execution.json'), 'utf8')) as {
    records: Record<string, { phase?: string; cleanup?: string }>
  }
  if (!state?.records || typeof state.records !== 'object' || Array.isArray(state.records))
    throw new Error('Original experiment journal unavailable')
  return { manifest, records: Object.values(state.records) }
}
interface ActiveRun {
  controller: AbortController
  done: Promise<void>
}
const terminal = (state: OptimizationProgress['state']): boolean =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(state)
const safeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const safeFile = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 180 &&
  !value.includes('\\') &&
  !value.includes('\0') &&
  value.split('/').every((part) => /^[A-Za-z0-9_. -]+$/.test(part) && part !== '.' && part !== '..')
const validate = (request: StartDesktopOptimization): void => {
  const notebook = normalizeNotebookOptimizationSource(request?.notebook)
  if (notebook && (request.files?.length || request.inputArtifacts?.length || request.domain))
    throw new Error('Notebook source tasks cannot mix alternate inputs')
  const method = normalizeOptimizationMethod(request?.method)
  const domain = normalizeOptimizationDomain(request?.domain)
  normalizeOutputChecks(request?.checks)
  const inputArtifacts = normalizeOptimizationArtifactInputs(request?.inputArtifacts)
  const criteriaLines =
    typeof request?.criteria === 'string'
      ? request.criteria
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : []
  if (
    !request ||
    Object.keys(request).some(
      (key) =>
        ![
          'projectId',
          'sourceSessionId',
          'requestKey',
          'prompt',
          'files',
          'inputArtifacts',
          'notebook',
          'criteria',
          'executionLimit',
          'method',
          'checks',
          'domain'
        ].includes(key)
    ) ||
    !safeId(request.projectId) ||
    !safeId(request.sourceSessionId) ||
    !safeId(request.requestKey) ||
    typeof request.prompt !== 'string' ||
    !request.prompt.trim() ||
    request.prompt.length > 32_000 ||
    typeof request.criteria !== 'string' ||
    !request.criteria.trim() ||
    request.criteria.length > 16_000 ||
    criteriaLines.length < 1 ||
    criteriaLines.length > 16 ||
    criteriaLines.some((line) => line.length > 2000) ||
    !Number.isSafeInteger(request.executionLimit) ||
    request.executionLimit < minimumResearchExecutions(method, domain) ||
    request.executionLimit > MAX_OPTIMIZATION_EXECUTIONS ||
    !Array.isArray(request.files) ||
    request.files.length + (inputArtifacts?.length ?? 0) > 32
  )
    throw new Error('Invalid optimization task or execution limit')
  let size = 0
  const seen = new Set<string>()
  for (const file of request.files) {
    if (
      !file ||
      !safeFile(file.path) ||
      seen.has(file.path.normalize('NFC').toLowerCase()) ||
      typeof file.content !== 'string' ||
      Buffer.byteLength(file.content) > 64_000 ||
      file.content.includes('\0')
    )
      throw new Error('Invalid optimization input file')
    seen.add(file.path.normalize('NFC').toLowerCase())
    size += Buffer.byteLength(file.content)
  }
  if (size > 128_000) throw new Error('Optimization inputs exceed the text profile limit')
  for (const file of inputArtifacts ?? []) {
    const key = file.path.normalize('NFC').toLowerCase()
    if (seen.has(key)) throw new Error('Optimization inputs collide')
    seen.add(key)
  }
  for (const task of domain?.nextTasks ?? [])
    validate({ ...request, ...task, checks: task.checks, domain: undefined })
}

const desktopRequestDigest = (request: StartDesktopOptimization): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        projectId: request.projectId,
        sourceSessionId: request.sourceSessionId,
        requestKey: request.requestKey,
        prompt: request.prompt,
        files: request.files.map((file) => ({ path: file.path, content: file.content })),
        ...(request.inputArtifacts === undefined
          ? {}
          : { inputArtifacts: normalizeOptimizationArtifactInputs(request.inputArtifacts) }),
        ...(request.notebook === undefined
          ? {}
          : { notebook: normalizeNotebookOptimizationSource(request.notebook) }),
        criteria: request.criteria,
        executionLimit: request.executionLimit,
        ...(request.method === undefined
          ? {}
          : { method: normalizeOptimizationMethod(request.method) }),
        ...(request.checks === undefined ? {} : { checks: normalizeOutputChecks(request.checks) }),
        ...(request.domain === undefined
          ? {}
          : { domain: normalizeOptimizationDomain(request.domain) })
      })
    )
    .digest('hex')

const sweepRequestDigest = (request: StartDesktopSweep): string =>
  createHash('sha256')
    .update(canonicalOutput({ schemaVersion: 2, request }))
    .digest('hex')

/** Desktop authority: one explicit user action starts one bounded method. Status is a projection
 * of the shared execution journal; restarting this owner never submits old work again. */
export class DesktopOptimizationManager implements DesktopOptimizationApi {
  private readonly saved = new Map<string, SavedRun>()
  private readonly active = new Map<string, ActiveRun>()
  private admission: Promise<unknown> = Promise.resolve()
  private closing = false
  private updateGate = false

  constructor(private readonly options: DesktopOptimizationManagerOptions) {
    if (!isAbsolute(options.root)) throw new Error('Optimization root must be absolute')
    mkdirSync(options.root, { recursive: true, mode: 0o700 })
    for (const name of readdirSync(options.root)) {
      if (!/^[0-9a-f-]{36}$/.test(name)) continue
      const path = join(options.root, name, 'desktop.json')
      if (!existsSync(path)) continue
      const entry = JSON.parse(readFileSync(path, 'utf8')) as SavedRun
      if (
        entry.progress?.runId !== name ||
        !safeId(entry.progress.projectId) ||
        !safeId(entry.progress.sourceSessionId) ||
        !safeId(entry.requestKey) ||
        !entry.digest ||
        (entry.kind !== undefined && entry.kind !== 'sweep-v2')
      )
        throw new Error('Invalid persisted desktop optimization')
      if (!terminal(entry.progress.state)) {
        entry.progress.state = 'interrupted'
        entry.progress.stage = 'interrupted'
        entry.progress.error = 'Previous work requires reconciliation; it will not be replayed.'
        entry.progress.updatedAt = Date.now()
        this.persist(entry)
      }
      this.saved.set(name, entry)
    }
  }

  hasActiveWork(): boolean {
    return (
      this.active.size > 0 ||
      [...this.saved.values()].some((run) => run.progress.state === 'interrupted')
    )
  }

  async start(request: StartDesktopOptimization): Promise<OptimizationProgress> {
    return this.startRequest(request, false)
  }
  async startSweep(request: StartDesktopSweep): Promise<OptimizationProgress> {
    return this.startRequest(request, true)
  }
  private startRequest(request: DesktopRequest, sweep: boolean): Promise<OptimizationProgress> {
    const original = structuredClone(request)
    const result = this.admission.then(async () => {
      let captured: DesktopRequest
      if (sweep) captured = normalizeDesktopSweep(original)
      else {
        if (isSweepRequest(original)) throw new Error('Invalid optimization profile')
        validate(original as StartDesktopOptimization)
        captured = original as StartDesktopOptimization
      }
      await this.options.validateSession(captured.projectId, captured.sourceSessionId)
      if (this.closing || this.updateGate) throw new Error('Optimization admission is closed')
      const digest = isSweepRequest(captured)
        ? sweepRequestDigest(captured)
        : desktopRequestDigest(captured)
      const prior = [...this.saved.values()].find(
        (entry) =>
          entry.progress.projectId === captured.projectId &&
          entry.requestKey === captured.requestKey
      )
      if (prior) {
        if (prior.digest !== digest)
          throw new Error('Optimization request key conflicts with prior input')
        return structuredClone(prior.progress)
      }
      if (
        [...this.saved.values()].some(
          (entry) =>
            entry.progress.projectId === captured.projectId &&
            (!terminal(entry.progress.state) || entry.progress.state === 'interrupted')
        )
      )
        throw new Error('This project has active or unreconciled optimization work')
      const runId = randomUUID()
      mkdirSync(join(this.options.root, runId), { mode: 0o700 })
      const saved: SavedRun = {
        ...(sweep ? { kind: 'sweep-v2' as const } : {}),
        digest,
        requestKey: captured.requestKey,
        progress: {
          runId,
          projectId: captured.projectId,
          sourceSessionId: captured.sourceSessionId,
          ...(!isSweepRequest(captured)
            ? { method: normalizeOptimizationMethod(captured.method) }
            : {}),
          state: 'queued',
          stage: 'queued',
          updatedAt: Date.now(),
          executions: [],
          budget: { limit: captured.executionLimit, admitted: 0, completed: 0, active: 0 }
        }
      }
      this.persist(saved)
      this.saved.set(runId, saved)
      const controller = new AbortController()
      // Register before createOptions can await, so stop also owns pending provider admission.
      const active = { controller, done: Promise.resolve() }
      this.active.set(runId, active)
      active.done = this.execute(saved, captured, controller).catch(() => {
        // A status disk failure must not become an unhandled background rejection.
        saved.progress.state = 'interrupted'
        saved.progress.stage = 'interrupted'
      })
      return structuredClone(saved.progress)
    })
    this.admission = result.catch(() => undefined)
    return result
  }

  async get(request: OptimizationRunKey): Promise<OptimizationProgress> {
    await this.options.validateSession(request.projectId, request.sourceSessionId)
    return this.snapshot(this.require(request))
  }

  async latest(
    request: Pick<OptimizationRunKey, 'projectId' | 'sourceSessionId'>
  ): Promise<OptimizationProgress | null> {
    await this.options.validateSession(request.projectId, request.sourceSessionId)
    const entries = [...this.saved.values()]
      .filter(
        (entry) =>
          entry.progress.projectId === request.projectId &&
          entry.progress.sourceSessionId === request.sourceSessionId
      )
      .sort((a, b) => b.progress.updatedAt - a.progress.updatedAt)
    return entries[0] ? this.snapshot(entries[0]) : null
  }

  resume(request: OptimizationRunKey): Promise<OptimizationProgress> {
    const captured = structuredClone(request)
    const result = this.admission.then(async () => {
      await this.options.validateSession(captured.projectId, captured.sourceSessionId)
      const saved = this.require(captured)
      if (this.closing || this.updateGate) throw new Error('Optimization admission is closed')
      if (this.active.has(captured.runId)) return this.snapshot(saved)
      if (saved.progress.state === 'completed') return this.snapshot(saved)
      if (!['failed', 'cancelled'].includes(saved.progress.state))
        throw new Error('Original experiment cannot be resumed safely')
      const data = await this.resumeData(saved)
      if (!this.canResume(saved, data))
        throw new Error('Original experiment cannot be resumed safely')
      if (
        [...this.saved.values()].some(
          (entry) =>
            entry !== saved &&
            entry.progress.projectId === captured.projectId &&
            (!terminal(entry.progress.state) || entry.progress.state === 'interrupted')
        )
      )
        throw new Error('This project has active or unreconciled optimization work')
      const original = this.resumeRequest(saved, data.manifest)
      validateRequest(original)
      saved.progress.state = 'queued'
      saved.progress.stage = 'queued'
      delete saved.progress.error
      this.persist(saved)
      const controller = new AbortController()
      const active = { controller, done: Promise.resolve() }
      this.active.set(captured.runId, active)
      active.done = this.execute(saved, original, controller, true).catch(() => {
        saved.progress.state = 'interrupted'
        saved.progress.stage = 'interrupted'
      })
      return this.snapshot(saved)
    })
    this.admission = result.catch(() => undefined)
    return result
  }

  async stop(request: OptimizationRunKey): Promise<OptimizationProgress> {
    await this.options.validateSession(request.projectId, request.sourceSessionId)
    const saved = this.require(request)
    if (!terminal(saved.progress.state)) {
      saved.progress.state = 'stopping'
      saved.progress.stage = 'stopping'
      this.persist(saved)
      this.active.get(request.runId)?.controller.abort()
    }
    return structuredClone(saved.progress)
  }

  async shutdown(): Promise<{ reaped: boolean }> {
    this.closing = true
    await this.admission.catch(() => undefined)
    return this.stopAll()
  }
  async prepareForUpdateGate(): Promise<{ reaped: boolean }> {
    this.updateGate = true
    await this.admission.catch(() => undefined)
    return this.stopAll()
  }
  releaseUpdateGate(): void {
    this.updateGate = false
  }

  private async stopAll(): Promise<{ reaped: boolean }> {
    for (const [id, run] of this.active) {
      const saved = this.saved.get(id)!
      saved.progress.state = 'stopping'
      saved.progress.stage = 'stopping'
      this.persist(saved)
      run.controller.abort()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all([...this.active.values()].map((run) => run.done)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 25_000)
      })
    ])
    if (timer) clearTimeout(timer)
    return { reaped: !this.hasActiveWork() }
  }

  private async execute(
    saved: SavedRun,
    request: DesktopRequest,
    controller: AbortController,
    resume = false
  ): Promise<void> {
    let prepared:
      Awaited<ReturnType<DesktopOptimizationManagerOptions['createOptions']>> | undefined
    let last: PersistentOptimizationProgress | undefined
    let workRoot: string | undefined
    try {
      controller.signal.throwIfAborted()
      if (isSweepRequest(request)) {
        if (!this.options.createSweepOptions)
          throw new DesktopOptimizationSetupError('Sweep optimization is unavailable.')
        prepared = await this.options.createSweepOptions(request, controller.signal)
      } else prepared = await this.options.createOptions(request, controller.signal)
      controller.signal.throwIfAborted()
      if (!resume && prepared.inputArtifacts)
        saved.progress.inputArtifacts = structuredClone(prepared.inputArtifacts)
      if (
        !resume &&
        !isSweepRequest(request) &&
        !prepared.sweep &&
        request.notebook &&
        prepared.input.task.managedInputs &&
        prepared.input.environment.notebook
      )
        saved.progress.notebook = {
          source: request.notebook,
          inputs: structuredClone([...prepared.input.task.managedInputs]),
          runtime: structuredClone(prepared.input.environment.notebook.runtime)
        }
      const executionRoot = this.options.executionRoot?.() ?? this.options.root
      if (!isAbsolute(executionRoot)) throw new Error('Execution root must be absolute')
      mkdirSync(join(executionRoot, saved.progress.runId), { recursive: true, mode: 0o700 })
      workRoot = join(executionRoot, saved.progress.runId, 'execution')
      saved.progress.state = 'running'
      this.persist(saved)
      const projectProgress = (progress: PersistentOptimizationProgress): void => {
        last = structuredClone(progress)
        const research = progress as PersistentOptimizationProgress & {
          outcome?: ResearchOutcome
          domain?: DomainOptimizationSummary
        }
        if (research.outcome) saved.progress.outcome = structuredClone(research.outcome)
        if (research.domain) saved.progress.domain = structuredClone(research.domain)
        if (progress.sweep) saved.progress.sweep = structuredClone(progress.sweep)
        const records = progress.records
        saved.progress.usage = summarizeExecutionUsage(records)
        saved.progress.executions = records.map((record) => ({
          executionId: record.executionId,
          role: record.request.role,
          ...(record.request.origin?.kind === 'optimization'
            ? { stageId: record.request.origin.stageId }
            : {}),
          phase: record.phase,
          ...(record.identity.sessionId ? { sessionId: record.identity.sessionId } : {})
        }))
        saved.progress.budget.admitted = records.length
        saved.progress.budget.completed = records.filter((r) =>
          ['completed', 'failed', 'cancelled', 'interrupted'].includes(r.phase)
        ).length
        saved.progress.budget.active = records.length - saved.progress.budget.completed
        if (saved.progress.state !== 'stopping')
          saved.progress.state = progress.stage === 'assessing' ? 'assessing' : 'running'
        saved.progress.stage =
          saved.progress.state === 'stopping'
            ? 'stopping'
            : (records.findLast(
                (r) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(r.phase)
              )?.request.origin?.stageId ?? progress.stage)
        this.persist(saved)
      }
      const common = {
        ...(resume ? { resume: true as const } : {}),
        projectId: request.projectId,
        taskId: saved.progress.runId,
        workRoot,
        executionLimit: request.executionLimit,
        signal: controller.signal,
        onProgress: projectProgress
      }
      let execution: PersistentOptimizationOptions
      if (prepared.sweep) {
        if (!isSweepRequest(request)) throw new Error('Prepared optimization profile mismatch')
        execution = { ...prepared, ...common }
      } else {
        if (isSweepRequest(request)) throw new Error('Prepared optimization profile mismatch')
        execution = {
          ...prepared,
          ...common,
          method: normalizeOptimizationMethod(request.method),
          ...(request.checks === undefined
            ? {}
            : { checks: normalizeOutputChecks(request.checks) }),
          ...(request.domain === undefined
            ? {}
            : { domain: prepared.domain ?? normalizeOptimizationDomain(request.domain) }),
          semanticCriteria: request.criteria
        }
      }
      const result = await (this.options.run ?? runPersistentOptimization)(execution)
      projectProgress({
        optimizationId: result.optimizationId,
        stage: 'settled',
        records: result.records
      })
      const methodResult = result.methodResult as { selection?: OptimizationProgress['selection'] }
      if (methodResult?.selection)
        saved.progress.selection = structuredClone(methodResult.selection)
      const research = result as typeof result & {
        outcome?: ResearchOutcome
        domain?: DomainOptimizationSummary
      }
      if (research.outcome) saved.progress.outcome = structuredClone(research.outcome)
      if (research.domain) saved.progress.domain = structuredClone(research.domain)
      if (result.sweep) saved.progress.sweep = structuredClone(result.sweep)
      if (!result.assessments && !research.domain && !result.sweep)
        throw new Error('Independent assessments missing')
      if (result.assessments) saved.progress.assessments = result.assessments
      saved.progress.state = controller.signal.aborted ? 'cancelled' : 'completed'
      saved.progress.stage = saved.progress.state
    } catch (error) {
      const unknownCleanup =
        (workRoot ? existsSync(join(workRoot, 'execution.json.lock')) : false) ||
        (last?.records.some((record) => record.cleanup !== 'confirmed') ?? false)
      saved.progress.state = unknownCleanup
        ? 'interrupted'
        : controller.signal.aborted
          ? 'cancelled'
          : 'failed'
      saved.progress.stage = saved.progress.state
      saved.progress.error = unknownCleanup
        ? 'Execution cleanup requires reconciliation.'
        : controller.signal.aborted
          ? 'Optimization stopped.'
          : error instanceof DesktopOptimizationSetupError
            ? error.message
            : 'Optimization or independent assessment failed. Inspect the recorded Sessions.'
    } finally {
      try {
        if (saved.progress.state !== 'interrupted') await prepared?.releaseAdmission?.()
      } catch {
        saved.progress.state = 'interrupted'
        saved.progress.stage = 'interrupted'
      }
      try {
        this.persist(saved)
      } finally {
        this.active.delete(saved.progress.runId)
      }
    }
  }

  private require(request: OptimizationRunKey): SavedRun {
    const value = this.saved.get(request.runId)
    if (
      !value ||
      value.progress.projectId !== request.projectId ||
      value.progress.sourceSessionId !== request.sourceSessionId
    )
      throw new Error('Unknown optimization in this Session')
    return value
  }
  private canResume(saved: SavedRun, data: DesktopOptimizationResumeData): boolean {
    if (
      !['failed', 'cancelled'].includes(saved.progress.state) ||
      this.active.has(saved.progress.runId) ||
      this.closing ||
      this.updateGate
    )
      return false
    return data.records.every(
      (record) =>
        record &&
        ['completed', 'failed', 'cancelled'].includes(record.phase ?? '') &&
        record.cleanup === 'confirmed'
    )
  }
  private async resumeData(saved: SavedRun): Promise<DesktopOptimizationResumeData> {
    if (this.options.readResume) return this.options.readResume(saved.progress.runId)
    if (this.options.executionRoot)
      throw new Error('Moving execution roots require an original lifetime lease')
    return readDesktopOptimizationResume(join(this.options.root, saved.progress.runId, 'execution'))
  }
  private resumeRequest(saved: SavedRun, manifest: PersistentOptimizationResume): DesktopRequest {
    const identity = manifest.identity
    if (
      identity.projectId !== saved.progress.projectId ||
      identity.sourceSessionId !== saved.progress.sourceSessionId ||
      identity.taskId !== saved.progress.runId ||
      identity.executionLimit !== saved.progress.budget.limit
    )
      throw new Error('Original experiment identity differs from its desktop projection')
    if (identity.sweep) {
      const request = normalizeDesktopSweep(identity.sweep.request)
      if (
        request.projectId !== identity.projectId ||
        request.sourceSessionId !== identity.sourceSessionId ||
        request.executionLimit !== identity.executionLimit ||
        request.requestKey !== saved.requestKey ||
        saved.kind !== 'sweep-v2' ||
        sweepRequestDigest(request) !== saved.digest
      )
        throw new Error('Original sweep request differs from its desktop projection')
      return request
    }
    if (saved.kind === 'sweep-v2') throw new Error('Original sweep identity unavailable')
    const artifactPaths = new Set(identity.inputArtifacts?.map((entry) => entry.path) ?? [])
    const rawFiles = (
      files: readonly { path: string; content: string }[]
    ): StartDesktopOptimization['files'] =>
      structuredClone(files.filter((file) => !artifactPaths.has(file.path)))
    return {
      projectId: identity.projectId,
      sourceSessionId: identity.sourceSessionId,
      requestKey: saved.requestKey,
      prompt: identity.input.task.prompt,
      files: rawFiles(identity.input.task.files),
      criteria: identity.semanticCriteria ?? '',
      executionLimit: identity.executionLimit,
      method: identity.method,
      ...(identity.inputArtifacts
        ? { inputArtifacts: structuredClone(identity.inputArtifacts) }
        : {}),
      ...(identity.sourcePromptMessageId
        ? { notebook: { promptMessageId: identity.sourcePromptMessageId } }
        : {}),
      ...(identity.checks ? { checks: structuredClone(identity.checks) } : {}),
      ...(identity.domain
        ? {
            domain: {
              ...structuredClone(identity.domain),
              nextTasks: identity.domain.nextTasks.map((task) => ({
                ...task,
                files: rawFiles(task.files)
              }))
            }
          }
        : {})
    }
  }
  private async snapshot(saved: SavedRun): Promise<OptimizationProgress> {
    const progress = structuredClone(saved.progress)
    delete progress.resumeAvailable
    if (['failed', 'cancelled'].includes(progress.state)) {
      try {
        const data = await this.resumeData(saved)
        if (this.canResume(saved, data)) {
          validateRequest(this.resumeRequest(saved, data.manifest))
          progress.resumeAvailable = true
        }
      } catch {
        // Original pre-Alpha runs and missing/unknown evidence stay inspectable, never auto-replayed.
      }
    }
    return progress
  }
  private persist(saved: SavedRun): void {
    saved.progress.updatedAt = Date.now()
    const path = join(this.options.root, saved.progress.runId, 'desktop.json')
    const temp = `${path}.${randomUUID()}.tmp`
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify(saved))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
    for (const directory of [join(this.options.root, saved.progress.runId), this.options.root]) {
      const handle = openSync(directory, 'r')
      try {
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
    }
  }
}
