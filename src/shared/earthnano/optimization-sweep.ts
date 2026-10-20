import { MAX_OPTIMIZATION_CONCURRENCY, MAX_OPTIMIZATION_K } from './optimization-method'
import type { OptimizationArtifactInput } from './optimization-input'
import type { OutputCheckSpec, DomainOptimizationSummary } from './research-outcome'

/** Public names map to the original agg/seq modes; their canonical order is unchanged. */
export type OptimizationSweepMode = 'parallel' | 'sequential'
export interface OptimizationCatalogIdentity {
  taskId: string
  domain: string
}
export interface OptimizationStreamOptions {
  seed: number | null
  onlyDomains: string[]
  onlyTasks: string[]
  /** Original task_stream applies this limit separately to each domain. */
  maxTasks: number | null
  /** Domain workers, distinct from the shared Core admission concurrency. */
  workers: number
}
export interface OptimizationSweepOptions {
  modes: OptimizationSweepMode[]
  k: number
  concurrency: number
  stream: OptimizationStreamOptions
}
export interface OptimizationSweepTask extends OptimizationCatalogIdentity {
  /** Each source is authorized independently in the existing project. */
  sourceSessionId: string
  source:
    | { kind: 'notebook'; promptMessageId: string }
    | {
        kind: 'text'
        prompt: string
        files: Array<{ path: string; content: string }>
        inputArtifacts?: OptimizationArtifactInput[]
      }
  /** Host-private independent acceptance requirements; never method context. */
  criteria: string
  checks?: OutputCheckSpec[]
}
export interface StartDesktopSweep {
  projectId: string
  /** Navigation/ownership Session; it is not an implicit task or source authority. */
  sourceSessionId: string
  requestKey: string
  catalog: OptimizationSweepTask[]
  sweep: OptimizationSweepOptions
  executionLimit: number
}
/** Read-only original task_stream preview. Contains identities, never task data or credentials. */
export interface PreviewDesktopSweep {
  projectId: string
  sourceSessionId: string
  catalog: OptimizationCatalogIdentity[]
  sweep: OptimizationSweepOptions
}
export interface DesktopSweepPreview {
  planDigest: string
  order: Array<{ domain: string; taskIds: string[] }>
  modes: OptimizationSweepMode[]
  /** First-attempt capacity only; retries still consume the experiment's shared limit. */
  minimumExecutions: number
}
export interface OptimizationSweepSummary {
  planDigest: string
  /** Planned original stream order, independent of domain completion order. */
  order: Array<{ domain: string; taskIds: string[] }>
  modes: OptimizationSweepMode[]
  domains: Array<{ mode: OptimizationSweepMode; summary: DomainOptimizationSummary }>
}
/** Explicit Alpha guard, not a silent increase to legacy or resumed experiments. */
export const MAX_SWEEP_EXECUTIONS = 512
export const MAX_SWEEP_TASKS = 32

const fail = (): never => {
  throw new Error('Invalid optimization sweep options or catalog')
}
const fields = (value: unknown, expected: string[]): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).sort().join(',') !== [...expected].sort().join(',')
  )
    return fail()
  return value as Record<string, unknown>
}
export const isOptimizationCatalogId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value) &&
  !value.endsWith('.') &&
  !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)

export function normalizeOptimizationCatalog(value: unknown): OptimizationCatalogIdentity[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_SWEEP_TASKS) return fail()
  const seen = new Set<string>()
  const domainNames = new Map<string, string>()
  return value.map((item) => {
    const entry = fields(item, ['taskId', 'domain'])
    if (!isOptimizationCatalogId(entry.taskId) || !isOptimizationCatalogId(entry.domain))
      return fail()
    const key = entry.taskId.toLowerCase(),
      domainKey = entry.domain.toLowerCase()
    if (
      seen.has(key) ||
      (domainNames.has(domainKey) && domainNames.get(domainKey) !== entry.domain)
    )
      return fail()
    seen.add(key)
    domainNames.set(domainKey, entry.domain)
    return { taskId: entry.taskId, domain: entry.domain }
  })
}

