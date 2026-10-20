import { sanitizeAcpTurnTokenUsage } from '../../shared/acp'
import type { ExecutionIdentity, ExecutionUsage } from '../../shared/earthnano/execution-port'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { readExecutionTurnUsage, type OriginalTurnUsage } from './original-turn-usage'

/** Original provider-reported logical prompt totals, never an HTTP count or execution delta. */
export function toExecutionUsage(
  original: OriginalTurnUsage | undefined,
  identity: Pick<ExecutionIdentity, 'sessionId' | 'promptMessageId'>
): ExecutionUsage {
  const usage = sanitizeAcpTurnTokenUsage(original?.usage)
  if (!usage || !original?.ownerMessageId || !identity.sessionId || !identity.promptMessageId)
    return { status: 'unknown' }
  return {
    status: 'known',
    inputTokens: usage.inputTokens,
    cacheTokens: usage.cacheTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedReadTokens === undefined || usage.cachedWriteTokens === undefined
      ? {}
      : { cachedReadTokens: usage.cachedReadTokens, cachedWriteTokens: usage.cachedWriteTokens }),
    ...(usage.turnCount === undefined ? {} : { modelTurns: usage.turnCount }),
    source: {
      scope: 'logical-prompt',
      sessionId: identity.sessionId,
      promptMessageId: identity.promptMessageId,
      ownerMessageId: original.ownerMessageId
    }
  }
}

/** Requires the original runtime token. Legacy aliases do not gain new usage authority. */
export function readOriginalExecutionUsage(
  session: PersistedChatSession,
  identity: Pick<ExecutionIdentity, 'sessionId' | 'promptMessageId' | 'runtimeExecutionId'>
): ExecutionUsage {
  return toExecutionUsage(readExecutionTurnUsage(session, identity), identity)
}
