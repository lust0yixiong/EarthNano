import { sanitizeAcpModelCallUsage, sanitizeAcpTurnTokenUsage } from '../../shared/acp'
import { resolveMessageBranchPath } from '../../shared/conversation-graph'
import {
  sessionUsageMessages,
  sessionUsageRuns,
  type SessionUsageMessage
} from '../../shared/session-usage'
import type { AcpModelCallUsage, AcpTurnTokenUsage } from '../../shared/acp-usage-contract'
import type { ExecutionIdentity } from '../../shared/earthnano/execution-types'
import {
  isHumanUserMessage,
  isHiddenControlMessage,
  isTurnAnchor,
  turnAnchorInterval,
  type PersistedChatMessage,
  type PersistedChatSession
} from '../../shared/session-persistence'

export type OriginalTurnUsage = Readonly<{
  usage: AcpTurnTokenUsage
  modelCallUsage?: readonly AcpModelCallUsage[]
}>

const exactModelCallUsage = (
  message: PersistedChatMessage,
  usage: AcpTurnTokenUsage
): readonly AcpModelCallUsage[] | undefined => {
  if (!usage.turnCount || !Array.isArray(message.modelCallUsage)) return undefined
  const calls = message.modelCallUsage.map(sanitizeAcpModelCallUsage)
  if (
    calls.length !== usage.turnCount ||
    calls.some((call, index) => !call || call.index !== index) ||
    new Set(calls.map((call) => call?.id)).size !== calls.length
  ) {
    return undefined
  }

  const validCalls = calls as AcpModelCallUsage[]
  const totals = validCalls.reduce(
    (sum, call) => ({
      inputTokens: sum.inputTokens + call.inputTokens,
      cacheTokens: sum.cacheTokens + call.cacheTokens,
      outputTokens: sum.outputTokens + call.outputTokens
    }),
    { inputTokens: 0, cacheTokens: 0, outputTokens: 0 }
  )
  return Number.isSafeInteger(totals.inputTokens) &&
    Number.isSafeInteger(totals.cacheTokens) &&
    Number.isSafeInteger(totals.outputTokens) &&
    totals.inputTokens === usage.inputTokens &&
    totals.cacheTokens === usage.cacheTokens &&
    totals.outputTokens === usage.outputTokens
    ? validCalls
    : undefined
}

const rootTurnScopes = (
  session: PersistedChatSession,
  scoped: readonly SessionUsageMessage[],
  promptMessageId: string,
  exactAdmission?: NonNullable<PersistedChatSession['runtimeSessionAdmissions']>[number]
): readonly PersistedChatMessage[][] => {
  if (!session.conversationGraph) {
    return [
      scoped
        .filter(({ isRootFrame, inherited }) => isRootFrame && !inherited)
        .map(({ message }) => message)
    ]
  }

  const graph = session.conversationGraph
  const rootFrame = graph.frames.find(({ id }) => id === graph.rootFrameId)
  if (!rootFrame) return []
  const admittedBranchIds = new Set(
    (exactAdmission
      ? [exactAdmission]
      : (session.runtimeSessionAdmissions ?? []).filter(
          (admission) =>
            admission.promptMessageId === promptMessageId &&
            admission.rootFrameId === rootFrame.id &&
            admission.agentFrameId === rootFrame.id
        )
    ).map(({ messageBranchId }) => messageBranchId)
  )
  if (admittedBranchIds.size === 0) return []
  try {
    const scopedById = new Map<string, SessionUsageMessage>()
    for (const entry of scoped) {
      if (scopedById.has(entry.message.id)) return []
      scopedById.set(entry.message.id, entry)
    }
    const scopes: PersistedChatMessage[][] = []
    for (const branchId of admittedBranchIds) {
      const branch = graph.branches.find(
        ({ id, agentFrameId }) => id === branchId && agentFrameId === rootFrame.id
      )
      if (!branch) continue
      const path = resolveMessageBranchPath(graph, branch.id)
      const messages = path
        .map(({ id }) => scopedById.get(id))
        .filter(
          (entry): entry is SessionUsageMessage => !!entry && entry.isRootFrame && !entry.inherited
        )
        .map(({ message }) => message)
      if (messages.some(({ id }) => id === promptMessageId)) scopes.push(messages)
    }
    return scopes
  } catch {
    return []
  }
}

