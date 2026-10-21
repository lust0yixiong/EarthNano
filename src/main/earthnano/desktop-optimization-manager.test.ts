import {
  createSynchronousFileDurability,
  defaultSynchronousFileDurability
} from '@aipoch/durable-files'
import {
  closeSync,
  fsyncSync,
  openSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { normalizeOptimizationMethod } from '../../shared/earthnano/optimization-method'
import { writeResumeJson, type SingleOptimizationResumeIdentity } from './optimization-resume'
import { outputDigest } from './output-checks'

const fsyncControl = vi.hoisted(() => ({
  failure: undefined as Error | undefined,
  target: 'directory' as 'file' | 'directory',
  attempts: [] as Array<{ fd: number; directory: boolean }>
}))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return {
    ...actual,
    fsyncSync: (fd: number): void => {
      const directory = actual.fstatSync(fd).isDirectory()
      fsyncControl.attempts.push({ fd, directory })
      if (fsyncControl.failure && directory === (fsyncControl.target === 'directory'))
        throw fsyncControl.failure
      actual.fsyncSync(fd)
    }
  }
})

beforeEach(() => {
  vi.spyOn(defaultSynchronousFileDurability, 'syncDirectory').mockImplementation((path) => {
    createSynchronousFileDurability({
      platform: process.platform,
      openHandle: (directory, flags) => {
        const fd = openSync(directory, flags)
        return { sync: () => fsyncSync(fd), close: () => closeSync(fd) }
      }
    }).syncDirectory(path)
  })
})

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  fsyncControl.failure = undefined
  fsyncControl.attempts.length = 0
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
const notebookInput = {
  sourceKind: 'upload-version' as const,
  sourceProjectId: task.projectId,
  sourceSessionId: task.sourceSessionId,
  sourceFileId: 'source-file',
  inputFileVersionId: 'source-version',
  filename: 'values.csv',
  sizeBytes: 7,
  checksum: 'a'.repeat(64)
}
const notebookSnapshot = (language: 'python' | 'r'): SingleOptimizationResumeIdentity['input'] => ({
  task: { prompt: task.prompt, files: [], managedInputs: [notebookInput] },
  harness: { instructions: 'Original harness', tools: `notebook-${language}`, skills: [] },
  agent: {
    backend: 'claude-code',
    model: 'fixture',
    providerRef: 'fixture',
    runtimeVersion: 'fixture'
  },
  environment: {
    isolation: 'directory-process',
    network: 'provider-and-notebook-policy',
    notebook: {
      runtime: {
        language,
        runtimeId: `/original/${language}`,
        interpreterPath: `/original/${language}`,
        source: 'external',
        provenance: 'user-own'
      }
    }
  }
})
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
const writeResumeFixture = (
  options: PersistentOptimizationOptions,
  cleanup = 'confirmed',
  overrides: Partial<SingleOptimizationResumeIdentity> = {}
): void => {
  mkdirSync(options.workRoot, { recursive: true })
  const identity: SingleOptimizationResumeIdentity = {
    projectId: task.projectId,
    sourceSessionId: task.sourceSessionId,
    taskId: options.taskId,
    input: {
      task: { prompt: task.prompt, files: task.files },
      harness: { instructions: 'Original harness', tools: 'workspace-only', skills: [] },
      agent: {
        backend: 'claude-code',
        model: 'fixture',
        providerRef: 'fixture',
        runtimeVersion: 'fixture'
      },
      environment: { isolation: 'directory-process', network: 'provider-only' }
    },
    semanticCriteria: task.criteria,
    executionLimit: task.executionLimit,
    executionTimeoutMs: 120_000,
    method: normalizeOptimizationMethod(task.method),
    ...overrides
  }
  writeResumeJson(join(options.workRoot, 'resume.json'), {
    schemaVersion: 1,
    optimizationId: 'opt',
    identity,
    identityDigest: outputDigest(identity),
    methodDigest: `sha256:${'a'.repeat(64)}`
  })
  writeFileSync(
    join(options.workRoot, 'execution.json'),
    JSON.stringify({
      records: { prior: { phase: 'completed', cleanup } }
    })
  )
}

