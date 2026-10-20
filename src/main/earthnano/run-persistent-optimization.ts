import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExecutionRecord } from '../../shared/earthnano/execution-port'
import { createCandidateSnapshotStore, type CandidateSnapshotInput } from './candidate-snapshot'
import {
  createClaudeCandidateDriver,
  type ClaudeCandidateDriverOptions
} from './claude-candidate-driver'
import { ExecutionCore } from './execution-core'
import { FileExecutionStore } from './execution-store'
import { HarnessOptimizationBinding, runHarnessProcess } from './harness-optimization'
import {
  createPersistentCandidateOwners,
  type PersistentCandidateOwnersOptions
} from './persistent-candidate-owner'

export interface PersistentOptimizationOptions {
  /** Existing project identity in the original OpenScience repositories. */
  projectId: string
  taskId: string
  input: CandidateSnapshotInput
  /** New exclusive run directory; never reuse a prior optimization workspace. */
  workRoot: string
  harnessRoot: string
  python?: string
  ownerOptions: PersistentCandidateOwnersOptions
  binding: ClaudeCandidateDriverOptions['binding']
  executionLimit?: number
  executionTimeoutMs?: number
  timeoutMs?: number
  signal?: AbortSignal
}

/** Opt-in production composition. Existing Session/Artifact/Review owners remain authoritative.
 * A fresh invocation is required; interruption never silently replays a paid model request. */
export async function runPersistentOptimization(options: PersistentOptimizationOptions): Promise<{
  optimizationId: string
  methodResult: unknown
  records: ExecutionRecord[]
}> {
  options.signal?.throwIfAborted()
  if (!isAbsolute(options.workRoot) || !isAbsolute(options.harnessRoot))
    throw new Error('Optimization paths must be absolute')
  const limit = options.executionLimit ?? 10
  const executionTimeoutMs = options.executionTimeoutMs ?? 120_000
  const timeoutMs = options.timeoutMs ?? 600_000
  if (
    ![limit, executionTimeoutMs, timeoutMs].every(
      (value) => Number.isSafeInteger(value) && value > 0
    )
  )
    throw new Error('Invalid optimization limits')
  await mkdir(options.workRoot, { mode: 0o700 })
  const optimizationId = randomUUID()
  const store = new FileExecutionStore(join(options.workRoot, 'execution.json'))
  let core: ExecutionCore | undefined
  let binding: HarnessOptimizationBinding | undefined
  let owners: ReturnType<typeof createPersistentCandidateOwners> | undefined
  try {
    owners = createPersistentCandidateOwners(options.ownerOptions)
    const snapshots = await createCandidateSnapshotStore({
      root: join(options.workRoot, 'snapshots'),
      candidatesRoot: join(options.workRoot, 'candidates')
    })
    core = new ExecutionCore(
      store,
      createClaudeCandidateDriver({
        snapshots,
        binding: options.binding,
        openOwner: owners.openOwner
      })
    )
    core.configureBudget(options.projectId, optimizationId, limit)
    binding = new HarnessOptimizationBinding({
      core,
      snapshots,
      input: options.input,
      projectId: options.projectId,
      optimizationId,
      taskId: options.taskId,
      budgetRef: optimizationId,
      timeoutMs: executionTimeoutMs,
      exportResult: owners.exportResult
    })
    const config = {
      configVersion: 1,
      taskId: options.taskId,
      task: options.input.task,
      baseHarnessFiles: [
        { path: 'instructions.md', content: options.input.harness.instructions },
        ...options.input.harness.skills.map((file) => ({
          path: `skills/${file.path}`,
          content: file.content
        }))
      ],
      workRoot: join(options.workRoot, 'method'),
      model: options.input.agent.model,
      executionTimeoutMs,
      rpcTimeoutMs: executionTimeoutMs + 30_000
    }
    const configPath = join(options.workRoot, 'method-config.json')
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' })
    const methodResult = await runHarnessProcess({
      binding,
      python: options.python ?? 'python3',
      args: ['-B', '-m', 'harness2.earthnano', '--config', configPath],
      cwd: options.harnessRoot,
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        PYTHONPATH: options.harnessRoot,
        PYTHONDONTWRITEBYTECODE: '1',
        HOME: options.workRoot
      },
      timeoutMs,
      signal: options.signal
    })
    if (
      !methodResult ||
      typeof methodResult !== 'object' ||
      (methodResult as { status?: string }).status !== 'ok'
    )
      throw new Error('Harness method did not adopt a valid final result')
    const records = await Promise.all(binding.executionIds.map((id) => core!.get(id)))
    if (
      !records.length ||
      records.some((record) => record.phase !== 'completed' || record.cleanup !== 'confirmed')
    )
      throw new Error('Optimization has incomplete executions')
    // Re-read original owners after the method ends; Python summaries cannot attest persistence.
    for (const record of records) {
      await owners.exportResult(record)
      const reviews = await owners.readReviews(record)
      if (
        !reviews.length ||
        reviews.some((review) => review.lifecycle !== 'complete' || review.outcome !== 'pass')
      )
        throw new Error('Optimization result lacks a complete passing integrity review')
    }
    return { optimizationId, methodResult, records }
  } finally {
    try {
      await binding?.stop()
      const cleanup = owners ? await owners.shutdown() : { reaped: true }
      const state = store.load()
      const safeToUnlock =
        cleanup.reaped &&
        Object.values(state.records).every(
          (record) =>
            ['completed', 'failed', 'cancelled'].includes(record.phase) &&
            record.cleanup === 'confirmed'
        )
      // Unknown cleanup retains the single-writer lock for explicit reconciliation. No auto-replay.
      if (safeToUnlock) store.close()
    } finally {
      core?.dispose()
    }
  }
}
