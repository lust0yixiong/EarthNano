import type {
  AcpCreateSessionResponse,
  AcpResumeSessionRequest,
  AcpSetPermissionProfileRequest
} from '../../shared/acp'
import type { TaskAgentPort } from '../tasks/task-runner'
import {
  createAcpTaskPromptExecution,
  type AcpTaskPromptRuntime,
  type TaskPromptNotifications
} from './task-prompt-execution'
import type { AcpCreateSessionWorkflow } from './create-session-workflow'
import {
  toSessionAgentConfiguration,
  type DefaultSessionAgentTargetResolver,
  type SessionAgentTargetResolver
} from './session-agent-target'

type AcpTaskAgentRuntime = AcpTaskPromptRuntime & {
  getSnapshot(): { sessionIds: string[] }
  resumeSession(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse>
  setPermissionProfile(request: AcpSetPermissionProfileRequest): Promise<unknown>
  setMemoryEnabled(sessionId: string, enabled: boolean): void
}

type SessionArchiveAvailability = {
  withSessionAvailable<Result>(
    projectId: string,
    sessionId: string,
    operation: () => Promise<Result>
  ): Promise<Result>
}

// Adapts the provider-neutral Task seam to the existing ACP owner without exposing the coordinator,
// renderer commands, Specialist controls, or Compute management to Task automation.
const createAcpTaskAgentPort = (
  runtime: AcpTaskAgentRuntime,
  createSessionWorkflow: AcpCreateSessionWorkflow,
  notifications?: TaskPromptNotifications,
  archiveAvailability?: SessionArchiveAvailability,
  resolveSessionAgentTarget?: SessionAgentTargetResolver,
  resolveDefaultSessionAgentTarget?: DefaultSessionAgentTargetResolver
): TaskAgentPort => ({
  withSessionAvailable: (projectId, sessionId, operation) =>
    archiveAvailability
      ? archiveAvailability.withSessionAvailable(projectId, sessionId, operation)
      : operation(),
  listAttachedSessionIds: async () => [...runtime.getSnapshot().sessionIds],
  createSession: async (request) => {
    const agentTarget = request.agentConfiguration
      ? await resolveSessionAgentTarget?.({ agentConfiguration: request.agentConfiguration })
      : await resolveDefaultSessionAgentTarget?.()
    const response = await createSessionWorkflow.create({
      projectId: request.projectId,
      permissionProfile: request.permissionProfile,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.specialistId ? { specialistId: request.specialistId } : {}),
      ...(request.memoryEnabled !== undefined ? { memoryEnabled: request.memoryEnabled } : {}),
      ...(agentTarget ? { agentTarget } : {})
    })
    return {
      ...response,
      ...(agentTarget ? { agentConfiguration: toSessionAgentConfiguration(agentTarget) } : {})
    }
  },
  resumeSession: async (request) => {
    const agentTarget = await resolveSessionAgentTarget?.({
      agentBackendId: request.previousBackendId,
      agentModel: request.previousModel,
      agentConfiguration: request.agentConfiguration
    })
    const response = await runtime.resumeSession({
      sessionId: request.sessionId,
      cwd: request.cwd,
      projectId: request.projectId,
      permissionProfile: request.permissionProfile,
      memoryEnabled: request.memoryEnabled !== false,
      previousFrameworkId: request.previousFrameworkId,
      previousBackendId: request.previousBackendId,
      providerSessionId: request.providerSessionId,
      providerContinuityToken: request.providerContinuityToken,
      ...(request.specialistId ? { specialistId: request.specialistId } : {}),
      ...(request.specialistBindingPending === true ? { specialistBindingPending: true } : {}),
      ...(agentTarget ? { agentTarget } : {})
    })
    return {
      ...response,
      ...(agentTarget ? { agentConfiguration: toSessionAgentConfiguration(agentTarget) } : {})
    }
  },
  setPermissionProfile: (sessionId, profile) =>
    runtime.setPermissionProfile({ sessionId, profile }).then(() => undefined),
  setMemoryEnabled: async (sessionId, enabled) => runtime.setMemoryEnabled(sessionId, enabled),
  ...createAcpTaskPromptExecution(runtime, notifications)
})

export { createAcpTaskAgentPort }
