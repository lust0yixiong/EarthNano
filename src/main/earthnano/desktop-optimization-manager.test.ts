import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  it('retains resolved source provenance and domain files instead of overwriting them with the raw desktop DTO', async () => {
    const inputArtifacts = [
      {
        artifactId: 'artifact',
        versionId: 'version-1',
        path: 'source.json',
        checksum: 'a'.repeat(64)
      }
    ]
    const domain = {
      name: 'science',
      nextTasks: [{ prompt: 'Next', criteria: 'Keep source', files: [] }]
    }
    const preparedDomain = {
      ...domain,
      nextTasks: [{ ...domain.nextTasks[0], files: [{ path: 'source.json', content: 'fixed' }] }]
    }
    const run = vi.fn(async (options: PersistentOptimizationOptions) => ({
      ...complete,
      domain: {
        name: options.domain!.name,
        order: [],
        tasks: [],
        library: { scope: 'experiment' as const, entries: [], digest: 'digest' }
      }
    }))
    const { manager, options } = fixture(run, {
      createOptions: vi.fn(async () => ({
        inputArtifacts,
        domain: preparedDomain
      })) as unknown as DesktopOptimizationManagerOptions['createOptions']
    })
    const started = await manager.start({ ...task, executionLimit: 24, domain, inputArtifacts })
    await vi.waitFor(async () =>
      expect((await manager.get(key(started.runId))).state).toBe('completed')
    )
    expect(vi.mocked(run).mock.calls[0][0]).toMatchObject({
      domain: preparedDomain,
      inputArtifacts
    })
    expect((await manager.get(key(started.runId))).inputArtifacts).toEqual(inputArtifacts)
    await expect(
      manager.start({
        ...task,
        executionLimit: 24,
        domain,
        inputArtifacts: [{ ...inputArtifacts[0], versionId: 'version-2' }]
      })
    ).rejects.toThrow('conflicts')
    expect(options.createOptions).toHaveBeenCalledOnce()
  })
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