describe('DesktopOptimizationManager', () => {
  it.each(['python', 'r'] as const)(
    'restores the frozen %s language for a legacy Notebook experiment after reopen',
    async (language) => {
      const notebook = {
        promptMessageId: 'source-prompt',
        ...(language === 'r' ? { language } : {})
      }
      const run = vi.fn(async (options: PersistentOptimizationOptions) => {
        writeResumeFixture(options, 'confirmed', {
          sourcePromptMessageId: notebook.promptMessageId,
          input: notebookSnapshot(language)
        })
        if (!options.resume) throw new Error('Interrupted original experiment')
        return complete
      })
      const f = fixture(run, {
        createOptions: vi.fn(
          async () =>
            ({ input: notebookSnapshot(language) }) as unknown as PersistentOptimizationOptions
        )
      })
      const started = await f.manager.start({ ...task, files: [], notebook })
      await vi.waitFor(async () =>
        expect(await f.manager.get(key(started.runId))).toMatchObject({
          state: 'failed',
          resumeAvailable: true
        })
      )
      const original = run.mock.calls[0]![0]
      const reopened = new DesktopOptimizationManager(f.options)
      await reopened.resume(key(started.runId))
      await vi.waitFor(async () =>
        expect((await reopened.get(key(started.runId))).state).toBe('completed')
      )
      expect(f.options.createOptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ notebook }),
        expect.any(AbortSignal)
      )
      const requests = vi.mocked(f.options.createOptions).mock.calls
      expect(requests[requests.length - 1]![0].notebook).toStrictEqual(notebook)
      expect(run).toHaveBeenCalledTimes(2)
      expect(run.mock.calls[1]![0]).toMatchObject({
        resume: true,
        taskId: original.taskId,
        workRoot: original.workRoot,
        executionLimit: task.executionLimit
      })
    }
  )

  it('refuses legacy Notebook resume when the frozen profile and runtime languages disagree', async () => {
    const run = vi.fn(async (options: PersistentOptimizationOptions) => {
      writeResumeFixture(options)
      const filename = join(options.workRoot, 'resume.json')
      const manifest = JSON.parse(readFileSync(filename, 'utf8'))
      manifest.identity.sourcePromptMessageId = 'source-prompt'
      manifest.identity.input.task = {
        prompt: task.prompt,
        files: [],
        managedInputs: [notebookInput]
      }
      manifest.identity.input.harness.tools = 'notebook-r'
      manifest.identity.input.environment.notebook = { runtime: { language: 'python' } }
      manifest.identityDigest = outputDigest(manifest.identity)
      writeResumeJson(filename, manifest)
      throw new Error('Interrupted original experiment')
    })
    const f = fixture(run, {
      createOptions: vi.fn(
        async () => ({ input: notebookSnapshot('r') }) as unknown as PersistentOptimizationOptions
      )
    })
    const started = await f.manager.start({
      ...task,
      files: [],
      notebook: { promptMessageId: 'source-prompt', language: 'r' }
    })
    await vi.waitFor(async () =>
      expect((await f.manager.get(key(started.runId))).state).toBe('failed')
    )
    const reopened = new DesktopOptimizationManager(f.options)
    expect((await reopened.get(key(started.runId))).resumeAvailable).not.toBe(true)
    await expect(reopened.resume(key(started.runId))).rejects.toThrow(
      'Original Notebook profile differs from its frozen runtime language'
    )
    expect(f.options.createOptions).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('resumes only the original stopped experiment after reopen, retaining its task, path and budget', async () => {
    const run = vi.fn(async (options: PersistentOptimizationOptions) => {
      // This seam tests desktop authority/forwarding; the original runner validates the real
      // descriptor and owners in its separate native resume integration tests.
      writeResumeFixture(options)
      if (!options.resume) {
        await new Promise<void>((resolve) =>
          options.signal!.addEventListener('abort', () => resolve(), { once: true })
        )
        throw new Error('Stopped original experiment')
      }
      return complete
    })
    const f = fixture(run)
    const started = await f.manager.start(task)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    const original = run.mock.calls[0]![0]
    await f.manager.stop(key(started.runId))
    await vi.waitFor(async () =>
      expect(await f.manager.get(key(started.runId))).toMatchObject({
        state: 'cancelled',
        resumeAvailable: true
      })
    )
    const reopened = new DesktopOptimizationManager(f.options)
    expect(run).toHaveBeenCalledTimes(1)
    expect(await reopened.latest(task)).toMatchObject({ resumeAvailable: true })
    await reopened.resume(key(started.runId))
    await vi.waitFor(async () =>
      expect((await reopened.get(key(started.runId))).state).toBe('completed')
    )
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1]![0]).toMatchObject({
      resume: true,
      taskId: original.taskId,
      workRoot: original.workRoot,
      executionLimit: task.executionLimit,
      semanticCriteria: task.criteria
    })
    expect(f.options.createOptions).toHaveBeenLastCalledWith(
      { ...task, method: normalizeOptimizationMethod(task.method) },
      expect.any(AbortSignal)
    )
    expect(await reopened.resume(key(started.runId))).toMatchObject({ state: 'completed' })
    expect(run).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(await reopened.get(key(started.runId)))).not.toContain(task.prompt)
    expect(readFileSync(join(f.root, started.runId, 'desktop.json'), 'utf8')).not.toContain(
      task.prompt
    )
  })

  it('refuses a stopped experiment whose original physical cleanup is unknown', async () => {
    const run = vi.fn(async (options: PersistentOptimizationOptions) => {
      writeResumeFixture(options, 'unknown')
      throw new Error('Owner evidence unavailable')
    })
    const f = fixture(run)
    const started = await f.manager.start(task)
    await vi.waitFor(async () =>
      expect((await f.manager.get(key(started.runId))).state).toBe('failed')
    )
    expect((await f.manager.get(key(started.runId))).resumeAvailable).not.toBe(true)
    await expect(f.manager.resume(key(started.runId))).rejects.toThrow('cannot be resumed safely')
    expect(run).toHaveBeenCalledTimes(1)
  })

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
  it('persists usage coverage and reviewer admissions without replay on reopen', async () => {
    const measured = record('b', 'baseline', 'completed')
    measured.identity.promptMessageId = 'prompt'
    measured.usage = {
      status: 'known',
      inputTokens: 7,
      cacheTokens: 5,
      outputTokens: 4,
      modelTurns: 2,
      source: {
        scope: 'logical-prompt',
        sessionId: 'session-b',
        promptMessageId: 'prompt',
        ownerMessageId: 'answer'
      }
    }
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
        records: [measured, record('r', 'reviewer', 'completed')]
      }
    })
    const { manager, options, release, root } = fixture(run)
    const admitted = await manager.start(task)
    await vi.waitFor(async () =>
      expect((await manager.get(key(admitted.runId))).state).toBe('completed')
    )
    const progress = await manager.get(key(admitted.runId))
    expect(progress.budget).toEqual({ limit: 9, admitted: 2, completed: 2, active: 0 })
    expect(progress.usage).toMatchObject({
      admittedExecutions: 2,
      tokens: {
        status: 'partial',
        coveredExecutions: 1,
        inputTokens: 7,
        cacheTokens: 5,
        outputTokens: 4
      },
      modelTurns: { status: 'partial', coveredExecutions: 1, total: 2 },
      apiRequests: { status: 'unknown', coveredExecutions: 0 },
      costMicrousd: { status: 'unknown', coveredExecutions: 0 }
    })
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
  expect(options.createOptions).toHaveBeenCalledWith(dto, expect.any(AbortSignal))
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

