import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StartDesktopSweep } from '../../shared/earthnano/optimization-sweep'
import type {
  PersistentOptimizationResult,
  PersistentOptimizationOptions
} from './run-persistent-optimization'
import {
  DesktopOptimizationManager,
  type DesktopOptimizationManagerOptions
} from './desktop-optimization-manager'
import { previewOptimizationSweep } from './sweep-plan'
import { writeResumeJson } from './optimization-resume'
import { outputDigest } from './output-checks'
import type { ResolvedOptimizationSweep } from './sweep-contract'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const request = (): StartDesktopSweep => ({
  projectId: 'p',
  sourceSessionId: 'navigation',
  requestKey: 'sweep',
  executionLimit: 40,
  catalog: ['a', 'b'].map((id) => ({
    taskId: id,
    domain: 'csv',
    sourceSessionId: `source-${id}`,
    source: { kind: 'text', prompt: `Private source ${id}`, files: [] },
    criteria: `Private criteria ${id}`
  })),
  sweep: {
    modes: ['parallel', 'sequential'],
    k: 1,
    concurrency: 2,
    stream: { seed: 0, onlyDomains: [], onlyTasks: [], maxTasks: null, workers: 1 }
  }
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- preserve manager fixture mock types
const create = async (run: NonNullable<DesktopOptimizationManagerOptions['run']>) => {
  const root = mkdtempSync(join(tmpdir(), 'earthnano-sweep-desktop-'))
  roots.push(root)
  const dto = request(),
    python = execFileSync(
      process.env.EARTHNANO_RESEARCH_PYTHON ?? 'python3',
      ['-c', 'import sys; print(sys.executable)'],
      { encoding: 'utf8' }
    ).trim()
  const plan = await previewOptimizationSweep({
    catalog: dto.catalog.map(({ taskId, domain }) => ({ taskId, domain })),
    options: dto.sweep,
    python,
    harnessRoot: resolve('vendor/harness2')
  })
  const sweep: ResolvedOptimizationSweep = {
    plan,
    request: dto,
    tasks: dto.catalog.map((task) => ({
      taskId: task.taskId,
      domain: task.domain,
      sourceSessionId: task.sourceSessionId,
      criteria: task.criteria,
      input: {
        task: { prompt: task.source.kind === 'text' ? task.source.prompt : '', files: [] },
        agent: {
          backend: 'claude-code',
          model: 'fixture',
          providerRef: 'fixture',
          runtimeVersion: '2.1.232'
        },
        harness: { instructions: 'Original harness', skills: [], tools: 'workspace-only' },
        environment: { isolation: 'directory-process', network: 'provider-only' }
      }
    }))
  }
  const release = vi.fn(),
    createOptions = vi.fn(),
    createSweepOptions = vi.fn(
      async () =>
        ({
          projectId: 'p',
          sourceSessionId: 'navigation',
          taskId: 'replaced',
          workRoot: '/replaced',
          harnessRoot: resolve('vendor/harness2'),
          python,
          ownerOptions: {},
          binding: vi.fn(),
          executionLimit: 40,
          sweep,
          releaseAdmission: release
        }) as unknown as PersistentOptimizationOptions
    )
  const options: DesktopOptimizationManagerOptions = {
    root,
    validateSession: vi.fn(async () => {}),
    createOptions,
    createSweepOptions,
    run
  }
  return {
    root,
    dto,
    sweep,
    release,
    options,
    createOptions,
    createSweepOptions,
    manager: new DesktopOptimizationManager(options)
  }
}
const complete: PersistentOptimizationResult = {
  optimizationId: 'opt',
  methodResult: {},
  records: [],
  sweep: {
    planDigest: 'plan',
    modes: ['parallel', 'sequential'],
    order: [{ domain: 'csv', taskIds: ['a', 'b'] }],
    domains: []
  }
}
const resumeFile = (options: PersistentOptimizationOptions, cleanup = 'confirmed'): void => {
  if (!options.sweep) throw new Error('Expected sweep')
  mkdirSync(options.workRoot, { recursive: true })
  const identity = {
    projectId: options.projectId,
    sourceSessionId: options.sourceSessionId,
    taskId: options.taskId,
    sweep: options.sweep,
    executionLimit: options.executionLimit!,
    executionTimeoutMs: 120000
  }
  writeResumeJson(join(options.workRoot, 'resume.json'), {
    schemaVersion: 2,
    optimizationId: 'opt',
    identity,
    identityDigest: outputDigest(identity),
    methodDigest: options.sweep.plan.methodDigest
  })
  writeFileSync(
    join(options.workRoot, 'execution.json'),
    JSON.stringify({ records: { prior: { phase: 'completed', cleanup } } })
  )
}

describe('sweep through original desktop manager lifecycle', () => {
  it('submits one immutable sweep through the same runner, projects results and keeps raw sources private', async () => {
    const run = vi.fn<
        (options: PersistentOptimizationOptions) => Promise<PersistentOptimizationResult>
      >(async () => structuredClone(complete)),
      f = await create(run)
    const started = await f.manager.startSweep(f.dto)
    f.dto.catalog[0].criteria = 'mutated caller'
    await vi.waitFor(async () =>
      expect(
        (
          await f.manager.get({
            projectId: 'p',
            sourceSessionId: 'navigation',
            runId: started.runId
          })
        ).state
      ).toBe('completed')
    )
    expect(f.createOptions).not.toHaveBeenCalled()
    expect(f.createSweepOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        catalog: expect.arrayContaining([
          expect.objectContaining({ criteria: 'Private criteria a' })
        ])
      }),
      expect.any(AbortSignal)
    )
    const actual = run.mock.calls[0][0] as PersistentOptimizationOptions
    expect(actual).toMatchObject({ taskId: started.runId, executionLimit: 40, sweep: f.sweep })
    expect(actual).not.toHaveProperty('input')
    expect(actual.workRoot).toBe(join(f.root, started.runId, 'execution'))
    expect(f.release).toHaveBeenCalledOnce()
    const projection = readFileSync(join(f.root, started.runId, 'desktop.json'), 'utf8')
    for (const secret of ['Private source', 'Private criteria', 'providerRef', 'source-a'])
      expect(projection).not.toContain(secret)
    expect(JSON.parse(projection).progress.sweep).toEqual(complete.sweep)
  })
  it('uses the same project fence and idempotency for sweep and legacy starts', async () => {
    let settle!: () => void
    const run = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          settle = resolve
        })
        return structuredClone(complete)
      }),
      f = await create(run)
    const first = await f.manager.startSweep(f.dto)
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect((await f.manager.startSweep(structuredClone(f.dto))).runId).toBe(first.runId)
    await expect(f.manager.startSweep({ ...f.dto, requestKey: 'other' })).rejects.toThrow(
      'active or unreconciled'
    )
    const changed = structuredClone(f.dto)
    changed.catalog[1].sourceSessionId = 'different'
    await expect(f.manager.startSweep(changed)).rejects.toThrow('conflicts')
    await expect(
      f.manager.start({
        projectId: 'p',
        sourceSessionId: 'navigation',
        requestKey: 'legacy',
        prompt: 'Legacy',
        files: [],
        criteria: 'Check',
        executionLimit: 9
      })
    ).rejects.toThrow('active or unreconciled')
    expect(run).toHaveBeenCalledOnce()
    settle()
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
  })
  it('stops pending source preparation through the same signal and releases it before completion', async () => {
    const run = vi.fn<
        (options: PersistentOptimizationOptions) => Promise<PersistentOptimizationResult>
      >(async () => structuredClone(complete)),
      f = await create(run)
    let admitted!: () => void
    f.options.createSweepOptions = vi.fn(async (_request, signal) => {
      await new Promise<void>((resolve) => {
        admitted = resolve
      })
      expect(signal!.aborted).toBe(true)
      f.release()
      throw signal!.reason
    })
    const manager = new DesktopOptimizationManager(f.options),
      started = await manager.startSweep(f.dto),
      key = { projectId: 'p', sourceSessionId: 'navigation', runId: started.runId }
    await vi.waitFor(() => expect(admitted).toBeTypeOf('function'))
    await manager.stop(key)
    admitted()
    await vi.waitFor(async () => expect((await manager.get(key)).state).toBe('cancelled'))
    expect(run).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledOnce()
  })
  it('reopens only an exact confirmed v2 experiment and reauthorizes its own original source request without resubmitting on open', async () => {
    const run = vi.fn(async (options: PersistentOptimizationOptions) => {
        resumeFile(options)
        if (!options.resume) {
          await new Promise<void>((resolve) =>
            options.signal!.addEventListener('abort', () => resolve(), { once: true })
          )
          throw new Error('Stopped')
        }
        return structuredClone(complete)
      }),
      f = await create(run)
    const started = await f.manager.startSweep(f.dto),
      key = { projectId: 'p', sourceSessionId: 'navigation', runId: started.runId }
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    await f.manager.stop(key)
    await vi.waitFor(async () =>
      expect(await f.manager.get(key)).toMatchObject({ state: 'cancelled', resumeAvailable: true })
    )
    const reopened = new DesktopOptimizationManager(f.options)
    expect(run).toHaveBeenCalledOnce()
    await reopened.resume(key)
    await vi.waitFor(async () => expect((await reopened.get(key)).state).toBe('completed'))
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][0]).toMatchObject({
      resume: true,
      taskId: started.runId,
      workRoot: run.mock.calls[0][0].workRoot,
      executionLimit: 40,
      sweep: f.sweep
    })
    expect(f.createSweepOptions).toHaveBeenLastCalledWith(f.dto, expect.any(AbortSignal))
    expect(f.createOptions).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledTimes(2)
  })
  it('keeps unknown physical cleanup fenced for v2 resume', async () => {
    const run = vi.fn(async (options: PersistentOptimizationOptions) => {
        resumeFile(options, 'unknown')
        throw new Error('Unknown cleanup')
      }),
      f = await create(run)
    const started = await f.manager.startSweep(f.dto),
      key = { projectId: 'p', sourceSessionId: 'navigation', runId: started.runId }
    await vi.waitFor(async () => expect((await f.manager.get(key)).state).toBe('failed'))
    expect((await f.manager.get(key)).resumeAvailable).not.toBe(true)
    await expect(f.manager.resume(key)).rejects.toThrow('cannot be resumed safely')
    expect(run).toHaveBeenCalledOnce()
  })
  it('refuses changed v2 source or criteria despite a recomputed private manifest digest', async () => {
    const run = vi.fn(async (options: PersistentOptimizationOptions) => {
        resumeFile(options)
        throw new Error('Stopped after confirmed cleanup')
      }),
      f = await create(run)
    const started = await f.manager.startSweep(f.dto),
      key = { projectId: 'p', sourceSessionId: 'navigation', runId: started.runId }
    await vi.waitFor(async () => expect((await f.manager.get(key)).resumeAvailable).toBe(true))
    const file = join(f.root, started.runId, 'execution', 'resume.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    manifest.identity.sweep.request.catalog[1].criteria = 'Replacement criteria'
    manifest.identityDigest = outputDigest(manifest.identity)
    writeResumeJson(file, manifest)
    expect((await f.manager.get(key)).resumeAvailable).not.toBe(true)
    await expect(f.manager.resume(key)).rejects.toThrow('differs from its desktop projection')
    expect(run).toHaveBeenCalledOnce()
  })
  it('does not reinterpret a legacy entry as a sweep through extra catalog fields', async () => {
    const run = vi.fn(async () => structuredClone(complete)),
      f = await create(run)
    await expect(
      f.manager.start({
        ...f.dto,
        prompt: 'Legacy',
        files: [],
        criteria: 'Check'
      } as unknown as Parameters<DesktopOptimizationManager['start']>[0])
    ).rejects.toThrow('Invalid optimization profile')
    expect(f.createSweepOptions).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})
