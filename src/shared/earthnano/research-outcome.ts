import type { ArtifactReference, Ref } from './execution-port'
import type { OptimizationMethodOptions } from './optimization-method'
import { minimumOptimizationExecutions } from './optimization-method'
import type {
  OptimizationSelectionSummary,
  SemanticAssessmentSummary
} from './desktop-optimization'

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export interface OutputCheckSpec {
  kind: 'json-value'
  path: string
  pointer: string
  expected: JsonValue
  tolerance?: number
}
export interface OutputCheckResult {
  path: string
  pointer: string
  status: 'pass' | 'fail'
  reason: 'matched' | 'missing-file' | 'invalid-json' | 'missing-value' | 'mismatch'
  artifactRef?: ArtifactReference
}
export interface ResearchOutcome {
  artifact: {
    status: 'passed' | 'failed' | 'unverified'
    checks: OutputCheckResult[]
    reviewId?: string
  }
  configuration: {
    /** eligible means eligible for further validation, never automatically published. */
    status: 'eligible' | 'blocked' | 'unverified'
    reasons: string[]
    harnessRevisionRef?: Ref
  }
}
export interface OptimizationDomainTask {
  prompt: string
  files: Array<{ path: string; content: string }>
  criteria: string
  checks?: OutputCheckSpec[]
}
export interface OptimizationDomainSpec {
  name: string
  /** Current desktop task is first. Additional tasks run in this explicit experiment only. */
  nextTasks: OptimizationDomainTask[]
}
export interface ExperienceProvenance {
  scope: 'experiment'
  reflectionExecutionId: string
  reflectionArtifacts: ArtifactReference[]
  selectedExecutionId: string
  selectedHarnessRevisionRef: Ref
  libraryDigest: string
}
export interface DomainTaskSummary {
  taskId: string
  selection?: OptimizationSelectionSummary
  assessments?: { baseline: SemanticAssessmentSummary; candidate: SemanticAssessmentSummary }
  outcome?: ResearchOutcome
  experience?: ExperienceProvenance
}
export interface DomainOptimizationSummary {
  name: string
  order: string[]
  tasks: DomainTaskSummary[]
  library: { scope: 'experiment'; entries: string[]; digest: string }
}

const fail = (): never => {
  throw new Error('Invalid research verification or domain options')
}
const plain = (value: unknown): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail()
  return value as Record<string, unknown>
}
const fields = (
  value: unknown,
  required: string[],
  optional: string[] = []
): Record<string, unknown> => {
  const object = plain(value)
  if (
    required.some((key) => !Object.hasOwn(object, key)) ||
    Object.keys(object).some((key) => ![...required, ...optional].includes(key))
  )
    return fail()
  return object
}
const text = (value: unknown, maximum: number, nonempty = true): string => {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    value.includes('\0') ||
    (nonempty && !value.trim())
  )
    return fail()
  for (const char of value)
    if (char.codePointAt(0)! >= 0xd800 && char.codePointAt(0)! <= 0xdfff) return fail()
  return value
}
const json = (value: unknown, depth = 0): JsonValue => {
  if (depth > 12) return fail()
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : fail()
  if (Array.isArray(value)) return value.map((item) => json(item, depth + 1))
  const object = plain(value)
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, json(item, depth + 1)])
  )
}
export function normalizeOutputChecks(value: unknown): OutputCheckSpec[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 16) return fail()
  const checks = value.map((entry) => {
    const c = fields(entry, ['kind', 'path', 'pointer', 'expected'], ['tolerance'])
    const path = text(c.path, 180)
    if (
      c.kind !== 'json-value' ||
      !path
        .split('/')
        .every((part) => /^[A-Za-z0-9_. -]+$/.test(part) && part !== '.' && part !== '..')
    )
      return fail()
    const pointer = text(c.pointer, 1024, false)
    if ((pointer !== '' && !pointer.startsWith('/')) || /~(?![01])/u.test(pointer)) return fail()
    const expected = json(c.expected)
    if (JSON.stringify(expected).length > 8000) return fail()
    if (
      Object.hasOwn(c, 'tolerance') &&
      (typeof expected !== 'number' ||
        typeof c.tolerance !== 'number' ||
        !Number.isFinite(c.tolerance) ||
        c.tolerance < 0)
    )
      return fail()
    return {
      kind: 'json-value' as const,
      path,
      pointer,
      expected,
      ...(Object.hasOwn(c, 'tolerance') ? { tolerance: c.tolerance as number } : {})
    }
  })
  if (JSON.stringify(checks).length > 32000) return fail()
  return checks
}
export function normalizeOptimizationDomain(value: unknown): OptimizationDomainSpec | undefined {
  if (value === undefined) return undefined
  const domain = fields(value, ['name', 'nextTasks'])
  const name = text(domain.name, 80)
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) ||
    name.endsWith('.') ||
    !Array.isArray(domain.nextTasks) ||
    domain.nextTasks.length > 3
  )
    return fail()
  const nextTasks = domain.nextTasks.map((entry) => {
    const task = fields(entry, ['prompt', 'files', 'criteria'], ['checks'])
    if (!Array.isArray(task.files) || task.files.length > 32) return fail()
    const files = task.files.map((entry) => {
      const f = fields(entry, ['path', 'content'])
      return { path: text(f.path, 180), content: text(f.content, 64000, false) }
    })
    const paths = new Set<string>()
    let bytes = 0
    for (const file of files) {
      const key = file.path.normalize('NFC').toLowerCase()
      const size = new TextEncoder().encode(file.content).length
      bytes += size
      if (
        !file.path
          .split('/')
          .every((part) => /^[A-Za-z0-9_. -]+$/.test(part) && part !== '.' && part !== '..') ||
        paths.has(key) ||
        [...paths].some((other) => other.startsWith(key + '/') || key.startsWith(other + '/')) ||
        size > 64000 ||
        bytes > 128000
      )
        return fail()
      paths.add(key)
    }
    const criteria = text(task.criteria, 16000)
    const lines = criteria
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (!lines.length || lines.length > 16 || lines.some((line) => line.length > 2000))
      return fail()
    return {
      prompt: text(task.prompt, 32000),
      files,
      criteria,
      ...(task.checks === undefined ? {} : { checks: normalizeOutputChecks(task.checks) })
    }
  })
  return { name, nextTasks }
}
export function minimumResearchExecutions(
  method: OptimizationMethodOptions,
  domain?: OptimizationDomainSpec
): number {
  return domain
    ? (minimumOptimizationExecutions(method) + 1) * (1 + domain.nextTasks.length)
    : minimumOptimizationExecutions(method)
}
