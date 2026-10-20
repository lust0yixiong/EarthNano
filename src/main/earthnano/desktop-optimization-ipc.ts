import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopOptimizationApi } from '../../shared/earthnano/desktop-optimization'
import { callerContextForEvent, requireDesktopCaller } from '../caller-context'
import { ipcMainHandle } from '../ipc-handler-registry'

/** Desktop-only, top-frame admission. Requests never accept credentials, executable paths or URLs. */
export function registerDesktopOptimizationIpcHandlers(api: DesktopOptimizationApi): void {
  for (const operation of ['start', 'get', 'latest', 'stop'] as const) {
    ipcMainHandle(
      `optimization:${operation}`,
      async (event: IpcMainInvokeEvent, request: unknown) => {
        try {
          const caller = callerContextForEvent(event)
          requireDesktopCaller(caller)
          if (
            !caller.isAuthorizationCurrent() ||
            event.sender.isDestroyed() ||
            !event.senderFrame ||
            event.senderFrame !== event.sender.mainFrame
          )
            throw new Error('Unavailable desktop caller')
          if (!request || typeof request !== 'object' || Array.isArray(request))
            throw new Error('Invalid optimization request')
          const allowed =
            operation === 'start'
              ? [
                  'projectId',
                  'sourceSessionId',
                  'requestKey',
                  'prompt',
                  'files',
                  'criteria',
                  'executionLimit'
                ]
              : operation === 'latest'
                ? ['projectId', 'sourceSessionId']
                : ['projectId', 'sourceSessionId', 'runId']
          if (
            Object.keys(request).length !== allowed.length ||
            Object.keys(request).some((key) => !allowed.includes(key))
          )
            throw new Error('Unexpected optimization fields')
          // The manager owns full bounded DTO validation and Project/Session authorization.
          return await (api[operation] as (input: unknown) => Promise<unknown>)(request)
        } catch {
          // Provider/settings errors can contain credential-bearing URLs. Do not serialize them to IPC.
          throw new Error(
            'Optimization request could not be completed. Check the selected model and runtime settings.'
          )
        }
      }
    )
  }
}
