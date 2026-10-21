import { defaultSynchronousFileDurability } from '@aipoch/durable-files'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { ExecutionRecord, ExecutionRequest } from '../../shared/earthnano/execution-port'
import { canonicalOutput, outputDigest } from './output-checks'
import { requestDigest, validateRecord } from './execution-contract'
import type { OptimizationTaskInput } from './optimization-task-contract'
import type { ResolvedOptimizationSweep } from './sweep-contract'
import { assertHarnessBindingV2Identity, type HarnessBindingV2Identity } from './harness-binding-v2'

export type SingleOptimizationResumeIdentity = Pick<
  OptimizationTaskInput,
  | 'projectId'
  | 'sourceSessionId'
  | 'sourcePromptMessageId'
  | 'taskId'
  | 'input'
  | 'inputArtifacts'
  | 'semanticCriteria'
  | 'checks'
  | 'domain'
> & {
  sweep?: never
  method: NonNullable<OptimizationTaskInput['method']>
  executionLimit: number
  executionTimeoutMs: number
}
export interface SweepOptimizationResumeIdentity {
  projectId: string
  sourceSessionId?: string
  taskId: string
  sweep: ResolvedOptimizationSweep
  executionLimit: number
  executionTimeoutMs: number
}
export type OptimizationResumeIdentity =
  SingleOptimizationResumeIdentity | SweepOptimizationResumeIdentity
export interface PersistentOptimizationResume {
  schemaVersion: 1 | 2
  optimizationId: string
  identity: OptimizationResumeIdentity
  identityDigest: string
  methodDigest: string
}

