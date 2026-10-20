import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopOptimizationApi } from '../../shared/earthnano/desktop-optimization'
import { normalizeOptimizationMethod } from '../../shared/earthnano/optimization-method'
import { normalizeNotebookOptimizationSource } from '../../shared/earthnano/notebook-source'
import { normalizeOptimizationArtifactInputs } from '../../shared/earthnano/optimization-input'
import {
  normalizeOutputChecks,
  normalizeOptimizationDomain
} from '../../shared/earthnano/research-outcome'
import { callerContextForEvent, requireDesktopCaller } from '../caller-context'
import { ipcMainHandle } from '../ipc-handler-registry'

export async function invokeDesktopOptimization<K extends keyof DesktopOptimizationApi>(
  api: DesktopOptimizationApi,
  operation: K,
  request: unknown
): Promise<Awaited<ReturnType<DesktopOptimizationApi[K]>>> {
  try {
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new Error('Invalid optimization request')
    const required =
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
    const allowed =
      operation === 'start'
        ? [...required, 'method', 'checks', 'domain', 'inputArtifacts', 'notebook']
        : required
    if (
      required.some((key) => !Object.hasOwn(request, key)) ||
      Object.keys(request).some((key) => !allowed.includes(key))
    )
      throw new Error('Unexpected optimization fields')
    if (operation === 'start' && Object.hasOwn(request, 'method'))
      normalizeOptimizationMethod((request as Record<string, unknown>).method)
    if (operation === 'start') {
      normalizeNotebookOptimizationSource((request as Record<string, unknown>).notebook)
      normalizeOptimizationArtifactInputs((request as Record<string, unknown>).inputArtifacts)
      normalizeOutputChecks((request as Record<string, unknown>).checks)
      normalizeOptimizationDomain((request as Record<string, unknown>).domain)
    }
    // The manager owns full bounded DTO validation and Project/Session authorization.
    return await (
      api[operation] as (input: unknown) => Promise<Awaited<ReturnType<DesktopOptimizationApi[K]>>>
    ).call(api, request)
  } catch {
    throw new Error(
      'Optimization request could not be completed. Check the selected model and runtime settings.'
    )
  }
}

/** Desktop-only, top-frame admission. Requests never accept credentials, executable paths or URLs. */
export function registerDesktopOptimizationIpcHandlers(api: DesktopOptimizationApi): void {
  for (const operation of ['start', 'get', 'latest', 'stop', 'resume'] as const) {
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
          return await invokeDesktopOptimization(api, operation, request)
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
