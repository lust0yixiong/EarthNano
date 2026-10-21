import type { PromptResponse } from '@agentclientprotocol/sdk'
import type { AcpPromptRequest, AcpRuntimeState, AcpSessionAgentTarget } from '../../shared/acp'
import type { MessageAttribution } from '../../shared/session-message-contract'
import type { ExecutionIdentity, ExecutionRecord } from '../../shared/earthnano/execution-port'

export interface AcpExecutionObservation {
  /** Called only after the original durable Session owner has admitted this exact turn. */
  admitted(identity: ExecutionIdentity): void
  providerAccepted(): void
}

export interface AcpExecutionLink {
  executionId: string
  /** Exact execution control; a later turn in the same Session must never receive this cancel. */
  cancel?(): Promise<unknown>
  /** Resolves only after original owners and the canonical execution record have settled. */
  settled: Promise<ExecutionRecord>
}

export interface AcpExecutionOwnerCompletion {
  /** Task API owns its Session/artifact/review terminal commit after native prompt return. */
  committed: Promise<void>
  linked?(link: AcpExecutionLink): void
}

/** Main-process physical resource witness; never supplied by a renderer or inferred from identity. */
export interface PreAdmissionRetirement {
  attemptId: string
  sessionId: string
  reaped: true
}

export interface AcpExecutionDispatch {
  /** Original coordinator attempt identity, allocated once before canonical admission. */
  attemptId: string
  request: AcpPromptRequest
  operation: 'sendPrompt' | 'sendAppContinuation' | 'sendApplicationPrompt'
  /** Original main-owned application attribution, never an authorization supplied by model JSON. */
  attribution?: MessageAttribution
  runtimeReviewOwner: 'task' | 'renderer'
  target?: AcpSessionAgentTarget
  ownerCompletion?: AcpExecutionOwnerCompletion
  dispatch(observation: AcpExecutionObservation): Promise<PromptResponse>
  /** Pinned original owner operation; must verify this dispatch still owns cancellation. */
  cancelOwned(): Promise<void>
  /** Retires this exact runtime generation after failed dispatch, before any observed admission. */
  retireUnadmitted?(): Promise<PreAdmissionRetirement | undefined>
}

export interface AcpExecutionBoundary {
  execute(input: AcpExecutionDispatch): Promise<PromptResponse>
  cancel(
    sessionId: string,
    cancelOriginal: () => Promise<AcpRuntimeState>,
    readState: () => AcpRuntimeState
  ): Promise<AcpRuntimeState>
  settle(): Promise<boolean>
}

/** Main-process owned-turn witness; actual Session admission remains the original owner's fact. */
export interface TrustedExecutionTurnOwner {
  readonly projectId: string
  readonly sourceSessionId: string
  ownsExecution(executionId: string): boolean
  ownsTurn(provenance: AcpPromptRequest['provenanceContext']): boolean
  ownsSession(sessionId: string): boolean
}

/** Original application result delivery in an existing execution, never a delegated Attempt. */
export interface TrustedApplicationExecutionOwner extends TrustedExecutionTurnOwner {
  ownsApplicationDispatch(input: AcpExecutionDispatch): boolean
}

/** Main-process owner declaration, constructed only from an admitted delegated Attempt. */
export interface TrustedDelegatedExecutionOwner extends TrustedExecutionTurnOwner {
  readonly parentPromptMessageId: string
  readonly frameId: string
  readonly runtimeSegmentId: string
  readonly attemptId: string
}
