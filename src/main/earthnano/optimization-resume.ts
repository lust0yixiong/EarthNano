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
import type { PersistentOptimizationOptions } from './run-persistent-optimization'

export type OptimizationResumeIdentity = Pick<
  PersistentOptimizationOptions,
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
  method: NonNullable<PersistentOptimizationOptions['method']>
  executionLimit: number
  executionTimeoutMs: number
}
export interface PersistentOptimizationResume {
  schemaVersion: 1
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
    const parent = openSync(dirname(path), 'r')
    try {
      fsyncSync(parent)
    } finally {
      closeSync(parent)
    }
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
    value.schemaVersion !== 1 ||
    !value.identity ||
    typeof value.optimizationId !== 'string' ||
    !value.optimizationId ||
    typeof value.methodDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.methodDigest) ||
    value.identityDigest !== outputDigest(value.identity)
  )
    throw new Error('Optimization resume manifest is unavailable or changed')
  return value
}

/** A task/request routing index, never an execution or completion authority. Journal records and
 * original fixed-version owners must independently validate every cache hit. */
export class OptimizationResumeIndex {
  private readonly entries: Record<string, { taskId: string; slot: string }>
  constructor(
    private readonly filename: string,
    resume: boolean
  ) {
    const saved = resume ? JSON.parse(readFileSync(filename, 'utf8')) : undefined
    if (
      resume &&
      (!saved ||
        saved.schemaVersion !== 1 ||
        !saved.entries ||
        saved.digest !== outputDigest(saved.entries))
    )
      throw new Error('Optimization request routing index changed')
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
          !entry.slot
      )
    )
      throw new Error('Invalid optimization request routing index')
    if (!resume) this.persist()
  }
  remember(taskId: string, request: ExecutionRequest, slot: string): void {
    const prior = this.entries[request.requestKey]
    if (prior && (prior.taskId !== taskId || prior.slot !== slot))
      throw new Error('Optimization task ownership changed')
    this.entries[request.requestKey] = { taskId, slot }
    this.persist()
  }
  private persist(): void {
    writeResumeJson(this.filename, {
      schemaVersion: 1,
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
