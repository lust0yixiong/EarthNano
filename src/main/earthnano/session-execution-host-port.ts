import type { PromptResponse } from '@agentclientprotocol/sdk'
import type { AcpExecutionDispatch, PreAdmissionRetirement } from '../acp/execution-boundary-port'
import type { ExecutionIdentity, ExecutionRequest } from '../../shared/earthnano/execution-port'
import type { ExecutionContext, ExecutionOutcome, ExecutionStore } from './execution-core'

export interface SessionExecutionSettlement {
  /** Exact identity committed by the original admission callback; never inferred from latest turn. */
  identity: ExecutionIdentity
  response?: PromptResponse
  error?: unknown
  preAdmissionRetirement?: PreAdmissionRetirement
  context: ExecutionContext
}

export interface PreparedSessionExecution {
  request: ExecutionRequest
  budgetLimit: number
  /** Original host owns exclusive write access; no model/provider work during preparation. */
  store: ExecutionStore
  /** Original resource owner facts, after the task-owned completion barrier when supplied. */
  readResult(settlement: SessionExecutionSettlement): Promise<ExecutionOutcome>
  close(): void
}

export interface SessionExecutionHost {
  prepare(input: AcpExecutionDispatch): Promise<PreparedSessionExecution>
}