/** Reads one authoritative, non-inherited root prompt's provider-reported turn usage. */
const readTurnUsage = (
  session: PersistedChatSession,
  promptMessageId: string,
  exactAdmission?: NonNullable<PersistedChatSession['runtimeSessionAdmissions']>[number]
): OriginalTurnUsage | undefined => {
  if (!promptMessageId) return undefined
  const scoped = sessionUsageMessages(session)
  const eligiblePromptIds = new Set(
    sessionUsageRuns(session, scoped).map(({ messageId }) => messageId)
  )
  if (exactAdmission) {
    const prompt = scoped.find(({ message }) => message.id === promptMessageId)
    // Exact Main admission proves application ownership, so attribution alone may be present.
    // Relayed/presentation/hidden/delegated/inherited prompts still cannot own usage here.
    if (
      !prompt ||
      !prompt.isRootFrame ||
      prompt.inherited ||
      prompt.message.role !== 'user' ||
      prompt.message.presentation ||
      prompt.message.relayedFrom ||
      prompt.message.delegatedCallerSource ||
      isHiddenControlMessage(prompt.message)
    )
      return undefined
    eligiblePromptIds.add(promptMessageId)
  }
  if (!eligiblePromptIds.has(promptMessageId)) return undefined

  const scopes = rootTurnScopes(session, scoped, promptMessageId, exactAdmission)
  if (scopes.length === 0) return undefined
  const ownersById = new Map<string, PersistedChatMessage>()
  for (const messages of scopes) {
    const ids = new Set<string>()
    for (const message of messages) {
      if (ids.has(message.id)) return undefined
      ids.add(message.id)
    }

    const prompt = messages.find(({ id }) => id === promptMessageId)
    if (
      !prompt ||
      !isTurnAnchor(prompt) ||
      (!exactAdmission && !isHumanUserMessage(prompt)) ||
      isHiddenControlMessage(prompt)
    ) {
      continue
    }
    for (const message of turnAnchorInterval(messages, promptMessageId)) {
      if (message.role === 'agent' && message.turnUsage !== undefined) {
        ownersById.set(message.id, message)
      }
    }
  }

  // Multiple root admissions on the same branch can replay an identical owner; IDs deduplicate
  // that persistence view. Distinct terminal owners remain ambiguous and are never summed here.
  if (ownersById.size !== 1) return undefined
  const owner = ownersById.values().next().value as PersistedChatMessage | undefined
  if (!owner) return undefined

  const usage = sanitizeAcpTurnTokenUsage(owner.turnUsage)
  if (!usage) {
    return undefined
  }
  const modelCallUsage = exactModelCallUsage(owner, usage)
  return {
    usage,
    ...(modelCallUsage ? { modelCallUsage } : {})
  }
}

/** Reads provider-reported usage only when a Core identity's runtime token matches one admission. */
export const readExecutionTurnUsage = (
  session: PersistedChatSession,
  identity: Pick<ExecutionIdentity, 'sessionId' | 'promptMessageId' | 'runtimeExecutionId'>
): OriginalTurnUsage | undefined => {
  const { runtimeExecutionId, promptMessageId } = identity
  if (!runtimeExecutionId || !promptMessageId || identity.sessionId !== session.id) return undefined
  const admissions = (session.runtimeSessionAdmissions ?? []).filter(
    (admission) =>
      admission.executionId === runtimeExecutionId && admission.promptMessageId === promptMessageId
  )
  if (admissions.length !== 1) return undefined
  const admission = admissions[0]!
  const graph = session.conversationGraph
  if (
    !graph ||
    admission.rootFrameId !== graph.rootFrameId ||
    admission.agentFrameId !== graph.rootFrameId
  )
    return undefined
  const prompt = graph.messages.find(({ id }) => id === promptMessageId)
  if (
    !prompt ||
    prompt.agentFrameId !== graph.rootFrameId ||
    prompt.runtimeSegmentId !== admission.promptRuntimeSegmentId
  )
    return undefined

  // Limit the generic reader to this exact admission. A prior or resumed execution may reuse the
  // same prompt ID on another branch; it must not make this execution ambiguous or be summed.
  return readTurnUsage(session, promptMessageId, admission)
}

/** Reads a human-authored prompt's provider-reported usage without an ExecutionRecord identity. */
export const readOriginalTurnUsage = (
  session: PersistedChatSession,
  promptMessageId: string
): OriginalTurnUsage | undefined => readTurnUsage(session, promptMessageId)
