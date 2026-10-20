import type { AcpPromptRequest } from '../../shared/acp'
import type { TaskNotificationService } from '../notifications/task-notifications'
import type { TaskAgentPort, TaskAgentPromptRequest } from '../tasks/task-runner'

export type AcpTaskPromptRuntime = {
  sendPrompt(request: AcpPromptRequest): Promise<unknown>
  sendPromptObserved(
    request: AcpPromptRequest,
    onProviderPromptAccepted: () => void,
    onPromptAdmitted?: () => Promise<AcpPromptRequest['provenanceContext']>,
    runtimeReviewOwner?: 'task' | 'renderer'
  ): Promise<unknown>
  cancelPrompt(request: { sessionId: string }): Promise<unknown>
}

export type TaskPromptNotifications = Pick<TaskNotificationService, 'trackPrompt' | 'untrackPrompt'>

const toAcpPromptRequest = (request: TaskAgentPromptRequest): AcpPromptRequest => ({
  sessionId: request.sessionId,
  text: request.text,
  ...(request.permissionPrompts ? { permissionPrompts: request.permissionPrompts } : {}),
  provenanceContext: request.provenanceContext,
  ...(request.turnIntent ? { turnIntent: request.turnIntent } : {}),
  ...(request.skillIds?.length ? { forcedSkillIds: request.skillIds } : {}),
  ...(request.historyPreamble ? { historyPreamble: request.historyPreamble } : {}),
  ...(request.contextReset ? { contextReset: true } : {}),
  ...(request.resumeFallback ? { resumeFallback: request.resumeFallback } : {})
})

// Shared dispatch for the public Task adapter and the opt-in EarthNano driver. This Promise still
// waits for the full turn; durable core admission and Session admission remain different boundaries.
export const createAcpTaskPromptExecution = (
  runtime: AcpTaskPromptRuntime,
  notifications?: TaskPromptNotifications
): Pick<TaskAgentPort, 'prompt' | 'cancelPrompt'> => ({
  prompt: async (request, observer) => {
    const acpRequest = toAcpPromptRequest(request)
    const tracked = notifications?.trackPrompt(acpRequest)
    try {
      if (observer?.onProviderPromptAccepted || observer?.onPromptAdmitted) {
        await runtime.sendPromptObserved(
          acpRequest,
          observer.onProviderPromptAccepted ?? (() => undefined),
          observer.onPromptAdmitted,
          'task'
        )
      } else {
        await runtime.sendPrompt(acpRequest)
      }
    } catch (error) {
      if (tracked) notifications?.untrackPrompt(acpRequest.sessionId, tracked)
      throw error
    }
  },
  cancelPrompt: (sessionId) => runtime.cancelPrompt({ sessionId }).then(() => undefined)
})
