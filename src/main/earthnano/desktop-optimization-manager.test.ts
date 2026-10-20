import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopOptimizationManager,
  type DesktopOptimizationManagerOptions
} from './desktop-optimization-manager'
import type {
  StartDesktopOptimization,
  OptimizationRunKey
} from '../../shared/earthnano/desktop-optimization'
import type { ExecutionRecord } from '../../shared/earthnano/execution-port'
import type { PersistentOptimizationOptions } from './run-persistent-optimization'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const task: StartDesktopOptimization = {
  projectId: 'project',
  sourceSessionId: 'source',
  requestKey: 'once',
  prompt: 'Count input values',
  files: [{ path: 'values.csv', content: 'value\n1' }],
  criteria: 'The count matches the data rows.',
  executionLimit: 9
}
const fixture = (
  run: DesktopOptimizationManagerOptions['run'],
  overrides: Partial<DesktopOptimizationManagerOptions> = {}
): {
  root: string
  release: ReturnType<typeof vi.fn>
  options: DesktopOptimizationManagerOptions
  manager: DesktopOptimizationManager
} => {
  const root = mkdtempSync(join(tmpdir(), 'earthnano-desktop-'))
  roots.push(root)
  const release = vi.fn()
  const options = {
    root,
    validateSession: vi.fn(async () => undefined),
    createOptions: vi.fn(
      async () => ({ releaseAdmission: release }) as unknown as PersistentOptimizationOptions
    ),
    run,
    ...overrides
  }
  return { root, release, options, manager: new DesktopOptimizationManager(options) }
}
const record = (id: string, role: string, phase: string, cleanup = 'confirmed'): ExecutionRecord =>
  ({
    executionId: id,
    request: { role },
    identity: { sessionId: `session-${id}` },
    phase,
    cleanup
  }) as unknown as ExecutionRecord
const assessment = {
  executionId: 'reviewer',
  targetExecutionId: 'task',
  reviewId: 'review',
  outcome: 'pass' as const,
  score: 90,
  rationale: 'Evidence matches criteria'
}
const complete = {
  optimizationId: 'opt',
  methodResult: {},
  records: [],
  assessments: { baseline: assessment, candidate: assessment }
}
const key = (runId: string): OptimizationRunKey => ({
  projectId: task.projectId,
  sourceSessionId: task.sourceSessionId,
  runId
})

