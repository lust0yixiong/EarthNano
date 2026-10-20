import type { PromptResponse } from '@agentclientprotocol/sdk'
import type { AcpPromptRequest, AcpRuntimeState, AcpSessionAgentTarget } from '../../shared/acp'
import type { ExecutionIdentity, ExecutionRecord } from '../../shared/earthnano/execution-port'

export interface AcpExecutionObservation {
  /** Called only after the original durable Session owner has admitted this exact turn. */
  admitted(identity: ExecutionIdentity): void
  providerAccepted(): void
}

export interface AcpExecutionLink {
  executionId: string
  /** Resolves only after original owners and the canonical execution record have settled. */
  settled: Promise<ExecutionRecord>
}

export interface AcpExecutionOwnerCompletion {
  /** Task API owns its Session/artifact/review terminal commit after native prompt return. */
  committed: Promise<void>
  linked?(link: AcpExecutionLink): void
}

export interface AcpExecutionDispatch {
  request: AcpPromptRequest
  operation: 'sendPrompt' | 'sendAppContinuation' | 'sendApplicationPrompt'
  runtimeReviewOwner: 'task' | 'renderer'
  target?: AcpSessionAgentTarget
  ownerCompletion?: AcpExecutionOwnerCompletion
  dispatch(observation: AcpExecutionObservation): Promise<PromptResponse>
  /** Pinned original owner operation; must verify this dispatch still owns cancellation. */
  cancelOwned(): Promise<void>
}

export interface AcpExecutionBoundary {
  execute(input: AcpExecutionDispatch): Promise<PromptResponse>
  cancel(sessionId: string, cancelOriginal: () => Promise<AcpRuntimeState>): Promise<AcpRuntimeState>
  settle(): Promise<boolean>
}
