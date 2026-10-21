import { AsyncLocalStorage } from 'node:async_hooks'
import type { ExecutionIdentity, ExecutionRequest } from '../../shared/earthnano/execution-port'
import type { ExecutionContext, ScopedExecutionPort } from './execution-contract'

/** Main-process capability. It is never accepted from renderer payloads or restored from JSON. */
export interface ExecutionScope {
  readonly core: ScopedExecutionPort
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
/** Validates explicit internal parent links against a live original Session execution. */
export function findExecutionScopeById(source: {
  executionId: string
  projectId: string
  sessionId: string
}): ExecutionScope | undefined {
  const scope = activeScopes.get(source.executionId)
  if (
    !scope ||
    scope.context.signal.aborted ||
    scope.request.projectId !== source.projectId ||
    scope.identity().sessionId !== source.sessionId
  )
    return undefined
  return scope
}
/** Exact private delegated owner capability, including SDK callbacks outside async context. */
export function findOwnedExecutionScope(owner: {
  projectId: string
  sourceSessionId: string
  ownsExecution(executionId: string): boolean
}): ExecutionScope | undefined {
  return [...activeScopes.values()].find(
    (scope) =>
      !scope.context.signal.aborted &&
      scope.request.projectId === owner.projectId &&
      scope.request.origin.sessionId === owner.sourceSessionId &&
      owner.ownsExecution(scope.context.executionId)
  )
}
export const isPhysicalCancellation = (): boolean => physicalCancellation.getStore() === true
export const withPhysicalCancellation = <T>(work: () => T): T =>
  physicalCancellation.run(true, work)