describe('DesktopOptimizationManager', () => {
  it('projects committed role admissions, includes assessment costs and persists readable completion without replay', async () => {
    const run = vi.fn(async (options: PersistentOptimizationOptions) => {
      options.onProgress!({
        optimizationId: 'opt',
        stage: 'optimizing',
        records: [record('b', 'baseline', 'running')]
      })
      options.onProgress!({
        optimizationId: 'opt',
        stage: 'assessing',
        records: [record('b', 'baseline', 'completed'), record('r', 'reviewer', 'running')]
      })
      await Promise.resolve()
      return {
        ...complete,
        records: [record('b', 'baseline', 'completed'), record('r', 'reviewer', 'completed')]
      }
    })
    const { manager, options, release, root } = fixture(run)
    const admitted = await manager.start(task)
    await vi.waitFor(async () =>
      expect((await manager.get(key(admitted.runId))).state).toBe('completed')
    )
    const progress = await manager.get(key(admitted.runId))
    expect(progress.budget).toEqual({ limit: 9, admitted: 2, completed: 2, active: 0 })
    expect(progress.assessments?.candidate.score).toBe(90)
    expect(release).toHaveBeenCalledOnce()
    expect(run.mock.calls[0][0]).toMatchObject({
      semanticCriteria: task.criteria,
      executionLimit: 9,
      taskId: admitted.runId
    })
    expect(run.mock.calls[0][0].workRoot).toBe(join(root, admitted.runId, 'execution'))
    const reopened = new DesktopOptimizationManager(options)
    expect(await reopened.get(key(admitted.runId))).toEqual(progress)
    expect(await reopened.start(task)).toEqual(progress)
    expect(run).toHaveBeenCalledOnce()
    expect(readFileSync(join(root, admitted.runId, 'desktop.json'), 'utf8')).not.toContain(
      task.prompt
    )
  })

  it('deduplicates concurrent clicks but rejects same key with changed inputs and foreign-session queries', async () => {
    let finish!: () => void
    const hold = new Promise<void>((resolve) => {
      finish = resolve
    })
    const run = vi.fn(async () => {
      await hold
      return complete
    })
    const { manager } = fixture(run)
    const [a, b] = await Promise.all([manager.start(task), manager.start(task)])
    expect(a.runId).toBe(b.runId)
    await expect(manager.start({ ...task, prompt: 'Changed' })).rejects.toThrow('conflicts')
    await expect(manager.get({ ...key(a.runId), sourceSessionId: 'other' })).rejects.toThrow(
      'Unknown'
    )
    await expect(manager.start({ ...task, requestKey: 'second' })).rejects.toThrow('active')
    finish()
    await manager.shutdown()
  })

  it('stops pending provider admission before any paid execution and waits for its release', async () => {
    let resolveOptions!: (options: PersistentOptimizationOptions) => void
    const createOptions = vi.fn(
      () =>
        new Promise<PersistentOptimizationOptions>((resolve) => {
          resolveOptions = resolve
        })
    )
    const run = vi.fn(async () => complete)
    const { manager, release } = fixture(run, { createOptions })
    const progress = await manager.start(task)
    expect((await manager.stop(key(progress.runId))).state).toBe('stopping')
    resolveOptions({ releaseAdmission: release } as unknown as PersistentOptimizationOptions)
    await vi.waitFor(async () =>
      expect((await manager.get(key(progress.runId))).state).toBe('cancelled')
    )
    expect(run).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('aborts active work and never accepts late progress as a new running state', async () => {
    const run = vi.fn(async (options: PersistentOptimizationOptions) => {
      await new Promise<void>((resolve) =>
        options.signal!.addEventListener(
          'abort',
          () => {
            options.onProgress!({
              optimizationId: 'opt',
              stage: 'settled',
              records: [record('b', 'baseline', 'cancelled')]
            })
            resolve()
          },
          { once: true }
        )
      )
      throw new Error('raw provider token must not appear')
    })
    const { manager } = fixture(run)
    const p = await manager.start(task)
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    await manager.stop(key(p.runId))
    await vi.waitFor(async () => expect((await manager.get(key(p.runId))).state).toBe('cancelled'))
    expect(JSON.stringify(await manager.get(key(p.runId)))).not.toContain('raw provider')
    expect(await manager.shutdown()).toEqual({ reaped: true })
  })

  it('retains unreconciled cleanup and archive/data writer leases, blocking later admissions', async () => {
    const { manager, release } = fixture(async (options) => {
      options.onProgress!({
        optimizationId: 'opt',
        stage: 'settled',
        records: [record('b', 'baseline', 'interrupted', 'unknown')]
      })
      throw new Error('cleanup unknown')
    })
    const p = await manager.start(task)
    await vi.waitFor(async () =>
      expect((await manager.get(key(p.runId))).state).toBe('interrupted')
    )
    expect(release).not.toHaveBeenCalled()
    expect(manager.hasActiveWork()).toBe(true)
    await expect(manager.start({ ...task, requestKey: 'next' })).rejects.toThrow('unreconciled')
    expect(await manager.shutdown()).toEqual({ reaped: false })
  })

  it('marks unfinished status interrupted on restart and never replays it', async () => {
    const run = vi.fn(async () => complete)
    const { manager, options, root } = fixture(run)
    const p = await manager.start(task)
    await vi.waitFor(async () => expect((await manager.get(key(p.runId))).state).toBe('completed'))
    const path = join(root, p.runId, 'desktop.json')
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    saved.progress.state = 'running'
    writeFileSync(path, JSON.stringify(saved))
    const reopened = new DesktopOptimizationManager(options)
    expect((await reopened.get(key(p.runId))).state).toBe('interrupted')
    expect(run).toHaveBeenCalledOnce()
    expect(await reopened.shutdown()).toEqual({ reaped: false })
  })

  it('enforces text-only input limits and gates admission during update without permanently disabling it', async () => {
    const { manager, options } = fixture(async () => complete)
    await expect(manager.start({ ...task, executionLimit: 8 })).rejects.toThrow('Invalid')
    await expect(
      manager.start({ ...task, files: [{ path: '../escape', content: 'data' }] })
    ).rejects.toThrow('Invalid')
    await expect(
      manager.start({ ...task, criteria: Array(17).fill('A criterion').join('\n') })
    ).rejects.toThrow('Invalid')
    await expect(
      manager.start({ ...task, files: [{ path: 'large.csv', content: 'x'.repeat(64_001) }] })
    ).rejects.toThrow('Invalid')
    expect(options.createOptions).not.toHaveBeenCalled()
    expect(await manager.prepareForUpdateGate()).toEqual({ reaped: true })
    await expect(manager.start(task)).rejects.toThrow('closed')
    manager.releaseUpdateGate()
    const p = await manager.start(task)
    await vi.waitFor(async () => expect((await manager.get(key(p.runId))).state).toBe('completed'))
    expect(await manager.shutdown()).toEqual({ reaped: true })
    await expect(manager.start({ ...task, requestKey: 'new' })).rejects.toThrow('closed')
  })
})
