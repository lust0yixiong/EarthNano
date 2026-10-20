import type { PromptResponse } from '@agentclientprotocol/sdk'
import type { AcpExecutionDispatch } from '../acp/execution-boundary-port'
import type { ExecutionRequest } from '../../shared/earthnano/execution-port'
import type { ExecutionContext, ExecutionOutcome, ExecutionStore } from './execution-core'

export interface SessionExecutionSettlement {
  response?: PromptResponse
  error?: unknown
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
