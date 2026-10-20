import { AsyncLocalStorage } from 'node:async_hooks'
import type { ExecutionIdentity, ExecutionRequest } from '../../shared/earthnano/execution-port'
import type { ExecutionContext, ExecutionCore } from './execution-core'

/** Main-process capability. It is never accepted from renderer payloads or restored from JSON. */
export interface ExecutionScope {
  readonly core: ExecutionCore
  readonly request: ExecutionRequest
  readonly context: ExecutionContext
  identity(): ExecutionIdentity
}

const executions = new AsyncLocalStorage<ExecutionScope>()
const activeScopes = new Map<string, ExecutionScope>()
const physicalCancellation = new AsyncLocalStorage<boolean>()
export const currentExecutionScope = (): ExecutionScope | undefined => executions.getStore()
export const withExecutionScope = <T>(scope: ExecutionScope, work: () => T): T =>
  executions.run(scope, work)
export function registerExecutionScope(scope: ExecutionScope): () => void {
  activeScopes.set(scope.context.executionId, scope)
  return () => {
    activeScopes.delete(scope.context.executionId)
  }
}
/** Main-process delegation capability lookup; all original source identifiers are required. */
export function findExecutionScope(source: {
  projectId: string
  sessionId: string
  promptMessageId: string
}): ExecutionScope | undefined {
  return [...activeScopes.values()].find((scope) => {
    const identity = scope.identity()
    return (
      !scope.context.signal.aborted &&
      scope.request.projectId === source.projectId &&
      identity.sessionId === source.sessionId &&
      identity.promptMessageId === source.promptMessageId
    )
  })
}
export const isPhysicalCancellation = (): boolean => physicalCancellation.getStore() === true
export const withPhysicalCancellation = <T>(work: () => T): T =>
  physicalCancellation.run(true, work)
