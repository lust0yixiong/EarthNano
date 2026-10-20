import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import {
  normalizeOptimizationCatalog,
  normalizeOptimizationSweep,
  type OptimizationCatalogIdentity,
  type OptimizationSweepOptions
} from '../../shared/earthnano/optimization-sweep'
import { createHarnessBindingV2Identity } from './harness-binding-v2'
import { assertExecutionTimeout } from './execution-timeout'
import { MAX_HARNESS_FRAME_BYTES } from './harness-binding-limits'
import { optimizationMethodDigest } from './optimization-resume'
import { canonicalOutput, outputDigest } from './output-checks'
import type { OptimizationSweepPlan } from './sweep-contract'

export type SweepPlanFailureCategory =
  | 'invalid-input'
  | 'original-rejected'
  | 'invalid-result'
  | 'method-changed'
  | 'method-unavailable'
  | 'cancelled'
  | 'deadline'
export class SweepPlanFailure extends Error {
  constructor(readonly category: SweepPlanFailureCategory) {
    super(`Original sweep planning unavailable: ${category}`)
    this.name = 'SweepPlanFailure'
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
const fields = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    throw new SweepPlanFailure('invalid-result')
  return value as Record<string, unknown>
}
const methodDigest = (root: string): string => {
  try {
    return optimizationMethodDigest(root)
  } catch {
    throw new SweepPlanFailure('method-unavailable')
  }
}

/** Pure original task_stream planning. Never constructs a Core, Session, executor, source
 * reader or model binding; the complete catalog contains only logical IDs and domains. */
export async function previewOptimizationSweep(parameters: {
  catalog: readonly OptimizationCatalogIdentity[]
  options: OptimizationSweepOptions
  python: string
  harnessRoot: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<OptimizationSweepPlan> {
  try {
    parameters.signal?.throwIfAborted()
    if (!isAbsolute(parameters.python) || !isAbsolute(parameters.harnessRoot))
      throw new SweepPlanFailure('invalid-input')
    let catalog: OptimizationCatalogIdentity[], options: OptimizationSweepOptions
    const timeoutMs = parameters.timeoutMs ?? 10_000
    try {
      catalog = normalizeOptimizationCatalog(parameters.catalog)
      options = normalizeOptimizationSweep(parameters.options)
      assertExecutionTimeout(timeoutMs)
    } catch {
      throw new SweepPlanFailure('invalid-input')
    }
    const digest = methodDigest(parameters.harnessRoot)
    const encoded = canonicalOutput({ configVersion: 2, catalog, options })
    if (Buffer.byteLength(encoded) > MAX_HARNESS_FRAME_BYTES)
      throw new SweepPlanFailure('invalid-input')
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        parameters.python,
        ['-B', '-m', 'harness2.earthnano_sweep', '--preview'],
        {
          cwd: parameters.harnessRoot,
          env: {
            PATH: process.env.PATH ?? '',
            PYTHONPATH: parameters.harnessRoot,
            PYTHONNOUSERSITE: '1',
            PYTHONDONTWRITEBYTECODE: '1',
            PYTHONIOENCODING: 'utf-8'
          },
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: MAX_HARNESS_FRAME_BYTES,
          killSignal: 'SIGKILL',
          windowsHide: true
        },
        (error, output) => {
          parameters.signal?.removeEventListener('abort', abort)
          if (!error) resolve(output)
          else
            reject(
              new SweepPlanFailure(
                parameters.signal?.aborted
                  ? 'cancelled'
                  : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
                    ? 'invalid-result'
                    : error.killed
                      ? 'deadline'
                      : error.code === 'ENOENT'
                        ? 'method-unavailable'
                        : 'original-rejected'
              )
            )
        }
      )
      // Await execFile's physical close callback, not an early AbortError notification.
      const abort = (): void => {
        child.kill('SIGKILL')
      }
      parameters.signal?.addEventListener('abort', abort, { once: true })
      child.once('spawn', () => {
        if (parameters.signal?.aborted) abort()
      })
      if (parameters.signal?.aborted) abort()
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(encoded)
    })
    parameters.signal?.throwIfAborted()
    if (methodDigest(parameters.harnessRoot) !== digest)
      throw new SweepPlanFailure('method-changed')
    let result: Record<string, unknown>
    try {
      result = fields(JSON.parse(stdout), ['resultVersion', 'domains'])
    } catch {
      throw new SweepPlanFailure('invalid-result')
    }
    if (result.resultVersion !== 2 || !Array.isArray(result.domains))
      throw new SweepPlanFailure('invalid-result')
    const selected = new Set<string>(),
      seenDomains = new Set<string>()
    const byTask = new Map(catalog.map((entry) => [entry.taskId, entry.domain]))
    const domains = result.domains.map((value) => {
      const row = fields(value, ['domain', 'taskIds'])
      if (
        typeof row.domain !== 'string' ||
        seenDomains.has(row.domain) ||
        !Array.isArray(row.taskIds) ||
        !row.taskIds.length ||
        (options.stream.onlyDomains.length && !options.stream.onlyDomains.includes(row.domain)) ||
        (options.stream.maxTasks !== null && row.taskIds.length > options.stream.maxTasks)
      )
        throw new SweepPlanFailure('invalid-result')
      const domain = row.domain
      seenDomains.add(domain)
      const taskIds = row.taskIds.map((taskId) => {
        if (
          typeof taskId !== 'string' ||
          selected.has(taskId) ||
          byTask.get(taskId) !== domain ||
          (options.stream.onlyTasks.length && !options.stream.onlyTasks.includes(taskId))
        )
          throw new SweepPlanFailure('invalid-result')
        selected.add(taskId)
        return taskId
      })
      return { domain, taskIds }
    })
    const bindingIdentity = createHarnessBindingV2Identity({
      k: options.k,
      seed: options.stream.seed,
      modes: options.modes.map((mode) => (mode === 'parallel' ? 'agg' : 'seq'))
    })
    const plan = {
      schemaVersion: 2 as const,
      catalog,
      catalogDigest: outputDigest(catalog),
      options,
      domains,
      bindingIdentity,
      methodDigest: digest
    }
    return freeze({ ...plan, digest: outputDigest(plan) })
  } catch (error) {
    if (parameters.signal?.aborted) throw new SweepPlanFailure('cancelled')
    if (error instanceof SweepPlanFailure) throw error
    throw new SweepPlanFailure('invalid-input')
  }
}