it.each(['sequential', 'parallel'] as const)(
  'persists and forwards explicit %s method, selector stage and selection summary',
  async (mode) => {
    const method = { mode, k: 2, concurrency: 3 }
    const selector = record('s', 'selector', 'completed')
    selector.request.origin = { kind: 'optimization', optimizationId: 'opt', stageId: 'selection' }
    const selection = {
      chosenLabel: 'final2',
      candidateCount: 2,
      trivial: false,
      fallback: false,
      reason: 'Matches task evidence'
    }
    const run = vi.fn(async (options: PersistentOptimizationOptions) => {
      options.onProgress!({ optimizationId: 'opt', stage: 'optimizing', records: [selector] })
      return { ...complete, methodResult: { selection }, records: [selector] }
    })
    const { manager, root, options } = fixture(run)
    const admitted = await manager.start({ ...task, method, executionLimit: 17 })
    await vi.waitFor(async () =>
      expect((await manager.get(key(admitted.runId))).state).toBe('completed')
    )
    const progress = await manager.get(key(admitted.runId))
    expect(progress.method).toEqual(method)
    expect(progress.selection).toEqual(selection)
    expect(progress.executions[0]).toMatchObject({ role: 'selector', stageId: 'selection' })
    expect(run.mock.calls[0][0]).toMatchObject({ method, executionLimit: 17 })
    const reopened = new DesktopOptimizationManager(options)
    expect((await reopened.get(key(admitted.runId))).selection).toEqual(selection)
    const saved = JSON.parse(readFileSync(join(root, admitted.runId, 'desktop.json'), 'utf8'))
    expect(saved.progress.method).toEqual(method)
    await expect(
      manager.start({
        ...task,
        method: { ...method, mode: mode === 'sequential' ? 'parallel' : 'sequential' },
        executionLimit: 17
      })
    ).rejects.toThrow('conflicts')
    await expect(
      manager.start({ ...task, method: { ...method, concurrency: 1 }, executionLimit: 17 })
    ).rejects.toThrow('conflicts')
    await expect(
      manager.start({ ...task, method: { ...method, k: 1 }, executionLimit: 17 })
    ).rejects.toThrow('conflicts')
  }
)
it('rejects insufficient first-attempt budgets and invalid method before session or provider side effects', async () => {
  const run = vi.fn(async () => complete)
  const { manager, options, root } = fixture(run)
  await expect(
    manager.start({
      ...task,
      method: { mode: 'parallel', k: 2, concurrency: 2 },
      executionLimit: 16
    })
  ).rejects.toThrow('Invalid')
  await expect(
    manager.start({
      ...task,
      method: { mode: 'parallel', k: 8, concurrency: 4 },
      executionLimit: 58
    })
  ).rejects.toThrow('Invalid')
  await expect(manager.start({ ...task, executionLimit: 129 })).rejects.toThrow('Invalid')
  await expect(
    manager.start({ ...task, method: { mode: 'parallel', k: 1, concurrency: 5 } })
  ).rejects.toThrow('Invalid')
  expect(options.validateSession).not.toHaveBeenCalled()
  expect(options.createOptions).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
  expect(readdirSync(root)).toEqual([])
})
it('keeps legacy omitted-option digest byte-compatible and treats explicit method as request content', async () => {
  const run = vi.fn(async () => complete)
  const { manager, options, root } = fixture(run)
  const admitted = await manager.start(task)
  await vi.waitFor(async () =>
    expect((await manager.get(key(admitted.runId))).state).toBe('completed')
  )
  const { createHash } = await import('node:crypto')
  const legacyDigest = createHash('sha256').update(JSON.stringify(task)).digest('hex')
  const saved = JSON.parse(readFileSync(join(root, admitted.runId, 'desktop.json'), 'utf8'))
  expect(saved.digest).toBe(legacyDigest)
  delete saved.progress.method
  writeFileSync(join(root, admitted.runId, 'desktop.json'), JSON.stringify(saved))
  const reopened = new DesktopOptimizationManager(options)
  expect((await reopened.start(task)).runId).toBe(admitted.runId)
  await expect(
    reopened.start({ ...task, method: { mode: 'sequential', k: 1, concurrency: 1 } })
  ).rejects.toThrow('conflicts')
  expect(run).toHaveBeenCalledOnce()
})

