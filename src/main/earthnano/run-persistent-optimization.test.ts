import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
const f = vi.hoisted(() => ({
  method: vi.fn(),
  evaluate: vi.fn(),
  shutdown: vi.fn(),
  dispose: vi.fn(),
  core: vi.fn(),
  budget: vi.fn(),
  get: vi.fn(),
  exportResult: vi.fn(),
  readReviews: vi.fn(),
  ownerOptions: vi.fn(),
  executionIds: ['baseline'],
  settle: vi.fn(async () => true),
  outcome: vi.fn(async () => ({
    artifact: { status: 'unverified', checks: [] },
    configuration: { status: 'unverified', reasons: ['no-deterministic-checks'] }
  }))
}))
vi.mock('./candidate-snapshot', () => ({
  createCandidateSnapshotStore: async () => ({ freeze: async () => ({}) })
}))
vi.mock('./claude-candidate-driver', () => ({ createClaudeCandidateDriver: () => ({}) }))
vi.mock('./execution-core', async (original) => ({
  ...(await original<typeof import('./execution-core')>()),
  ExecutionCore: class {
    constructor(...args: unknown[]) {
      f.core(...args)
    }
    configureBudget = f.budget
    get = f.get
    dispose = f.dispose
    settle = f.settle
  }
}))
vi.mock('./harness-optimization', () => ({
  HarnessOptimizationBinding: class {
    executionIds = f.executionIds
    stop = async (): Promise<void> => {}
  },
  runHarnessProcess: f.method
}))
vi.mock('./persistent-candidate-owner', () => ({
  createPersistentCandidateOwners: (options: unknown) => {
    f.ownerOptions(options)
    return {
      exportResult: f.exportResult,
      readReviews: f.readReviews,
      shutdown: f.shutdown
    }
  }
}))
vi.mock('./semantic-evaluation', async (original) => ({
  ...(await original<typeof import('./semantic-evaluation')>()),
  evaluateOptimizationSemantics: f.evaluate
}))
vi.mock('./research-verification', () => ({ evaluateResearchOutcome: f.outcome }))
import {
  runPersistentOptimization,
  type PersistentOptimizationOptions,
  type PersistentSingleOptimizationOptions
} from './run-persistent-optimization'
import {
  MAX_TIMER_TIMEOUT_MS,
  MAX_HARNESS_EXECUTION_TIMEOUT_MS,
  HARNESS_RPC_TIMEOUT_MARGIN_MS
} from './execution-timeout'
import { previewOptimizationSweep } from './sweep-plan'
const roots: string[] = []
beforeEach(() => {
  f.executionIds = ['baseline']
  f.get.mockResolvedValue({ phase: 'completed', cleanup: 'confirmed' })
  f.exportResult.mockResolvedValue(undefined)
  f.readReviews.mockResolvedValue([{ lifecycle: 'complete', outcome: 'pass' }])
})
afterEach(async () => {
  vi.clearAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const options = async (): Promise<PersistentSingleOptimizationOptions> => {
  const root = await mkdtemp(join(tmpdir(), 'earthnano-deadline-'))
  roots.push(root)
  return {
    projectId: 'p',
    taskId: 't',
    workRoot: join(root, 'run'),
    harnessRoot: resolve('vendor/harness2'),
    input: {
      task: { prompt: 'Task', files: [] },
      harness: { instructions: 'Instructions', skills: [], tools: 'workspace-only' },
      agent: {
        backend: 'claude-code',
        model: 'model',
        providerRef: 'provider',
        runtimeVersion: '2.1.232'
      },
      environment: { isolation: 'directory-process', network: 'provider-only' }
    },
    ownerOptions: {} as PersistentOptimizationOptions['ownerOptions'],
    binding: async () => {
      throw new Error('Unexpected binding')
    },
    semanticCriteria: 'Original criterion',
    timeoutMs: 1000
  }
}
it('resolves a trusted host work-root alias before allocating binary projections', async () => {
  const o = await options()
  const root = roots.at(-1)!
  const host = join(root, 'canonical-host')
  const alias = join(root, 'host-alias')
  await mkdir(host, { mode: 0o700 })
  await symlink(host, alias, 'junction')
  o.workRoot = join(alias, 'run')
  f.executionIds = []
  f.method.mockRejectedValue(new Error('HOST_PATH_OBSERVED_NO_ADMISSIONS'))
  f.shutdown.mockResolvedValue({ reaped: true })
  await expect(runPersistentOptimization(o)).rejects.toThrow('HOST_PATH_OBSERVED_NO_ADMISSIONS')
  expect(f.ownerOptions).toHaveBeenCalledExactlyOnceWith({
    ...o.ownerOptions,
    artifactProjectionRoot: join(await realpath(o.workRoot), 'artifact-projections')
  })
  expect(f.evaluate).not.toHaveBeenCalled()
})
it('emits a private sweep configuration accepted by the real Python entry before any method admission', async () => {
  const o = await options()
  const python = execFileSync(
    process.env.EARTHNANO_RESEARCH_PYTHON ?? 'python3',
    ['-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf8' }
  ).trim()
  const request = {
    projectId: o.projectId,
    sourceSessionId: 'source',
    requestKey: 'sweep',
    executionLimit: 20,
    catalog: [
      {
        taskId: 'task',
        domain: 'research',
        sourceSessionId: 'source',
        source: { kind: 'text' as const, prompt: o.input.task.prompt, files: [] },
        criteria: 'Private acceptance criterion'
      }
    ],
    sweep: {
      modes: ['parallel' as const, 'sequential' as const],
      k: 1,
      concurrency: 2,
      stream: { seed: null, onlyDomains: [], onlyTasks: [], maxTasks: null, workers: 1 }
    }
  }
  const plan = await previewOptimizationSweep({
    catalog: [{ taskId: 'task', domain: 'research' }],
    options: request.sweep,
    python,
    harnessRoot: o.harnessRoot
  })
  f.shutdown.mockResolvedValue({ reaped: true })
  f.method.mockImplementationOnce(async ({ args }: { args: string[] }) => {
    const sources = JSON.parse(await readFile(join(o.workRoot, 'sweep-sources.json'), 'utf8'))
    expect(sources.tasks[0]).toMatchObject({ taskId: 'task', sourceSessionId: 'source' })
    expect(sources.tasks[0]).not.toHaveProperty('sourcePromptMessageId')
    expect(sources.tasks[0]).not.toHaveProperty('inputArtifacts')
    const encoded = await readFile(args.at(-1)!, 'utf8')
    expect(encoded).not.toContain('Private acceptance criterion')
    const config = JSON.parse(encoded)
    execFileSync(
      python,
      [
        '-B',
        '-c',
        'import json,sys; from harness2.earthnano_sweep import validate_config; validate_config(json.load(sys.stdin))'
      ],
      {
        cwd: o.harnessRoot,
        env: { PATH: process.env.PATH, PYTHONPATH: o.harnessRoot, PYTHONDONTWRITEBYTECODE: '1' },
        input: encoded,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    expect(config.coreConcurrency).toBe(2)
    expect(config.bindingIdentity.modes).toEqual(['agg', 'seq'])
    throw new Error('CONFIG_VALIDATED_NO_ADMISSIONS')
  })
  const input = o.input
  await expect(
    runPersistentOptimization({
      projectId: o.projectId,
      taskId: o.taskId,
      workRoot: o.workRoot,
      harnessRoot: o.harnessRoot,
      ownerOptions: o.ownerOptions,
      binding: o.binding,
      timeoutMs: 10_000,
      python,
      sourceSessionId: 'source',
      executionLimit: 20,
      sweep: {
        plan,
        request,
        tasks: [
          {
            taskId: 'task',
            domain: 'research',
            sourceSessionId: 'source',
            input,
            criteria: 'Private acceptance criterion'
          }
        ]
      }
    })
  ).rejects.toThrow('CONFIG_VALIDATED_NO_ADMISSIONS')
  expect(f.evaluate).not.toHaveBeenCalled()
})
it('projects zero-input Compute into the original method without relaxing its Notebook input guard', async () => {
  const o = await options()
  o.sourceSessionId = 'source'
  o.sourcePromptMessageId = 'source-prompt'
  o.input = {
    ...o.input,
    task: { ...o.input.task, managedInputs: [] },
    harness: { ...o.input.harness, tools: 'notebook-compute' },
    environment: {
      isolation: 'directory-process',
      network: 'provider-and-notebook-policy',
      compute: {
        sourceProjectId: o.projectId,
        sourceSessionId: 'source',
        access: { enabledProviderIds: [], selectedProviderIds: [] },
        hosts: []
      }
    }
  }
  o.ownerOptions = {
    notebook: {},
    compute: {}
  } as PersistentOptimizationOptions['ownerOptions']
  f.executionIds = []
  f.shutdown.mockResolvedValue({ reaped: true })
  f.method.mockImplementationOnce(async ({ args }: { args: string[] }) => {
    const encoded = await readFile(args.at(-1)!, 'utf8')
    expect(JSON.parse(encoded).task).toEqual({ prompt: 'Task', files: [] })
    execFileSync(
      process.env.EARTHNANO_RESEARCH_PYTHON ?? 'python3',
      [
        '-B',
        '-c',
        [
          'import json,sys',
          'from harness2.earthnano import validate_config,validate_managed_inputs',
          'validate_config(json.load(sys.stdin))',
          'try: validate_managed_inputs([])',
          'except ValueError: pass',
          'else: raise AssertionError("Original Notebook input guard was relaxed")'
        ].join('\n')
      ],
      {
        cwd: o.harnessRoot,
        env: { PATH: process.env.PATH, PYTHONPATH: o.harnessRoot, PYTHONDONTWRITEBYTECODE: '1' },
        input: encoded,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    throw new Error('COMPUTE_CONFIG_VALIDATED_NO_ADMISSIONS')
  })
  await expect(runPersistentOptimization(o)).rejects.toThrow(
    'COMPUTE_CONFIG_VALIDATED_NO_ADMISSIONS'
  )
  expect(o.input.task.managedInputs).toEqual([])
  const resume = JSON.parse(await readFile(join(o.workRoot, 'resume.json'), 'utf8'))
  expect(resume.identity.input.task.managedInputs).toEqual([])
  expect(f.evaluate).not.toHaveBeenCalled()
})
it('applies one overall deadline across method and assessment, then awaits cleanup before rejecting', async () => {
  const o = await options()
  o.timeoutMs = 80
  const deadline = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  onTestFinished(() => timeout.mockRestore())
  let finishCleanup!: () => void
  let assessmentEntered!: () => void
  const assessing = new Promise<void>((resolve) => {
    assessmentEntered = resolve
  })
  f.method.mockResolvedValue({ status: 'ok' })
  f.evaluate.mockImplementation(
    async ({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        assessmentEntered()
      })
  )
  f.shutdown.mockImplementation(async () => {
    await new Promise<void>((r) => {
      finishCleanup = r
    })
    return { reaped: true }
  })
  let settled = false
  const result = runPersistentOptimization(o).finally(() => {
    settled = true
  })
  const rejected = expect(result).rejects.toThrow()
  await assessing
  expect(timeout).toHaveBeenCalledExactlyOnceWith(80)
  deadline.abort(new DOMException('Deadline expired', 'TimeoutError'))
  await vi.waitFor(() => expect(f.shutdown).toHaveBeenCalledOnce())
  expect(f.method.mock.calls[0][0].signal).toBe(f.evaluate.mock.calls[0][0].signal)
  expect(f.evaluate.mock.calls[0][0].signal.aborted).toBe(true)
  expect(settled).toBe(false)
  finishCleanup()
  await rejected
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(
    JSON.parse(await readFile(join(o.workRoot, 'failure-diagnostics.jsonl'), 'utf8'))
  ).toMatchObject({ stage: 'semantic-assessment', category: 'deadline' })
})

it('preserves deadline expiry before assessment without dispatching a reviewer or new execution', async () => {
  const o = await options(),
    deadline = new AbortController()
  o.timeoutMs = 80
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  onTestFinished(() => timeout.mockRestore())
  f.method.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
    deadline.abort(new DOMException('Deadline expired', 'TimeoutError'))
    signal.throwIfAborted()
  })
  f.shutdown.mockResolvedValue({ reaped: true })
  await expect(runPersistentOptimization(o)).rejects.toMatchObject({ name: 'TimeoutError' })
  expect(f.evaluate).not.toHaveBeenCalled()
  expect(f.get).not.toHaveBeenCalled()
  expect(f.shutdown).toHaveBeenCalledOnce()
  expect(f.settle).toHaveBeenCalledOnce()
  expect(timeout).toHaveBeenCalledExactlyOnceWith(80)
  expect(JSON.parse(await readFile(join(o.workRoot, 'failure-diagnostics.jsonl'), 'utf8'))).toEqual(
    { schemaVersion: 1, stage: 'method-process', category: 'deadline' }
  )
})
it('freezes the criteria and input before the method runs and keeps the plan outside its config', async () => {
  const o = await options()
  f.method.mockImplementation(async () => {
    o.semanticCriteria = 'Changed later'
    o.input = { ...o.input, task: { prompt: 'Changed later task', files: [] } }
    return { status: 'ok' }
  })
  f.evaluate.mockResolvedValue({ baseline: {}, candidate: {} })
  f.shutdown.mockResolvedValue({ reaped: true })
  await runPersistentOptimization(o)
  expect(f.evaluate.mock.calls[0][0].criteria).toBe('Original criterion')
  expect(f.evaluate.mock.calls[0][0].input.task.prompt).toBe('Task')
  const plan = JSON.parse(await readFile(join(o.workRoot, 'assessment-plan.json'), 'utf8'))
  expect(plan.criteria).toBe('Original criterion')
  expect(await readFile(join(o.workRoot, 'method-config.json'), 'utf8')).not.toContain(
    'Original criterion'
  )
  const outcome = JSON.parse(await readFile(join(o.workRoot, 'outcome-t.json'), 'utf8'))
  expect(outcome.configurationPublication).toBe('not-published')
  expect(outcome.outcome.configuration.status).toBe('unverified')
})

it('binds source provenance to the actual frozen input and rejects mismatches before allocating or executing', async () => {
  const o = await options()
  o.sourceSessionId = 'source'
  o.inputArtifacts = [
    { artifactId: 'artifact', versionId: 'version', checksum: 'a'.repeat(64), path: 'source.txt' }
  ]
  await expect(runPersistentOptimization(o)).rejects.toThrow('differs from its source')
  await expect(access(o.workRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.method).not.toHaveBeenCalled()
})
it('captures exact source identities before the method can mutate caller options', async () => {
  const o = await options(),
    content = 'fixed source'
  o.sourceSessionId = 'source'
  o.input = { ...o.input, task: { prompt: 'Task', files: [{ path: 'source.txt', content }] } }
  o.inputArtifacts = [
    {
      artifactId: 'artifact',
      versionId: 'version',
      path: 'source.txt',
      checksum: createHash('sha256').update(content).digest('hex')
    }
  ]
  f.method.mockImplementation(async () => {
    o.inputArtifacts![0].versionId = 'changed'
    o.sourceSessionId = 'changed'
    return { status: 'ok' }
  })
  f.evaluate.mockResolvedValue({ baseline: {}, candidate: {} })
  f.shutdown.mockResolvedValue({ reaped: true })
  await runPersistentOptimization(o)
  expect(
    JSON.parse(await readFile(join(o.workRoot, 'input-artifacts.json'), 'utf8'))
  ).toMatchObject({
    sourceSessionId: 'source',
    artifacts: [{ versionId: 'version' }],
    tasks: [{ taskId: 't', inputDigest: expect.stringMatching(/^sha256:/) }]
  })
})

it('retains the declared domain order without claiming results when its method fails early', async () => {
  const o = await options()
  o.domain = {
    name: 'rows',
    nextTasks: [{ prompt: 'Second', files: [], criteria: 'Private next criterion' }]
  }
  const progress: unknown[] = []
  o.onProgress = (value) => progress.push(structuredClone(value))
  f.method.mockRejectedValueOnce(new Error('Method stopped before completion'))
  f.shutdown.mockResolvedValue({ reaped: true })
  await expect(runPersistentOptimization(o)).rejects.toThrow('Method stopped')
  expect(progress.at(-1)).toMatchObject({
    stage: 'settled',
    domain: {
      name: 'rows',
      order: ['t-0001', 't-0002'],
      tasks: [{ taskId: 't-0001' }, { taskId: 't-0002' }],
      library: { scope: 'experiment', entries: [] }
    }
  })
  expect(progress.at(-1)).not.toHaveProperty('outcome')
  expect(f.evaluate).not.toHaveBeenCalled()
  expect(await readFile(join(o.workRoot, 'method-config.json'), 'utf8')).not.toContain(
    'Private next criterion'
  )
})

it('records only a private host phase while rethrowing the exact method error and preserving cleanup', async () => {
  const o = await options()
  const error = new Error('PRIVATE_TOKEN_provider_text_mission')
  let records: unknown[] | undefined
  f.method.mockImplementationOnce(async () => {
    const journal = (
      f.core.mock.calls[0][0] as { load(): { records: Record<string, unknown> } }
    ).load()
    records = Object.values(journal.records)
    throw error
  })
  f.shutdown.mockResolvedValue({ reaped: true })
  await expect(runPersistentOptimization(o)).rejects.toBe(error)
  expect(f.method).toHaveBeenCalledOnce()
  expect(f.evaluate).not.toHaveBeenCalled()
  expect(f.shutdown).toHaveBeenCalledOnce()
  expect(f.settle).toHaveBeenCalledOnce()
  const diagnostic = await readFile(join(o.workRoot, 'failure-diagnostics.jsonl'), 'utf8')
  expect(JSON.parse(diagnostic)).toEqual({
    schemaVersion: 1,
    stage: 'method-process',
    category: 'stage-failed'
  })
  expect(diagnostic).not.toContain('PRIVATE_TOKEN')
  expect(records).toEqual([])
  expect(f.budget).toHaveBeenCalledExactlyOnceWith('p', expect.any(String), 10)
})

it.each(['../outside', 'rows.', 'nested/task'])(
  'rejects nonportable task ID %s before allocation',
  async (taskId) => {
    const o = await options()
    await expect(runPersistentOptimization({ ...o, taskId })).rejects.toThrow('task identifier')
    await expect(access(o.workRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.method).not.toHaveBeenCalled()
  }
)

it.each([2_147_483_648, 4_294_967_296, Number.MAX_SAFE_INTEGER])(
  'rejects overflowing overall timeout %s before persistence or execution',
  async (timeoutMs) => {
    const o = await options()
    const timer = vi.spyOn(AbortSignal, 'timeout')
    try {
      await expect(runPersistentOptimization({ ...o, timeoutMs })).rejects.toThrow(
        'Invalid optimization timeout'
      )
      await expect(access(o.workRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(timer).not.toHaveBeenCalled()
      expect(f.method).not.toHaveBeenCalled()
      expect(f.evaluate).not.toHaveBeenCalled()
      expect(f.shutdown).not.toHaveBeenCalled()
      expect(f.dispose).not.toHaveBeenCalled()
    } finally {
      timer.mockRestore()
    }
  }
)
it.each([MAX_HARNESS_EXECUTION_TIMEOUT_MS + 1, 2_147_483_648, Number.MAX_SAFE_INTEGER])(
  'rejects unsupported Python/RPC execution timeout %s before persistence or execution',
  async (executionTimeoutMs) => {
    const o = await options()
    await expect(runPersistentOptimization({ ...o, executionTimeoutMs })).rejects.toThrow(
      'Invalid optimization timeout'
    )
    await expect(access(o.workRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.method).not.toHaveBeenCalled()
    expect(f.shutdown).not.toHaveBeenCalled()
  }
)
it('retains supported maximum and default deadlines without overflowing the Python RPC budget', async () => {
  f.method.mockResolvedValue({ status: 'ok' })
  f.evaluate.mockResolvedValue({ baseline: {}, candidate: {} })
  f.shutdown.mockResolvedValue({ reaped: true })
  const defaults = await options()
  delete defaults.timeoutMs
  await runPersistentOptimization(defaults)
  expect(f.method.mock.calls[0]![0].timeoutMs).toBe(600_000)
  const defaultConfig = JSON.parse(
    await readFile(join(defaults.workRoot, 'method-config.json'), 'utf8')
  )
  expect(defaultConfig.executionTimeoutMs).toBe(120_000)
  expect(defaultConfig.rpcTimeoutMs).toBe(150_000)
  const maximums = await options()
  maximums.timeoutMs = MAX_TIMER_TIMEOUT_MS
  maximums.executionTimeoutMs = MAX_HARNESS_EXECUTION_TIMEOUT_MS
  await runPersistentOptimization(maximums)
  expect(f.method.mock.calls[1]![0].timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS)
  const maxConfig = JSON.parse(
    await readFile(join(maximums.workRoot, 'method-config.json'), 'utf8')
  )
  expect(maxConfig.rpcTimeoutMs).toBe(
    MAX_HARNESS_EXECUTION_TIMEOUT_MS + HARNESS_RPC_TIMEOUT_MARGIN_MS
  )
  expect(maxConfig.rpcTimeoutMs).toBe(3_600_000)
})

it.each(['sequential', 'parallel'] as const)(
  'forwards %s k=2 unchanged into private upstream config and bounded core',
  async (mode) => {
    const o = await options()
    o.method = { mode, k: 2, concurrency: 3 }
    f.method.mockImplementation(async () => {
      // Caller mutation after admission cannot change the frozen method.
      o.method = { mode: 'sequential', k: 1, concurrency: 1 }
      return { status: 'ok' }
    })
    f.evaluate.mockResolvedValue({ baseline: {}, candidate: {} })
    f.shutdown.mockResolvedValue({ reaped: true })
    await runPersistentOptimization(o)
    const config = JSON.parse(await readFile(join(o.workRoot, 'method-config.json'), 'utf8'))
    expect(config.method).toEqual({ mode, k: 2, concurrency: 3 })
    const plan = JSON.parse(await readFile(join(o.workRoot, 'assessment-plan.json'), 'utf8'))
    expect(plan.baselineStageId).toBe('base1')
    expect(f.core.mock.calls[0].slice(2)).toEqual([256, { concurrency: 3 }])
  }
)
it('rejects invalid method or excessive budget before allocating any run resources', async () => {
  const o = await options()
  await expect(runPersistentOptimization({ ...o, executionLimit: 129 })).rejects.toThrow(
    'Invalid optimization limits'
  )
  await expect(
    runPersistentOptimization({ ...o, method: { mode: 'parallel', k: 9, concurrency: 1 } })
  ).rejects.toThrow('Invalid optimization method')
  await expect(access(o.workRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.method).not.toHaveBeenCalled()
  expect(f.core).not.toHaveBeenCalled()
})

it('retains charged failed attempts while accepting an upstream retry with verified completed results', async () => {
  const o = await options()
  f.executionIds = ['failed-attempt', 'successful-retry']
  const failed = { phase: 'failed', cleanup: 'confirmed', error: { code: 'provider-failed' } }
  const completed = { phase: 'completed', cleanup: 'confirmed' }
  f.get.mockImplementation(async (id) => (id === 'failed-attempt' ? failed : completed))
  f.method.mockResolvedValue({ status: 'ok' })
  f.evaluate.mockResolvedValue({ baseline: {}, candidate: {} })
  f.shutdown.mockResolvedValue({ reaped: true })
  await runPersistentOptimization(o)
  expect(f.evaluate.mock.calls[0][0].records).toEqual([failed, completed])
  expect(f.exportResult).toHaveBeenCalledExactlyOnceWith(completed)
  expect(f.readReviews).toHaveBeenCalledExactlyOnceWith(completed)
})

it.each([
  { phase: 'failed', cleanup: 'unknown' },
  { phase: 'cancelled', cleanup: 'confirmed' },
  { phase: 'interrupted', cleanup: 'confirmed' },
  ...['timeout', 'budget-exhausted', 'cleanup-unconfirmed', 'request-conflict'].map((code) => ({
    phase: 'failed',
    cleanup: 'confirmed',
    error: { code }
  }))
])('never treats a control stop as a recoverable attempt: %j', async (stopped) => {
  const o = await options()
  f.executionIds = ['successful-retry', 'stopped']
  f.get.mockImplementation(async (id) =>
    id === 'stopped' ? stopped : { phase: 'completed', cleanup: 'confirmed' }
  )
  f.method.mockResolvedValue({ status: 'ok' })
  f.shutdown.mockResolvedValue({ reaped: true })
  await expect(runPersistentOptimization(o)).rejects.toThrow(
    'Optimization has incomplete executions'
  )
  expect(f.evaluate).not.toHaveBeenCalled()
})

it('still requires passing persisted integrity reviews after a retry', async () => {
  const o = await options()
  f.method.mockResolvedValue({ status: 'ok' })
  f.shutdown.mockResolvedValue({ reaped: true })
  f.readReviews.mockResolvedValue([{ lifecycle: 'complete', outcome: 'flagged' }])
  await expect(runPersistentOptimization(o)).rejects.toThrow('passing integrity review')
  expect(f.evaluate).not.toHaveBeenCalled()
})

it('waits for both original result commits after resource shutdown before retiring the execution core', async () => {
  const o = await options()
  f.method.mockResolvedValue({ status: 'ok' })
  f.evaluate.mockResolvedValue({ baseline: {}, candidate: {} })
  f.shutdown.mockResolvedValue({ reaped: true })
  let finish!: (settled: boolean) => void
  f.settle.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  let returned = false
  const result = runPersistentOptimization(o).then((value) => {
    returned = true
    return value
  })
  await vi.waitFor(() => expect(f.settle).toHaveBeenCalledOnce())
  expect(f.shutdown).toHaveBeenCalledOnce()
  expect(f.dispose).not.toHaveBeenCalled()
  expect(returned).toBe(false)
  await expect(access(join(o.workRoot, 'execution.json.lock'))).resolves.toBeUndefined()
  finish(true)
  await result
  expect(f.dispose).toHaveBeenCalledOnce()
  await expect(access(join(o.workRoot, 'execution.json.lock'))).rejects.toMatchObject({
    code: 'ENOENT'
  })
})
it('retains the writer lock when result-owner settlement times out despite confirmed process reap', async () => {
  const o = await options()
  f.method.mockResolvedValue({ status: 'ok' })
  f.evaluate.mockResolvedValue({ baseline: {}, candidate: {} })
  f.shutdown.mockResolvedValue({ reaped: true })
  f.settle.mockResolvedValueOnce(false)
  await expect(runPersistentOptimization(o)).rejects.toThrow('cleanup requires reconciliation')
  await expect(access(join(o.workRoot, 'execution.json.lock'))).resolves.toBeUndefined()
  expect(f.dispose).toHaveBeenCalledOnce()
})

it('preserves an older private manifest and refuses changed method source before Core or paid dispatch', async () => {
  const o = await options()
  f.method.mockResolvedValue({ status: 'ok' })
  f.evaluate.mockResolvedValue({ baseline: {}, candidate: {} })
  f.shutdown.mockResolvedValue({ reaped: true })
  await runPersistentOptimization(o)
  const path = join(o.workRoot, 'resume.json')
  const original = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...original, methodDigest: `sha256:${'b'.repeat(64)}` }))
  const previousVersionBytes = await readFile(path, 'utf8')
  f.core.mockClear()
  f.method.mockClear()
  f.evaluate.mockClear()
  await expect(runPersistentOptimization({ ...o, resume: true })).rejects.toThrow(
    'identity changed'
  )
  expect(await readFile(path, 'utf8')).toBe(previousVersionBytes)
  expect(f.core).not.toHaveBeenCalled()
  expect(f.method).not.toHaveBeenCalled()
  expect(f.evaluate).not.toHaveBeenCalled()
})

const scientificInput = (
  o: PersistentSingleOptimizationOptions
): PersistentSingleOptimizationOptions['input'] => ({
  ...o.input,
  task: {
    prompt: 'Original R input task',
    files: [],
    managedInputs: [
      {
        sourceKind: 'upload-version',
        sourceProjectId: 'p',
        sourceSessionId: 'source',
        sourceFileId: 'file',
        inputFileVersionId: 'old-version',
        filename: 'observations.csv',
        sizeBytes: 1,
        checksum: 'a'.repeat(64)
      }
    ]
  },
  harness: { ...o.input.harness, tools: 'notebook-r' },
  environment: {
    isolation: 'directory-process',
    network: 'provider-and-notebook-policy',
    notebook: {
      runtime: {
        language: 'r',
        runtimeId: '/original/r',
        interpreterPath: '/original/r',
        source: 'external',
        provenance: 'user-own',
        version: '4.4.3'
      }
    }
  }
})
it.each(['message', 'owner'] as const)(
  'rejects missing original R %s authority before opening a Core or method',
  async (missing) => {
    const o = await options()
    await expect(
      runPersistentOptimization({
        ...o,
        input: scientificInput(o),
        sourceSessionId: 'source',
        ...(missing === 'message' ? {} : { sourcePromptMessageId: 'original' }),
        ownerOptions: {
          ...o.ownerOptions,
          ...(missing === 'owner'
            ? {}
            : { notebook: {} as NonNullable<typeof o.ownerOptions.notebook> })
        }
      })
    ).rejects.toThrow(
      missing === 'message'
        ? 'source message identity missing'
        : 'original fixed-input task and runtime owner'
    )
    expect(f.core).not.toHaveBeenCalled()
    expect(f.method).not.toHaveBeenCalled()
    await expect(access(o.workRoot)).rejects.toThrow()
  }
)
it('pins R in the private manifest and original Notebook projection while passing only language-free task facts to original Python', async () => {
  const o = await options(),
    input = scientificInput(o)
  f.shutdown.mockResolvedValue({ reaped: true })
  f.method.mockImplementationOnce(async ({ args }: { args: string[] }) => {
    const manifest = JSON.parse(await readFile(join(o.workRoot, 'resume.json'), 'utf8'))
    expect(manifest.identity.input.environment.notebook.runtime).toEqual(
      input.environment.notebook!.runtime
    )
    expect(manifest.identity.input.harness.tools).toBe('notebook-r')
    const projection = JSON.parse(await readFile(join(o.workRoot, 'notebook-task.json'), 'utf8'))
    expect(projection.environment.notebook.runtime.language).toBe('r')
    expect(projection.sourcePromptMessageId).toBe('original')
    const config = JSON.parse(await readFile(args.at(-1)!, 'utf8'))
    expect(config.task).toEqual(input.task)
    execFileSync(
      process.env.EARTHNANO_RESEARCH_PYTHON ?? 'python3',
      [
        '-B',
        '-c',
        'import json,sys; from harness2.earthnano import validate_config; validate_config(json.load(sys.stdin))'
      ],
      {
        cwd: o.harnessRoot,
        input: JSON.stringify(config),
        env: { PATH: process.env.PATH, PYTHONPATH: o.harnessRoot, PYTHONDONTWRITEBYTECODE: '1' }
      }
    )
    expect(config).not.toHaveProperty('environment')
    expect(config).not.toHaveProperty('runtime')
    expect(JSON.stringify(config)).not.toContain(o.semanticCriteria)
    throw new Error('R_TRANSPORT_VALIDATED_NO_DISPATCH')
  })
  await expect(
    runPersistentOptimization({
      ...o,
      input,
      sourceSessionId: 'source',
      sourcePromptMessageId: 'original',
      ownerOptions: {
        ...o.ownerOptions,
        notebook: {} as NonNullable<typeof o.ownerOptions.notebook>
      }
    })
  ).rejects.toThrow('R_TRANSPORT_VALIDATED_NO_DISPATCH')
  const manifestBytes = await readFile(join(o.workRoot, 'resume.json'), 'utf8')
  f.core.mockClear()
  f.method.mockClear()
  const pythonInput = {
    ...input,
    harness: { ...input.harness, tools: 'notebook-python' as const },
    environment: {
      ...input.environment,
      notebook: {
        runtime: {
          ...input.environment.notebook!.runtime,
          language: 'python' as const,
          runtimeId: '/original/python',
          interpreterPath: '/original/python'
        }
      }
    }
  }
  await expect(
    runPersistentOptimization({
      ...o,
      input: pythonInput,
      sourceSessionId: 'source',
      sourcePromptMessageId: 'original',
      resume: true,
      ownerOptions: {
        ...o.ownerOptions,
        notebook: {} as NonNullable<typeof o.ownerOptions.notebook>
      }
    })
  ).rejects.toThrow('identity changed; paid replay refused')
  expect(f.core).not.toHaveBeenCalled()
  expect(f.method).not.toHaveBeenCalled()
  expect(await readFile(join(o.workRoot, 'resume.json'), 'utf8')).toBe(manifestBytes)
  expect(f.evaluate).not.toHaveBeenCalled()
})

it('transports a mixed R/Python catalog through the same original sweep config without exposing runtimes or assessment facts to Python', async () => {
  const o = await options(),
    rInput = scientificInput(o)
  const python = execFileSync(
    process.env.EARTHNANO_RESEARCH_PYTHON ?? 'python3',
    ['-c', 'import sys;print(sys.executable)'],
    { encoding: 'utf8' }
  ).trim()
  const specs = (['r', 'python'] as const).map((language, index) => {
    const taskId = `task-${index}`,
      sourceSessionId = `source-${index}`
    const input: typeof rInput = {
      ...rInput,
      task: {
        ...rInput.task,
        prompt: `Original task ${index}`,
        managedInputs: rInput.task.managedInputs!.map((entry) => ({
          ...entry,
          sourceSessionId,
          sourceFileId: `file-${index}`,
          inputFileVersionId: `version-${index}`
        }))
      },
      harness: { ...rInput.harness, tools: language === 'r' ? 'notebook-r' : 'notebook-python' },
      environment: {
        ...rInput.environment,
        notebook: {
          runtime: {
            ...rInput.environment.notebook!.runtime,
            language,
            runtimeId: `/original/${language}`,
            interpreterPath: `/original/${language}`
          }
        }
      }
    }
    return {
      taskId,
      domain: taskId,
      sourceSessionId,
      sourcePromptMessageId: `prompt-${index}`,
      input,
      criteria: `Private criteria ${index}`
    }
  })
  const request: import('../../shared/earthnano/optimization-sweep').StartDesktopSweep = {
    projectId: o.projectId,
    sourceSessionId: 'navigation',
    requestKey: 'mixed',
    executionLimit: 40,
    catalog: specs.map((task) => ({
      taskId: task.taskId,
      domain: task.domain,
      sourceSessionId: task.sourceSessionId,
      source: {
        kind: 'notebook',
        promptMessageId: task.sourcePromptMessageId,
        language: task.input.environment.notebook!.runtime.language
      },
      criteria: task.criteria
    })),
    sweep: {
      modes: ['parallel', 'sequential'],
      k: 1,
      concurrency: 2,
      stream: { seed: 0, onlyDomains: [], onlyTasks: [], maxTasks: null, workers: 2 }
    }
  }
  const plan = await previewOptimizationSweep({
    catalog: request.catalog.map(({ taskId, domain }) => ({ taskId, domain })),
    options: request.sweep,
    python,
    harnessRoot: o.harnessRoot
  })
  const ordered = plan.domains
    .flatMap((domain) => domain.taskIds)
    .map((taskId) => specs.find((task) => task.taskId === taskId)!)
  f.shutdown.mockResolvedValue({ reaped: true })
  f.method.mockImplementationOnce(async ({ args }: { args: string[] }) => {
    const encoded = await readFile(args.at(-1)!, 'utf8'),
      config = JSON.parse(encoded)
    execFileSync(
      python,
      [
        '-B',
        '-c',
        'import json,sys;from harness2.earthnano_sweep import validate_config;validate_config(json.load(sys.stdin))'
      ],
      {
        cwd: o.harnessRoot,
        input: encoded,
        env: { PATH: process.env.PATH, PYTHONPATH: o.harnessRoot, PYTHONDONTWRITEBYTECODE: '1' }
      }
    )
    expect(config.tasks).toEqual(
      ordered.map((task) => ({ taskId: task.taskId, task: task.input.task }))
    )
    expect(encoded).not.toContain('Private criteria')
    expect(encoded).not.toContain('/original/')
    const manifest = JSON.parse(await readFile(join(o.workRoot, 'resume.json'), 'utf8'))
    expect(
      manifest.identity.sweep.tasks.map(
        (task: { input: typeof rInput }) => task.input.environment.notebook!.runtime.language
      )
    ).toEqual(['r', 'python'])
    const projection = JSON.parse(await readFile(join(o.workRoot, 'sweep-sources.json'), 'utf8'))
    expect(
      projection.tasks.map(
        (task: { environment: typeof rInput.environment }) =>
          task.environment.notebook!.runtime.language
      )
    ).toEqual(ordered.map((task) => task.input.environment.notebook!.runtime.language))
    throw new Error('MIXED_PRIVATE_TRANSPORT_VALIDATED_NO_DISPATCH')
  })
  await expect(
    runPersistentOptimization({
      projectId: o.projectId,
      taskId: o.taskId,
      sourceSessionId: 'navigation',
      workRoot: o.workRoot,
      harnessRoot: o.harnessRoot,
      python,
      timeoutMs: 10_000,
      executionLimit: 40,
      binding: o.binding,
      ownerOptions: {
        ...o.ownerOptions,
        notebook: {} as NonNullable<typeof o.ownerOptions.notebook>
      },
      sweep: { plan, tasks: specs, request }
    })
  ).rejects.toThrow('MIXED_PRIVATE_TRANSPORT_VALIDATED_NO_DISPATCH')
  expect(f.evaluate).not.toHaveBeenCalled()
})

it.each([true, false])(
  'registers the same original owners synchronously and releases only reaped=%s',
  async (reaped) => {
    const o = await options(),
      release = vi.fn()
    o.onOwnersReady = vi.fn((owner) => {
      expect(owner.shutdown).toBe(f.shutdown)
      expect(f.core).not.toHaveBeenCalled()
      return release
    })
    f.shutdown.mockResolvedValue({ reaped })
    f.method.mockRejectedValue(new Error('ORIGINAL_METHOD_FAILURE'))
    await expect(runPersistentOptimization(o)).rejects.toThrow('ORIGINAL_METHOD_FAILURE')
    expect(o.onOwnersReady).toHaveBeenCalledOnce()
    expect(f.shutdown).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledTimes(reaped ? 1 : 0)
    if (reaped)
      expect(f.shutdown.mock.invocationCallOrder[0]).toBeLessThan(
        release.mock.invocationCallOrder[0]
      )
  }
)
it('still retires the original factory when synchronous owner registration fails', async () => {
  const o = await options()
  o.onOwnersReady = () => {
    throw new Error('HOST_REGISTRATION_FAILED')
  }
  f.shutdown.mockResolvedValue({ reaped: true })
  await expect(runPersistentOptimization(o)).rejects.toThrow('HOST_REGISTRATION_FAILED')
  expect(f.shutdown).toHaveBeenCalledOnce()
  expect(f.method).not.toHaveBeenCalled()
})
