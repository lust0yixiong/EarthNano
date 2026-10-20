import type { ExecutionRecord } from '../../shared/earthnano/execution-port'
import type {
  OptimizationSweepMode,
  OptimizationSweepSummary
} from '../../shared/earthnano/optimization-sweep'
import type { CandidateSnapshotStore } from './candidate-snapshot'
import type { PersistentCandidateOwners } from './persistent-candidate-owner'
import type { OptimizationSweepPlan } from './sweep-contract'
import { canonicalOutput } from './output-checks'
import { normalizeOptimizationMethod } from '../../shared/earthnano/optimization-method'
import { prepareDomainSummary, type DomainMethodTask } from './domain-results'

export interface SweepMethodResult {
  resultVersion: 2
  status: 'ok' | 'partial'
  planDigest: string
  bindingDigest: string
  sweep: {
    n_domains: number
    domains: Array<{
      domain: string
      n_tasks: number
      done: number
      failed: number
      tasks: Array<{ task: string; status: string }>
    }>
    domain_order: string[]
    k: number
    modes: string[]
    seed: number | null
    only_tasks: string[]
    max_tasks: number | null
  }
  tasks: Array<{
    taskId: string
    domain: string
    status: string
    executionIds: string[]
    modes: Partial<Record<'agg' | 'seq', DomainMethodTask>>
  }>
  libraries: Array<{
    domain: string
    mode: 'agg' | 'seq'
    entries: string[]
    files: Array<{ path: string; content: string }>
  }>
}
export const sweepModeToken = (mode: OptimizationSweepMode): 'agg' | 'seq' =>
  mode === 'parallel' ? 'agg' : 'seq'
const same = (a: unknown, b: unknown): boolean => canonicalOutput(a) === canonicalOutput(b)
const inventory = (ids: unknown, records: ExecutionRecord[]): boolean =>
  Array.isArray(ids) &&
  new Set(ids).size === ids.length &&
  same([...ids].sort(), records.map((record) => record.executionId).sort())

/** Validate original Library projections through the existing immutable result verifier.
 * Mode/task ownership is fixed by the private routing index, never by Python-supplied IDs. */
export async function prepareSweepSummary(options: {
  result: unknown
  plan: OptimizationSweepPlan
  recordsForTask(taskId: string): ExecutionRecord[]
  recordsForMode(taskId: string, mode: OptimizationSweepMode): ExecutionRecord[]
  snapshots: CandidateSnapshotStore
  owners: PersistentCandidateOwners
}): Promise<OptimizationSweepSummary> {
  const result = options.result as SweepMethodResult,
    plan = options.plan
  const selected = plan.domains.flatMap(({ domain, taskIds }) =>
    taskIds.map((taskId) => ({ taskId, domain }))
  )
  if (
    !result ||
    result.resultVersion !== 2 ||
    !['ok', 'partial'].includes(result.status) ||
    result.planDigest !== plan.digest ||
    result.bindingDigest !== plan.bindingIdentity.digest ||
    !result.sweep ||
    !same(
      result.sweep.domain_order,
      plan.domains.map((row) => row.domain)
    ) ||
    result.sweep.k !== plan.options.k ||
    !same(result.sweep.modes, plan.bindingIdentity.modes) ||
    result.sweep.seed !== plan.options.stream.seed ||
    !same(result.sweep.only_tasks, plan.options.stream.onlyTasks) ||
    result.sweep.max_tasks !== plan.options.stream.maxTasks ||
    !Array.isArray(result.tasks) ||
    result.tasks.length !== selected.length ||
    !Array.isArray(result.libraries) ||
    result.libraries.length !== plan.domains.length * plan.options.modes.length
  )
    throw new Error('Invalid original sweep projection')
  if (
    result.sweep.n_domains !== plan.domains.length ||
    !Array.isArray(result.sweep.domains) ||
    result.sweep.domains.length !== plan.domains.length
  )
    throw new Error('Original sweep domain inventory changed')
  for (const { domain, taskIds } of plan.domains) {
    const rows = result.sweep.domains.filter((entry) => entry.domain === domain)
    const row = rows[0]
    if (
      rows.length !== 1 ||
      !row ||
      !Array.isArray(row.tasks) ||
      row.n_tasks !== taskIds.length ||
      !same(
        row.tasks.map((task) => task.task),
        taskIds
      ) ||
      row.done !== row.tasks.filter((task) => ['ok', 'skipped'].includes(task.status)).length ||
      row.failed !== taskIds.length - row.done
    )
      throw new Error('Original sweep task order or completion changed')
    for (const task of row.tasks) {
      const projection = result.tasks.find((entry) => entry.taskId === task.task)
      if (!projection || projection.status !== (task.status === 'skipped' ? 'ok' : task.status))
        throw new Error('Sweep task status differs from original scheduler')
    }
  }
  if ((result.status === 'ok') !== result.sweep.domains.every((row) => row.failed === 0))
    throw new Error('Sweep aggregate status differs from original scheduler')
  for (const identity of selected) {
    const rows = result.tasks.filter(
      (row) => row.taskId === identity.taskId && row.domain === identity.domain
    )
    if (
      rows.length !== 1 ||
      !inventory(rows[0]!.executionIds, options.recordsForTask(identity.taskId)) ||
      !rows[0]!.modes ||
      !same(Object.keys(rows[0]!.modes).sort(), [...plan.bindingIdentity.modes].sort())
    )
      throw new Error('Sweep task execution ownership mismatch')
    for (const mode of plan.options.modes) {
      const row = rows[0]!.modes[sweepModeToken(mode)]!
      const method = normalizeOptimizationMethod(row.method)
      if (
        row.taskId !== identity.taskId ||
        method.mode !== mode ||
        method.k !== plan.options.k ||
        method.concurrency !== plan.options.concurrency ||
        !inventory(row.executionIds, options.recordsForMode(identity.taskId, mode))
      )
        throw new Error('Sweep mode execution ownership mismatch')
    }
  }
  const domains: OptimizationSweepSummary['domains'] = []
  for (const { domain, taskIds } of plan.domains)
    for (const mode of plan.options.modes) {
      const libraries = result.libraries.filter(
        (row) => row.domain === domain && row.mode === sweepModeToken(mode)
      )
      if (libraries.length !== 1) throw new Error('Sweep mode Library ownership mismatch')
      const library = libraries[0]!
      const summary = await prepareDomainSummary({
        result: {
          status: result.status,
          domain,
          order: taskIds,
          tasks: taskIds.map(
            (taskId) =>
              result.tasks.find((row) => row.taskId === taskId)!.modes[sweepModeToken(mode)]
          ),
          library: { files: library.files, entries: library.entries }
        },
        domain: { name: domain, nextTasks: [] },
        taskIds,
        recordsForTask: (taskId) => options.recordsForMode(taskId, mode),
        snapshots: options.snapshots,
        owners: options.owners
      })
      domains.push({ mode, summary })
    }
  return {
    planDigest: plan.digest,
    order: structuredClone(plan.domains),
    modes: [...plan.options.modes],
    domains
  }
}