const checks = [
  { kind: 'json-value' as const, path: 'result.json', pointer: '/count', expected: 3 }
]
const domain = {
  name: 'csv-count',
  nextTasks: [
    {
      prompt: 'Count the next data set',
      criteria: 'Correct count',
      files: [{ path: 'values.csv', content: 'value\n2' }],
      checks
    }
  ]
}
const researchOutcome = {
  artifact: {
    status: 'failed' as const,
    checks: [
      {
        path: 'result.json',
        pointer: '/count',
        status: 'fail' as const,
        reason: 'mismatch' as const
      }
    ],
    reviewId: 'check-review'
  },
  configuration: { status: 'blocked' as const, reasons: ['Expected count differs'] }
}
it('validates the full domain text profile and aggregate budget before any session or provider side effects', async () => {
  const { manager, options, root } = fixture(async () => complete)
  for (const nextTask of [
    { ...domain.nextTasks[0], files: [{ path: '../escape', content: 'x' }] },
    {
      ...domain.nextTasks[0],
      files: [
        { path: 'A.csv', content: 'x' },
        { path: 'a.csv', content: 'y' }
      ]
    },
    { ...domain.nextTasks[0], files: [{ path: 'unicode.csv', content: '汉'.repeat(22000) }] },
    {
      ...domain.nextTasks[0],
      files: [1, 2, 3].map((id) => ({ path: `data${id}.csv`, content: 'x'.repeat(64000) }))
    },
    { ...domain.nextTasks[0], criteria: Array(17).fill('criterion').join('\n') },
    {
      ...domain.nextTasks[0],
      files: [
        { path: 'a.csv', content: 'x' },
        { path: 'a.csv', content: 'y' }
      ]
    }
  ])
    await expect(
      manager.start({ ...task, executionLimit: 20, domain: { ...domain, nextTasks: [nextTask] } })
    ).rejects.toThrow()
  await expect(manager.start({ ...task, executionLimit: 19, domain })).rejects.toThrow('Invalid')
  await expect(
    manager.start({ ...task, checks: [{ ...checks[0], pointer: '/bad~2' }] })
  ).rejects.toThrow()
  expect(options.validateSession).not.toHaveBeenCalled()
  expect(options.createOptions).not.toHaveBeenCalled()
  expect(readdirSync(root)).toEqual([])
})
it('preserves checks and domain identity, forwards the shared budget and keeps lifecycle completion separate from blocked acceptance', async () => {
  const summary = {
    name: domain.name,
    order: ['task1', 'task2'],
    tasks: [{ taskId: 'task1', outcome: researchOutcome }],
    library: { scope: 'experiment' as const, entries: [], digest: 'digest' }
  }
  const run = vi.fn(async (options: PersistentOptimizationOptions) => {
    options.onProgress!({
      optimizationId: 'opt',
      stage: 'assessing',
      records: [],
      domain: summary
    } as import('./run-persistent-optimization').PersistentOptimizationProgress)
    return { ...complete, outcome: researchOutcome, domain: summary }
  })
  const { manager, options } = fixture(run)
  const dto = { ...task, checks, domain, executionLimit: 20 }
  const initial = await manager.start(dto)
  await vi.waitFor(async () =>
    expect((await manager.get(key(initial.runId))).state).toBe('completed')
  )
  const saved = await manager.get(key(initial.runId))
  expect(saved.outcome?.configuration.status).toBe('blocked')
  expect(saved.domain).toEqual(summary)
  expect(run.mock.calls[0][0]).toMatchObject({ checks, domain, executionLimit: 20 })
  expect(options.createOptions).toHaveBeenCalledWith(dto)
  for (const changed of [
    { ...dto, checks: [{ ...checks[0], expected: 4 }] },
    { ...dto, domain: { ...domain, name: 'other' } },
    {
      ...dto,
      domain: { ...domain, nextTasks: [{ ...domain.nextTasks[0], prompt: 'Changed task' }] }
    }
  ])
    await expect(manager.start(changed)).rejects.toThrow('conflicts')
  const reopened = new DesktopOptimizationManager(options)
  expect((await reopened.get(key(initial.runId))).outcome).toEqual(researchOutcome)
  expect((await reopened.start(dto)).runId).toBe(initial.runId)
})
it('keeps completed-but-unverified distinct from passing checks or configuration admission', async () => {
  const outcome = {
    artifact: { status: 'unverified' as const, checks: [] },
    configuration: { status: 'unverified' as const, reasons: ['No expected output supplied'] }
  }
  const { manager } = fixture(async () => ({ ...complete, outcome }))
  const initial = await manager.start(task)
  await vi.waitFor(async () =>
    expect((await manager.get(key(initial.runId))).state).toBe('completed')
  )
  expect((await manager.get(key(initial.runId))).outcome).toEqual(outcome)
})
it('retains an earlier task outcome when the shared domain stream is stopped before the next task completes', async () => {
  const summary = {
    name: domain.name,
    order: ['task1', 'task2'],
    tasks: [{ taskId: 'task1', outcome: researchOutcome }],
    library: { scope: 'experiment' as const, entries: [], digest: 'digest' }
  }
  const run = vi.fn(async (options: PersistentOptimizationOptions) => {
    options.onProgress!({
      optimizationId: 'opt',
      stage: 'optimizing',
      records: [],
      domain: summary
    } as import('./run-persistent-optimization').PersistentOptimizationProgress)
    await new Promise<void>((resolve) =>
      options.signal!.addEventListener('abort', () => resolve(), { once: true })
    )
    throw new Error('Stopped')
  })
  const { manager, release } = fixture(run)
  const initial = await manager.start({ ...task, domain, executionLimit: 20 })
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
  await manager.stop(key(initial.runId))
  await vi.waitFor(async () =>
    expect((await manager.get(key(initial.runId))).state).toBe('cancelled')
  )
  expect((await manager.get(key(initial.runId))).domain).toEqual(summary)
  expect(release).toHaveBeenCalledOnce()
  expect(await manager.shutdown()).toEqual({ reaped: true })
})
