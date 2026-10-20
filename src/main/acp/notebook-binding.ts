import type { AcpRuntimeNotebookOptions } from './runtime-contract'
import type { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import type { NotebookRpcConnection } from '../notebook/mcp-server'

/** Common original Notebook capability wiring for ordinary and private scientific Sessions. */
export function createAcpNotebookBinding(options: {
  rpc: NotebookLocalRpcServer
  projectId: string
  mcpEntryPath: string
  delegatedConnection?: NotebookRpcConnection
  canOwnRuntimeBindingDecision?: AcpRuntimeNotebookOptions['canOwnRuntimeBindingDecision']
  memoryTools?: boolean
  isMemoryEnabled?: AcpRuntimeNotebookOptions['isMemoryEnabled']
  getShellRuntimeBinding?: AcpRuntimeNotebookOptions['getShellRuntimeBinding']
  peekHandoffContext?: AcpRuntimeNotebookOptions['peekHandoffContext']
}): AcpRuntimeNotebookOptions {
  const { rpc, delegatedConnection } = options
  return {
    projectId: options.projectId,
    mcpEntryPath: options.mcpEntryPath,
    memoryTools: options.memoryTools ?? !delegatedConnection,
    isMemoryEnabled: options.isMemoryEnabled,
    getShellRuntimeBinding: options.getShellRuntimeBinding,
    canOwnRuntimeBindingDecision: async (request) => {
      const trusted = rpc.runtimeBindingAdmissionRequest(request, delegatedConnection)
      return trusted && options.canOwnRuntimeBindingDecision
        ? options.canOwnRuntimeBindingDecision(trusted)
        : false
    },
    authorizeRuntimeBindingAdmission: (admission) =>
      rpc.authorizeRuntimeBindingAdmission(admission, delegatedConnection),
    getRpcConnection: ({ sessionId, projectId, memoryTools }) =>
      delegatedConnection
        ? Promise.resolve(delegatedConnection)
        : rpc.issueSessionConnection(sessionId, projectId, `root-frame-${sessionId}`, memoryTools),
    ...(delegatedConnection
      ? {}
      : {
          registerSessionAlias: (alias: string, sessionId: string) =>
            rpc.registerSessionAlias(alias, sessionId),
          releaseSessionCapabilities: (sessionId: string, tokens: readonly string[]) =>
            rpc.releaseSessionCapabilitiesIfOwned(sessionId, tokens),
          registerSessionSpecialist: (sessionId: string, specialistId: string | undefined) =>
            rpc.registerSessionSpecialist(sessionId, specialistId),
          authorizeExecution: (
            authorization: Parameters<NotebookLocalRpcServer['authorizeExecution']>[0]
          ) => rpc.authorizeExecution(authorization),
          setArtifactTurnBinding: (
            sessionId: string,
            binding: Parameters<NotebookLocalRpcServer['setArtifactTurnBinding']>[1]
          ) => rpc.setArtifactTurnBinding(sessionId, binding),
          clearArtifactTurnBinding: (sessionId: string, ownerExecutionId: string) =>
            rpc.clearArtifactTurnBinding(sessionId, ownerExecutionId),
          prepareTurnInputs: (
            request: Parameters<NotebookLocalRpcServer['prepareNotebookTurnInputs']>[0]
          ) => rpc.prepareNotebookTurnInputs(request),
          registerTurnInputs: (
            request: Parameters<NotebookLocalRpcServer['registerNotebookTurnInputs']>[0]
          ) => rpc.registerNotebookTurnInputs(request),
          peekHandoffContext: options.peekHandoffContext
        })
  }
}
