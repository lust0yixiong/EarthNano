import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import fixtures from '../../../contracts/execution/fixtures.json'
import type { ExecutionRecord, ExecutionRequest } from '../../shared/earthnano/execution-port'
import type { OptimizationSweepMode } from '../../shared/earthnano/optimization-sweep'
import type { CandidateSnapshotStore } from './candidate-snapshot'
import type { PersistentCandidateOwners } from './persistent-candidate-owner'
import { previewOptimizationSweep } from './sweep-plan'
import { prepareSweepSummary, sweepModeToken, type SweepMethodResult } from './sweep-results'

const python = execFileSync(
  process.env.EARTHNANO_RESEARCH_PYTHON ?? 'python3',
  ['-c', 'import sys; print(sys.executable)'],
  { encoding: 'utf8' }
).trim()
async function fixture(): Promise<
  Parameters<typeof prepareSweepSummary>[0] & { result: SweepMethodResult }
> {
  const plan = await previewOptimizationSweep({
    catalog: [
      { taskId: 'b', domain: 'second' },
      { taskId: 'a', domain: 'first' }
    ],
    options: {
      modes: ['parallel', 'sequential'],
      k: 1,
      concurrency: 2,
      stream: { seed: 0, onlyDomains: [], onlyTasks: [], maxTasks: null, workers: 2 }
    },
    python,
    harnessRoot: resolve('vendor/harness2')
  })
  const record = (id: string, role: 'baseline' | 'candidate'): ExecutionRecord =>
    ({
      executionId: id,
      requestKey: id,
      requestDigest: `sha256:${'a'.repeat(64)}`,
      request: { ...(structuredClone(fixtures.valid) as ExecutionRequest), requestKey: id, role },
      phase: 'completed',
      cancellationRequested: false,
      cleanup: 'confirmed',
      identity: {},
      usage: { status: 'unknown' },
      evidence: { status: 'complete', artifacts: [], trajectory: [] },
      createdAt: 'x',
      updatedAt: 'x'
    }) as unknown as ExecutionRecord
  const all = new Map<string, ExecutionRecord[]>()
  const perMode = (taskId: string, mode: OptimizationSweepMode): ExecutionRecord[] =>
    all
      .get(taskId)!
      .filter(
        (row) => row.request.role === 'baseline' || row.executionId.endsWith(sweepModeToken(mode))
      )
  for (const { taskIds } of plan.domains)
    for (const id of taskIds)
      all.set(id, [
        record(`${id}-base`, 'baseline'),
        record(`${id}-agg`, 'candidate'),
        record(`${id}-seq`, 'candidate')
      ])
  const result: SweepMethodResult = {
    resultVersion: 2,
    status: 'ok',
    bindingDigest: plan.bindingIdentity.digest,
    planDigest: plan.digest,
    sweep: {
      n_domains: 2,
      k: 1,
      modes: ['agg', 'seq'],
      seed: 0,
      only_tasks: [],
      max_tasks: null,
      domain_order: plan.domains.map((row) => row.domain),
      domains: [...plan.domains].reverse().map(({ domain, taskIds }) => ({
        domain,
        n_tasks: taskIds.length,
        done: taskIds.length,
        failed: 0,
        tasks: taskIds.map((task) => ({ task, status: 'ok' }))
      }))
    },
    tasks: plan.domains.flatMap(({ domain, taskIds }) =>
      taskIds.map((taskId) => ({
        taskId,
        domain,
        status: 'ok',
        executionIds: all.get(taskId)!.map((row) => row.executionId),
        modes: Object.fromEntries(
          plan.options.modes.map((mode) => [
            sweepModeToken(mode),
            {
              taskId,
              status: 'ok',
              executionIds: perMode(taskId, mode).map((row) => row.executionId),
              chosenArtifacts: [],
              selection: {
                chosenLabel: 'c1',
                candidateCount: 1,
                trivial: true,
                fallback: false,
                reason: ''
              },
              method: { mode, k: 1, concurrency: 2 }
            }
          ])
        )
      }))
    ),
    libraries: plan.domains.flatMap(({ domain }) =>
      plan.bindingIdentity.modes.map((mode) => ({ domain, mode, entries: [], files: [] }))
    )
  }
  const owners = { exportResult: vi.fn() } as unknown as PersistentCandidateOwners
  return {
    plan,
    result,
    recordsForTask: (taskId: string) => all.get(taskId)!,
    recordsForMode: perMode,
    snapshots: {} as CandidateSnapshotStore,
    owners
  }
}
it('preserves planned order despite original concurrent domain completion order and keeps per-mode projections', async () => {
  const f = await fixture()
  const summary = await prepareSweepSummary(f)
  expect(summary.order).toEqual(f.plan.domains)
  expect(summary.domains.map(({ mode, summary }) => [mode, summary.name])).toEqual(
    f.plan.domains.flatMap(({ domain }) => [
      ['parallel', domain],
      ['sequential', domain]
    ])
  )
  expect(f.owners.exportResult).not.toHaveBeenCalled()
})
it.each(['scope', 'task', 'library', 'status', 'order', 'identity'])(
  'rejects a substituted original %s projection before adoption',
  async (change) => {
    const f = await fixture()
    if (change === 'scope')
      f.result.tasks[0]!.modes.agg!.executionIds = f.result.tasks[0]!.modes.seq!.executionIds
    if (change === 'task') f.result.tasks[0]!.executionIds = f.result.tasks[1]!.executionIds
    if (change === 'library') f.result.libraries[0]!.mode = f.result.libraries[1]!.mode
    if (change === 'status') f.result.sweep.domains[0]!.failed = 1
    if (change === 'order') f.result.sweep.domain_order.reverse()
    if (change === 'identity') f.result.bindingDigest = `sha256:${'b'.repeat(64)}`
    await expect(prepareSweepSummary(f)).rejects.toThrow()
  }
)