/** Structural normalization only. Original task_stream alone decides ordering/filter semantics. */
export function normalizeOptimizationSweep(value: unknown): OptimizationSweepOptions {
  const spec = fields(value, ['modes', 'k', 'concurrency', 'stream'])
  if (
    !Array.isArray(spec.modes) ||
    !spec.modes.length ||
    spec.modes.some((mode) => mode !== 'parallel' && mode !== 'sequential') ||
    new Set(spec.modes).size !== spec.modes.length ||
    !Number.isSafeInteger(spec.k) ||
    (spec.k as number) < 1 ||
    (spec.k as number) > MAX_OPTIMIZATION_K ||
    !Number.isSafeInteger(spec.concurrency) ||
    (spec.concurrency as number) < 1 ||
    (spec.concurrency as number) > MAX_OPTIMIZATION_CONCURRENCY
  )
    return fail()
  const stream = fields(spec.stream, ['seed', 'onlyDomains', 'onlyTasks', 'maxTasks', 'workers'])
  const ids = (value: unknown): string[] => {
    if (
      !Array.isArray(value) ||
      value.length > MAX_SWEEP_TASKS ||
      value.some((id) => !isOptimizationCatalogId(id)) ||
      new Set(value).size !== value.length
    )
      return fail()
    return [...value] as string[]
  }
  if (
    (stream.seed !== null && !Number.isSafeInteger(stream.seed)) ||
    (stream.maxTasks !== null &&
      (!Number.isSafeInteger(stream.maxTasks) || (stream.maxTasks as number) < 1)) ||
    !Number.isSafeInteger(stream.workers) ||
    (stream.workers as number) < 1 ||
    (stream.workers as number) > MAX_OPTIMIZATION_CONCURRENCY
  )
    return fail()
  return {
    modes: (['parallel', 'sequential'] as const).filter((mode) =>
      (spec.modes as unknown[]).includes(mode)
    ),
    k: spec.k as number,
    concurrency: spec.concurrency as number,
    stream: {
      seed: stream.seed as number | null,
      onlyDomains: ids(stream.onlyDomains),
      onlyTasks: ids(stream.onlyTasks),
      maxTasks: stream.maxTasks as number | null,
      workers: stream.workers as number
    }
  }
}

export function normalizeDesktopSweepPreview(value: unknown): PreviewDesktopSweep {
  const request = fields(value, ['projectId', 'sourceSessionId', 'catalog', 'sweep'])
  const sessionId = (value: unknown): string =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : fail()
  return {
    projectId: sessionId(request.projectId),
    sourceSessionId: sessionId(request.sourceSessionId),
    catalog: normalizeOptimizationCatalog(request.catalog),
    sweep: normalizeOptimizationSweep(request.sweep)
  }
}

/** Capacity for a complete first-attempt original sweep, including every reflection.
 * Failure/fallback may use fewer admissions and retries may need more; never a success promise. */
export function minimumSweepExecutions(
  options: OptimizationSweepOptions,
  selectedTaskCount: number,
  assessments = true
): number {
  const { k, modes } = normalizeOptimizationSweep(options)
  if (
    !Number.isSafeInteger(selectedTaskCount) ||
    selectedTaskCount < 1 ||
    selectedTaskCount > MAX_SWEEP_TASKS
  )
    return fail()
  return (
    selectedTaskCount *
    (k + modes.length * (6 * k + (k > 1 ? 1 : 0) + 1) + (assessments ? 1 + modes.length : 0))
  )
}

/** One experiment-wide admission cap. Call after original task_stream resolves selected IDs. */
export function assertSweepExecutionLimit(
  options: OptimizationSweepOptions,
  selectedTaskCount: number,
  limit: number
): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit > MAX_SWEEP_EXECUTIONS ||
    limit < minimumSweepExecutions(options, selectedTaskCount)
  )
    throw new Error('Sweep execution limit cannot cover the selected original task stream')
}
