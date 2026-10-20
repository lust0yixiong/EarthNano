/** Platform options for the original Harness² method, not a second optimization algorithm. */
export interface OptimizationMethodOptions {
  mode: 'sequential' | 'parallel'
  k: number
  /** Maximum concurrently running executions; queued admissions still reserve budget. */
  concurrency: number
}

export const DEFAULT_OPTIMIZATION_METHOD: Readonly<OptimizationMethodOptions> = Object.freeze({
  mode: 'sequential',
  k: 1,
  concurrency: 1
})
export const MAX_OPTIMIZATION_K = 8
export const MAX_OPTIMIZATION_CONCURRENCY = 4
export const MAX_OPTIMIZATION_EXECUTIONS = 128

/** Omitted options preserve the existing k=1 sequential entry point. */
export function normalizeOptimizationMethod(value: unknown): OptimizationMethodOptions {
  if (value === undefined) return { ...DEFAULT_OPTIMIZATION_METHOD }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid optimization method')
  const method = value as Record<string, unknown>
  if (
    Object.keys(method).sort().join(',') !== 'concurrency,k,mode' ||
    (method.mode !== 'sequential' && method.mode !== 'parallel') ||
    !Number.isSafeInteger(method.k) ||
    (method.k as number) < 1 ||
    (method.k as number) > MAX_OPTIMIZATION_K ||
    !Number.isSafeInteger(method.concurrency) ||
    (method.concurrency as number) < 1 ||
    (method.concurrency as number) > MAX_OPTIMIZATION_CONCURRENCY
  )
    throw new Error('Invalid optimization method')
  return {
    mode: method.mode,
    k: method.k as number,
    concurrency: method.concurrency as number
  }
}

/** Original single-mode R=4k/P=3k, plus selection at k>1 and optional final assessments.
 * A first-attempt estimate, not a promise: original retries consume additional admissions. */
export function minimumOptimizationExecutions(
  method: OptimizationMethodOptions,
  assessments = true
): number {
  const { k } = normalizeOptimizationMethod(method)
  return 7 * k + (k > 1 ? 1 : 0) + (assessments ? 2 : 0)
}
