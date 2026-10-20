import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({
  method: vi.fn(),
  evaluate: vi.fn(),
  shutdown: vi.fn(),
  dispose: vi.fn(),
  core: vi.fn(),
  get: vi.fn(),
  exportResult: vi.fn(),
  readReviews: vi.fn(),
  executionIds: ['baseline']
}))
vi.mock('./candidate-snapshot', () => ({ createCandidateSnapshotStore: async () => ({}) }))
vi.mock('./claude-candidate-driver', () => ({ createClaudeCandidateDriver: () => ({}) }))
vi.mock('./execution-core', async (original) => ({
  ...(await original<typeof import('./execution-core')>()),
  ExecutionCore: class {
    constructor(...args: unknown[]) {
      f.core(...args)
    }
    configureBudget = vi.fn()
    get = f.get
    dispose = f.dispose
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
  createPersistentCandidateOwners: () => ({
    exportResult: f.exportResult,
    readReviews: f.readReviews,
    shutdown: f.shutdown
  })
}))
vi.mock('./semantic-evaluation', async (original) => ({
  ...(await original<typeof import('./semantic-evaluation')>()),
  evaluateOptimizationSemantics: f.evaluate
}))
import {
  runPersistentOptimization,
  type PersistentOptimizationOptions
} from './run-persistent-optimization'
import {
  MAX_TIMER_TIMEOUT_MS,
  MAX_HARNESS_EXECUTION_TIMEOUT_MS,
  HARNESS_RPC_TIMEOUT_MARGIN_MS
} from './execution-timeout'
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
const options = async (): Promise<PersistentOptimizationOptions> => {
  const root = await mkdtemp(join(tmpdir(), 'earthnano-deadline-'))
  roots.push(root)
  return {
    projectId: 'p',
    taskId: 't',
    workRoot: join(root, 'run'),
    harnessRoot: root,
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
it('applies one overall deadline across method and assessment, then awaits cleanup before rejecting', async () => {
  const o = await options()
  o.timeoutMs = 80
  let finishCleanup!: () => void
  f.method.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 10))
    return { status: 'ok' }
  })
  f.evaluate.mockImplementation(
    async ({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
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
  await vi.waitFor(() => expect(f.shutdown).toHaveBeenCalledOnce())
  expect(f.method.mock.calls[0][0].signal).toBe(f.evaluate.mock.calls[0][0].signal)
  expect(f.evaluate.mock.calls[0][0].signal.aborted).toBe(true)
  expect(settled).toBe(false)
  finishCleanup()
  await rejected
  expect(f.dispose).toHaveBeenCalledOnce()
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
})

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