/** Pins the actual original scheduler and binding sources, not their workspace location. */
export function optimizationMethodDigest(harnessRoot: string): string {
  const files: Array<{ path: string; content: string }> = []
  const collect = (relative: string): void => {
    for (const entry of readdirSync(join(harnessRoot, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`
      if (entry.isSymbolicLink())
        throw new Error('Optimization method sources must be regular files')
      if (entry.isDirectory() && entry.name !== '__pycache__') collect(path)
      else if (entry.isFile() && entry.name.endsWith('.py'))
        files.push({ path, content: readFileSync(join(harnessRoot, path), 'utf8') })
    }
  }
  collect('harness2')
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  if (!files.length) throw new Error('Optimization method sources unavailable')
  return outputDigest(files)
}

export function writeResumeJson(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`
  const handle = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(handle, canonicalOutput(value))
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  try {
    renameSync(temp, path)
    defaultSynchronousFileDurability.syncDirectory(dirname(path))
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      /* The durable owner retains the original file. */
    }
    throw error
  }
}

export function readPersistentOptimizationResume(workRoot: string): PersistentOptimizationResume {
  const value = JSON.parse(
    readFileSync(join(workRoot, 'resume.json'), 'utf8')
  ) as PersistentOptimizationResume
  if (
    ![1, 2].includes(value.schemaVersion) ||
    !value.identity ||
    typeof value.optimizationId !== 'string' ||
    !value.optimizationId ||
    typeof value.methodDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.methodDigest) ||
    value.identityDigest !== outputDigest(value.identity)
  )
    throw new Error('Optimization resume manifest is unavailable or changed')
  if (value.schemaVersion === 2) {
    if (!value.identity.sweep) throw new Error('Sweep resume identity is unavailable')
    assertHarnessBindingV2Identity(
      value.identity.sweep.plan.bindingIdentity,
      value.identity.sweep.plan.bindingIdentity
    )
  } else if (value.identity.sweep) {
    throw new Error('Legacy resume identity cannot acquire sweep authority')
  }
  return value
}

/** A task/request routing index, never an execution or completion authority. Journal records and
 * original fixed-version owners must independently validate every cache hit. */
export class OptimizationResumeIndex {
  private readonly entries: Record<string, { taskId: string; slot: string; scope?: string }>
  constructor(
    private readonly filename: string,
    resume: boolean,
    private readonly bindingIdentity?: HarnessBindingV2Identity
  ) {
    const saved = resume ? JSON.parse(readFileSync(filename, 'utf8')) : undefined
    if (
      resume &&
      (!saved ||
        saved.schemaVersion !== (bindingIdentity ? 2 : 1) ||
        !saved.entries ||
        saved.digest !== outputDigest(saved.entries))
    )
      throw new Error('Optimization request routing index changed')
    if (bindingIdentity) {
      assertHarnessBindingV2Identity(
        bindingIdentity,
        resume ? saved.bindingIdentity : bindingIdentity
      )
    } else if (saved?.bindingIdentity !== undefined) {
      throw new Error('Legacy request index cannot acquire sweep authority')
    }
    this.entries = saved?.entries ?? {}
    if (
      !this.entries ||
      typeof this.entries !== 'object' ||
      Array.isArray(this.entries) ||
      Object.values(this.entries).some(
        (entry) =>
          !entry ||
          typeof entry.taskId !== 'string' ||
          !entry.taskId ||
          typeof entry.slot !== 'string' ||
          !entry.slot ||
          (bindingIdentity
            ? typeof entry.scope !== 'string' ||
              ![bindingIdentity.baseScope, ...Object.values(bindingIdentity.modeScopes)].includes(
                entry.scope
              )
            : entry.scope !== undefined)
      )
    )
      throw new Error('Invalid optimization request routing index')
    if (!resume) this.persist()
  }
  remember(taskId: string, request: ExecutionRequest, slot: string, scope?: string): void {
    if (this.bindingIdentity) {
      const allowed =
        request.role === 'baseline'
          ? [this.bindingIdentity.baseScope]
          : Object.values(this.bindingIdentity.modeScopes)
      if (!scope || !allowed.includes(scope))
        throw new Error('Optimization scope ownership changed')
    } else if (scope !== undefined)
      throw new Error('Legacy optimization cannot acquire scope authority')
    const prior = this.entries[request.requestKey]
    if (prior && (prior.taskId !== taskId || prior.slot !== slot || prior.scope !== scope))
      throw new Error('Optimization task ownership changed')
    this.entries[request.requestKey] = { taskId, slot, ...(scope ? { scope } : {}) }
    this.persist()
  }
  private persist(): void {
    writeResumeJson(this.filename, {
      schemaVersion: this.bindingIdentity ? 2 : 1,
      ...(this.bindingIdentity ? { bindingIdentity: this.bindingIdentity } : {}),
      entries: this.entries,
      digest: outputDigest(this.entries)
    })
  }
  recordsForTask(taskId: string, records: ExecutionRecord[]): ExecutionRecord[] {
    return records.filter((record) => this.entries[record.requestKey]?.taskId === taskId)
  }
  slot(requestKey: string): string | undefined {
    return this.entries[requestKey]?.slot
  }
  scope(requestKey: string): string | undefined {
    return this.entries[requestKey]?.scope
  }
  recordsForScope(taskId: string, scope: string, records: ExecutionRecord[]): ExecutionRecord[] {
    if (!this.bindingIdentity || !Object.values(this.bindingIdentity.modeScopes).includes(scope))
      throw new Error('Optimization mode scope is unavailable')
    return this.recordsForTask(taskId, records).filter(
      (record) =>
        this.scope(record.requestKey) === scope ||
        (record.request.role === 'baseline' &&
          this.scope(record.requestKey) === this.bindingIdentity!.baseScope)
    )
  }
  validate(records: ExecutionRecord[]): void {
    for (const record of records) {
      validateRecord(record)
      if (
        record.requestDigest !== requestDigest(record.request) ||
        !['completed', 'failed', 'cancelled'].includes(record.phase) ||
        record.cleanup !== 'confirmed'
      )
        throw new Error('Optimization resources require original reconciliation before resume')
      if (record.request.role !== 'reviewer' && !this.entries[record.requestKey])
        throw new Error('Optimization task ownership is unavailable')
    }
  }
}

export const sameExecutionInputs = (left: ExecutionRequest, right: ExecutionRequest): boolean =>
  canonicalOutput({
    ...left,
    requestKey: '',
    origin: { ...left.origin, retryOfExecutionId: undefined }
  }) ===
  canonicalOutput({
    ...right,
    requestKey: '',
    origin: { ...right.origin, retryOfExecutionId: undefined }
  })

/** Returns an original request only for an exact completed independent assessment. The original
 * evaluator and Core still validate that request, output, evidence and Review before reuse. */
export function reuseAssessmentRequest(
  records: ExecutionRecord[],
  request: ExecutionRequest
): ExecutionRequest {
  if (
    request.role !== 'reviewer' ||
    request.origin.kind !== 'optimization' ||
    !request.origin.stageId?.startsWith('semantic:')
  )
    return request
  const stable = (value: ExecutionRequest): ExecutionRequest => ({
    ...value,
    origin: { ...value.origin, stageId: 'independent-assessment' }
  })
  const prior = records.find(
    (record) =>
      record.request.role === 'reviewer' &&
      record.request.origin.kind === 'optimization' &&
      record.request.origin.stageId?.startsWith('semantic:') &&
      record.phase === 'completed' &&
      record.cleanup === 'confirmed' &&
      sameExecutionInputs(stable(record.request), stable(request))
  )
  return structuredClone(prior?.request ?? request)
}
