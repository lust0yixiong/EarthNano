import { beforeEach, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopOptimizationApi } from '../../shared/earthnano/desktop-optimization'
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>>()
}))
vi.mock('../ipc-handler-registry', () => ({
  ipcMainHandle: (
    channel: string,
    handler: (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>
  ) => handlers.set(channel, handler)
}))
import {
  invokeDesktopOptimization,
  registerDesktopOptimizationIpcHandlers
} from './desktop-optimization-ipc'
const frame = {}
const event = (): IpcMainInvokeEvent =>
  ({
    sender: { id: 17, mainFrame: frame, isDestroyed: () => false },
    senderFrame: frame
  }) as unknown as IpcMainInvokeEvent
const request = {
  projectId: 'p',
  sourceSessionId: 's',
  requestKey: 'k',
  prompt: 'Solve task',
  files: [],
  criteria: 'Produce valid JSON',
  executionLimit: 9
}
let api: DesktopOptimizationApi
beforeEach(() => {
  handlers.clear()
  api = {
    startSweep: vi.fn().mockResolvedValue({ state: 'queued' }),
    start: vi.fn().mockResolvedValue({ state: 'queued' }),
    get: vi.fn().mockResolvedValue({ state: 'running' }),
    latest: vi.fn().mockResolvedValue(null),
    stop: vi.fn().mockResolvedValue({ state: 'stopping' }),
    resume: vi.fn().mockResolvedValue({ state: 'queued' })
  }
  registerDesktopOptimizationIpcHandlers(api)
})
it('registers typed desktop start/get/latest/stop/resume and forwards only their DTOs', async () => {
  for (const operation of ['start', 'get', 'latest', 'stop', 'resume'] as const) {
    const dto =
      operation === 'start'
        ? request
        : operation === 'latest'
          ? { projectId: 'p', sourceSessionId: 's' }
          : { projectId: 'p', sourceSessionId: 's', runId: 'r' }
    await handlers.get(`optimization:${operation}`)!(event(), dto)
    expect(api[operation]).toHaveBeenCalledWith(dto)
  }
})
it('resumes only a known run key and rejects replacement input, tools or budget fields', async () => {
  const key = { projectId: 'p', sourceSessionId: 's', runId: 'r' }
  for (const extra of [{ executionLimit: 128 }, { prompt: 'Replace task' }, { tools: 'all' }])
    await expect(invokeDesktopOptimization(api, 'resume', { ...key, ...extra })).rejects.toThrow()
  expect(api.resume).not.toHaveBeenCalled()
})
it('rejects missing/destroyed/subframe callers and does not invoke the manager', async () => {
  const missing = { ...event(), senderFrame: null } as unknown as IpcMainInvokeEvent
  const destroyed = {
    ...event(),
    sender: { ...event().sender, isDestroyed: () => true }
  } as unknown as IpcMainInvokeEvent
  const subframe = { ...event(), senderFrame: {} } as unknown as IpcMainInvokeEvent
  for (const invalid of [missing, destroyed, subframe])
    await expect(handlers.get('optimization:start')!(invalid, request)).rejects.toThrow(
      'Optimization request could not be completed'
    )
  expect(api.start).not.toHaveBeenCalled()
})
it('rejects unexpected fields and never forwards credentials or host paths', async () => {
  await expect(
    handlers.get('optimization:start')!(event(), { ...request, key: 'synthetic-private-key' })
  ).rejects.toThrow()
  expect(api.start).not.toHaveBeenCalled()
})
it('does not disclose raw provider errors', async () => {
  vi.mocked(api.start).mockRejectedValue(new Error('credential=synthetic-private-key'))
  await expect(handlers.get('optimization:start')!(event(), request)).rejects.toThrow(
    'Optimization request could not be completed. Check the selected model and runtime settings.'
  )
})

it.each(['sequential', 'parallel'] as const)(
  'validates and forwards explicit %s k=2 through the desktop transport',
  async (mode) => {
    const dto = { ...request, executionLimit: 17, method: { mode, k: 2, concurrency: 3 } }
    await invokeDesktopOptimization(api, 'start', dto)
    expect(api.start).toHaveBeenCalledWith(dto)
    await handlers.get('optimization:start')!(event(), dto)
    expect(api.start).toHaveBeenCalledTimes(2)
  }
)
it('accepts old callers without adding a method field or changing request identity', async () => {
  await invokeDesktopOptimization(api, 'start', request)
  expect(api.start).toHaveBeenCalledWith(request)
  expect(vi.mocked(api.start).mock.calls[0][0]).not.toHaveProperty('method')
})
it('accepts only bounded immutable artifact identities, never a source host path', async () => {
  const inputArtifacts = [
    { artifactId: 'artifact', versionId: 'version', path: 'source.json', checksum: 'a'.repeat(64) }
  ]
  await invokeDesktopOptimization(api, 'start', { ...request, inputArtifacts })
  expect(api.start).toHaveBeenCalledWith({ ...request, inputArtifacts })
  vi.mocked(api.start).mockClear()
  for (const ref of [
    { ...inputArtifacts[0], path: '/host/key.md' },
    { ...inputArtifacts[0], sourcePath: '/host/key.md' },
    { ...inputArtifacts[0], checksum: undefined }
  ])
    await expect(
      invokeDesktopOptimization(api, 'start', { ...request, inputArtifacts: [ref] })
    ).rejects.toThrow()
  expect(api.start).not.toHaveBeenCalled()
})
it.each([
  null,
  { mode: 'other', k: 2, concurrency: 2 },
  { mode: 'parallel', k: 9, concurrency: 2 },
  { mode: 'parallel', k: 2, concurrency: 5 },
  { mode: 'parallel', k: 2 },
  { mode: 'parallel', k: 2, concurrency: 2, key: 'synthetic-private-key' }
])('rejects malformed explicit method before invoking desktop authority: %j', async (method) => {
  await expect(invokeDesktopOptimization(api, 'start', { ...request, method })).rejects.toThrow(
    'Optimization request could not be completed'
  )
  expect(api.start).not.toHaveBeenCalled()
})
it('rejects unknown top-level keys, missing required fields, and method fields on read requests', async () => {
  const missingFiles: Partial<typeof request> = { ...request }
  delete missingFiles.files
  await expect(
    invokeDesktopOptimization(api, 'start', {
      ...request,
      extra: true,
      method: { mode: 'sequential', k: 1, concurrency: 1 }
    })
  ).rejects.toThrow()
  await expect(invokeDesktopOptimization(api, 'start', missingFiles)).rejects.toThrow()
  await expect(
    invokeDesktopOptimization(api, 'get', {
      projectId: 'p',
      sourceSessionId: 's',
      runId: 'r',
      method: { mode: 'sequential', k: 1, concurrency: 1 }
    })
  ).rejects.toThrow()
  expect(api.start).not.toHaveBeenCalled()
  expect(api.get).not.toHaveBeenCalled()
})

it('forwards optional private checks and an explicit domain through the real desktop transport', async () => {
  const dto = {
    ...request,
    executionLimit: 20,
    checks: [{ kind: 'json-value', path: 'result.json', pointer: '', expected: { count: 3 } }],
    domain: { name: 'csv', nextTasks: [{ prompt: 'Next', files: [], criteria: 'Valid result' }] }
  }
  await invokeDesktopOptimization(api, 'start', dto)
  expect(api.start).toHaveBeenCalledWith(dto)
})
it.each([
  { checks: [{ kind: 'json-value', path: '../outside', pointer: '', expected: 1 }] },
  { checks: [{ kind: 'json-value', path: 'result.json', pointer: 'count', expected: 1 }] },
  {
    domain: {
      name: 'csv',
      nextTasks: Array(4).fill({ prompt: 'Next', files: [], criteria: 'Valid' })
    }
  },
  { domain: { name: 'csv', nextTasks: [], key: 'secret' } },
  {
    domain: {
      name: 'csv',
      nextTasks: [{ prompt: 'Next', files: [], criteria: 'Valid', unexpected: true }]
    }
  }
])('rejects malformed research options at transport admission: %j', async (options) => {
  await expect(
    invokeDesktopOptimization(api, 'start', { ...request, ...options })
  ).rejects.toThrow()
  expect(api.start).not.toHaveBeenCalled()
})

const sweep = {
  projectId: 'p',
  sourceSessionId: 's',
  requestKey: 'r',
  executionLimit: 40,
  catalog: [
    {
      taskId: 'a',
      domain: 'csv',
      sourceSessionId: 'own-source',
      source: { kind: 'notebook', promptMessageId: 'original-prompt' },
      criteria: 'Verify original data'
    }
  ],
  sweep: {
    modes: ['parallel', 'sequential'],
    k: 1,
    concurrency: 2,
    stream: { seed: 0, onlyDomains: [], onlyTasks: [], maxTasks: null, workers: 1 }
  }
}
it('forwards typed startSweep with independent task sources through the same desktop-only caller boundary', async () => {
  await handlers.get('optimization:startSweep')!(event(), sweep)
  expect(api.startSweep).toHaveBeenCalledWith(sweep)
  expect(api.start).not.toHaveBeenCalled()
  await expect(
    handlers.get('optimization:startSweep')!(
      { ...event(), senderFrame: {} } as IpcMainInvokeEvent,
      sweep
    )
  ).rejects.toThrow('Optimization request could not be completed')
  expect(api.startSweep).toHaveBeenCalledOnce()
})
it('rejects malformed excluded source authority and masks raw sweep setup errors', async () => {
  for (const source of [
    { kind: 'notebook', promptMessageId: 'original-prompt', runtime: '/private/python' },
    { kind: 'text', prompt: 'Task', files: [{ path: '../outside', content: 'x' }] }
  ]) {
    await expect(
      invokeDesktopOptimization(api, 'startSweep', {
        ...sweep,
        catalog: [{ ...sweep.catalog[0], source }],
        sweep: { ...sweep.sweep, stream: { ...sweep.sweep.stream, onlyTasks: ['unrelated'] } }
      })
    ).rejects.toThrow('Optimization request could not be completed')
  }
  expect(api.startSweep).not.toHaveBeenCalled()
  vi.mocked(api.startSweep).mockRejectedValue(new Error('credential=synthetic-private-key'))
  await expect(invokeDesktopOptimization(api, 'startSweep', sweep)).rejects.toThrow(
    'Optimization request could not be completed. Check the selected model and runtime settings.'
  )
})
