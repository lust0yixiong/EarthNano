import type {
  CancellationReceipt,
  ExecutionEvent,
  ExecutionHandle,
  ExecutionRecord,
  ExecutionRequest
} from './execution-types'

export type * from './execution-types'

export interface ExecutionPort {
  submit(request: ExecutionRequest): Promise<ExecutionHandle>
  get(executionId: string): Promise<ExecutionRecord>
  cancel(executionId: string): Promise<CancellationReceipt>
  /** Finite replay of currently committed events. Poll again using the last sequence. */
  events(executionId: string, afterSequence?: number): AsyncIterable<ExecutionEvent>
}