const previewDto = {
  projectId: 'project',
  sourceSessionId: 'source',
  catalog: [{ taskId: 'a', domain: 'd' }],
  sweep: {
    modes: ['parallel' as const],
    k: 1,
    concurrency: 1,
    stream: { seed: null, onlyDomains: [], onlyTasks: [], maxTasks: null, workers: 1 }
  }
}
const previewResult = {
  planDigest: 'sha256:fixed',
  order: [{ domain: 'd', taskIds: ['a'] }],
  modes: ['parallel' as const],
  minimumExecutions: 10
}
it('previews without creating persistent runs, invoking Core or occupying start admission', async () => {
  const previewSweep = vi.fn().mockResolvedValue(previewResult),
    run = vi.fn()
  const { manager, options, root } = fixture(run, { previewSweep })
  expect(await manager.previewSweep(previewDto)).toEqual(previewResult)
  expect(previewSweep).toHaveBeenCalledWith(previewDto, expect.any(AbortSignal))
  expect(options.createOptions).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
  expect(readdirSync(root)).toEqual([])
  expect(manager.hasActiveWork()).toBe(false)
})
it('rejects cross-project/extra-field previews before original planning', async () => {
  const previewSweep = vi.fn(),
    validateSession = vi.fn(async (projectId: string) => {
      if (projectId !== 'project') throw new Error('wrong project')
    })
  const { manager } = fixture(vi.fn(), { previewSweep, validateSession })
  await expect(manager.previewSweep({ ...previewDto, projectId: 'other' })).rejects.toThrow(
    'wrong project'
  )
  await expect(
    manager.previewSweep({ ...previewDto, provider: 'secret' } as typeof previewDto)
  ).rejects.toThrow()
  expect(previewSweep).not.toHaveBeenCalled()
})
it.each(['shutdown', 'prepareForUpdateGate'] as const)(
  'cancels active preview and waits for physical settlement during %s',
  async (operation) => {
    let finish!: () => void, signal!: AbortSignal
    const previewSweep = vi.fn((_request, originalSignal: AbortSignal) => {
      signal = originalSignal
      return new Promise<typeof previewResult>((resolve) => {
        finish = () => resolve(previewResult)
      })
    })
    const { manager } = fixture(vi.fn(), { previewSweep })
    const preview = manager.previewSweep(previewDto)
    const rejected = expect(preview).rejects.toThrow()
    await vi.waitFor(() => expect(previewSweep).toHaveBeenCalledOnce())
    expect(manager.hasActiveWork()).toBe(true)
    let settled = false
    const stopping = manager[operation]().then((outcome) => {
      settled = true
      return outcome
    })
    expect(signal.aborted).toBe(true)
    await Promise.resolve()
    expect(settled).toBe(false)
    await expect(manager.previewSweep(previewDto)).rejects.toThrow('closed')
    finish()
    expect(await stopping).toEqual({ reaped: true })
    await rejected
    expect(manager.hasActiveWork()).toBe(false)
    if (operation === 'prepareForUpdateGate') {
      manager.releaseUpdateGate()
      previewSweep.mockResolvedValueOnce(previewResult)
      expect(await manager.previewSweep(previewDto)).toEqual(previewResult)
    }
  }
)
it('does not launch a preview after close during authorization', async () => {
  let release!: () => void
  const validateSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    ),
    previewSweep = vi.fn()
  const { manager } = fixture(vi.fn(), { validateSession, previewSweep })
  const pending = manager.previewSweep(previewDto)
  const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(validateSession).toHaveBeenCalledOnce())
  const closing = manager.shutdown()
  release()
  expect(await closing).toEqual({ reaped: true })
  await rejected
  expect(previewSweep).not.toHaveBeenCalled()
})
it('Stop remains available while preview is pending and does not wait on its subprocess', async () => {
  let endPreview!: () => void
  const previewSweep = vi.fn(
    () =>
      new Promise<typeof previewResult>((resolve) => {
        endPreview = () => resolve(previewResult)
      })
  )
  const run = vi.fn(async (options: PersistentOptimizationOptions) => {
    await new Promise<void>((resolve) =>
      options.signal!.addEventListener('abort', () => resolve(), { once: true })
    )
    throw new Error('cancelled')
  })
  const { manager } = fixture(run, { previewSweep })
  const started = await manager.start(task)
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
  const pending = manager.previewSweep(previewDto)
  await vi.waitFor(() => expect(previewSweep).toHaveBeenCalledOnce())
  expect((await manager.stop(key(started.runId))).state).toBe('stopping')
  await vi.waitFor(async () =>
    expect((await manager.get(key(started.runId))).state).toBe('cancelled')
  )
  expect(manager.hasActiveWork()).toBe(true)
  endPreview()
  await pending
  expect(await manager.shutdown()).toEqual({ reaped: true })
})

