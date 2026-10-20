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
import { registerDesktopOptimizationIpcHandlers } from './desktop-optimization-ipc'
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
    start: vi.fn().mockResolvedValue({ state: 'queued' }),
    get: vi.fn().mockResolvedValue({ state: 'running' }),
    latest: vi.fn().mockResolvedValue(null),
    stop: vi.fn().mockResolvedValue({ state: 'stopping' })
  }
  registerDesktopOptimizationIpcHandlers(api)
})
it('registers typed desktop start/get/latest/stop and forwards only their DTOs', async () => {
  for (const operation of ['start', 'get', 'latest', 'stop'] as const) {
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
