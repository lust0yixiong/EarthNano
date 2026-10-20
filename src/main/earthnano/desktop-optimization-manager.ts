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
import { runPersistentOptimization } from './run-persistent-optimization'
import { normalizeOptimizationArtifactInputs } from '../../shared/earthnano/optimization-input'

export interface DesktopOptimizationManagerOptions {
  root: string
  /** Resolve the current data root only after acquiring its lifetime writer lease. */
  executionRoot?: () => string
  validateSession(projectId: string, sessionId: string): Promise<void>
  createOptions(request: StartDesktopOptimization): Promise<
    PersistentOptimizationOptions & {
      releaseAdmission?: () => void | Promise<void>
    }
  >
  /** Test seam only. Production always uses the original persisted method composition. */
  run?: typeof runPersistentOptimization
}
/** Only fixed, application-authored setup messages may cross the desktop boundary. */
export class DesktopOptimizationSetupError extends Error {}

interface SavedRun {
  digest: string
  requestKey: string
  progress: OptimizationProgress
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
        !entry.digest
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

  start(request: StartDesktopOptimization): Promise<OptimizationProgress> {
    const captured = structuredClone(request)
    const result = this.admission.then(async () => {
      validate(captured)
      await this.options.validateSession(captured.projectId, captured.sourceSessionId)
      if (this.closing || this.updateGate) throw new Error('Optimization admission is closed')
      const digest = createHash('sha256')
        .update(
          JSON.stringify({
            projectId: captured.projectId,
            sourceSessionId: captured.sourceSessionId,
            requestKey: captured.requestKey,
            prompt: captured.prompt,
            files: captured.files.map((file) => ({ path: file.path, content: file.content })),
            ...(captured.inputArtifacts === undefined
              ? {}
              : { inputArtifacts: normalizeOptimizationArtifactInputs(captured.inputArtifacts) }),
            criteria: captured.criteria,
            executionLimit: captured.executionLimit,
            ...(captured.method === undefined
              ? {}
              : { method: normalizeOptimizationMethod(captured.method) }),
            ...(captured.checks === undefined
              ? {}
              : { checks: normalizeOutputChecks(captured.checks) }),
            ...(captured.domain === undefined
              ? {}
              : { domain: normalizeOptimizationDomain(captured.domain) })
          })
        )
        .digest('hex')
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
        digest,
        requestKey: captured.requestKey,
        progress: {
          runId,
          projectId: captured.projectId,
          sourceSessionId: captured.sourceSessionId,
          method: normalizeOptimizationMethod(captured.method),
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
    return structuredClone(this.require(request).progress)
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
    return entries[0] ? structuredClone(entries[0].progress) : null
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
    request: StartDesktopOptimization,
    controller: AbortController
  ): Promise<void> {
    let prepared:
      Awaited<ReturnType<DesktopOptimizationManagerOptions['createOptions']>> | undefined
    let last: PersistentOptimizationProgress | undefined
    let workRoot: string | undefined
    try {
      controller.signal.throwIfAborted()
      prepared = await this.options.createOptions(request)
      controller.signal.throwIfAborted()
      if (prepared.inputArtifacts)
        saved.progress.inputArtifacts = structuredClone(prepared.inputArtifacts)
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
        const records = progress.records
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
      const result = await (this.options.run ?? runPersistentOptimization)({
        ...prepared,
        projectId: request.projectId,
        taskId: saved.progress.runId,
        workRoot,
        executionLimit: request.executionLimit,
        method: normalizeOptimizationMethod(request.method),
        ...(request.checks === undefined ? {} : { checks: normalizeOutputChecks(request.checks) }),
        ...(request.domain === undefined
          ? {}
          : { domain: prepared.domain ?? normalizeOptimizationDomain(request.domain) }),
        semanticCriteria: request.criteria,
        signal: controller.signal,
        onProgress: projectProgress
      })
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
      if (!result.assessments && !research.domain)
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