it.each(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'])(
  'retains original desktop metadata after Windows directory sync returns %s',
  async (code) => {
    const f = fixture(vi.fn(async () => complete))
    fsyncControl.failure = Object.assign(new Error(code), { code })
    fsyncControl.target = 'directory'
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    const started = await f.manager.start(task)
    await vi.waitFor(async () =>
      expect((await f.manager.get(key(started.runId))).state).toBe('completed')
    )
    expect(await f.manager.shutdown()).toEqual({ reaped: true })
    const saved = JSON.parse(readFileSync(join(f.root, started.runId, 'desktop.json'), 'utf8'))
    expect(saved.progress.state).toBe('completed')
    expect(fsyncControl.attempts.some(({ directory }) => !directory)).toBe(true)
    expect(
      fsyncControl.attempts.filter(({ directory }) => directory).length
    ).toBeGreaterThanOrEqual(2)
    expect(() => fstatSync(fsyncControl.attempts.at(-1)!.fd)).toThrow()
  }
)

it.each([
  ['linux', 'directory', 'EPERM'],
  ['darwin', 'directory', 'EPERM'],
  ['win32', 'directory', 'EIO'],
  ['win32', 'file', 'EPERM']
] as const)(
  'refuses desktop dispatch after a %s %s %s barrier failure',
  async (platform, target, code) => {
    const run = vi.fn(async () => complete)
    const f = fixture(run)
    const failure = Object.assign(new Error('desktop barrier'), { code })
    fsyncControl.failure = failure
    fsyncControl.target = target
    vi.stubGlobal('process', { ...process, platform })
    await expect(f.manager.start(task)).rejects.toBe(failure)
    expect(run).not.toHaveBeenCalled()
  }
)
