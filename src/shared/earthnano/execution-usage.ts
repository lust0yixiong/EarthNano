import type { ExecutionRecord, ExecutionUsage } from './execution-types'

export interface UsageMetricSummary {
  status: 'known' | 'partial' | 'unknown'
  coveredExecutions: number
  /** Known subtotal only. Absence is unknown, including arithmetic overflow. */
  total?: number
}

export interface ExecutionUsageSummary {
  admittedExecutions: number
  /** Same logical prompt can contain cumulative continuations; exclude all its admissions. */
  ambiguousExecutions: number
  tokens: {
    status: UsageMetricSummary['status']
    coveredExecutions: number
    inputTokens?: number
    cacheTokens?: number
    outputTokens?: number
  }
  modelTurns: UsageMetricSummary
  apiRequests: UsageMetricSummary
  costMicrousd: UsageMetricSummary
}

const counter = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const scopeKey = (record: ExecutionRecord): string | undefined => {
  const { sessionId, promptMessageId } = record.identity
  return sessionId && promptMessageId ? JSON.stringify([sessionId, promptMessageId]) : undefined
}

/** A projection of authoritative Core records, never a second accounting ledger. */
export function summarizeExecutionUsage(
  records: readonly ExecutionRecord[]
): ExecutionUsageSummary {
  const unique = new Map<string, ExecutionRecord>()
  const conflicting = new Set<string>()
  for (const record of records) {
    const previous = unique.get(record.executionId)
    if (
      previous &&
      JSON.stringify([previous.identity, previous.usage]) !==
        JSON.stringify([record.identity, record.usage])
    )
      conflicting.add(record.executionId)
    unique.set(record.executionId, record)
  }
  const scopes = new Map<string, number>()
  for (const record of unique.values()) {
    const key = scopeKey(record)
    if (key) scopes.set(key, (scopes.get(key) ?? 0) + 1)
  }
  const eligible: ExecutionUsage[] = []
  let ambiguousExecutions = 0
  for (const record of unique.values()) {
    const key = scopeKey(record)
    if (conflicting.has(record.executionId) || (key && scopes.get(key)! > 1)) {
      ambiguousExecutions++
      continue
    }
    const usage = record.usage
    if (
      !key ||
      usage?.status !== 'known' ||
      usage.source?.scope !== 'logical-prompt' ||
      usage.source.sessionId !== record.identity.sessionId ||
      usage.source.promptMessageId !== record.identity.promptMessageId ||
      !usage.source.ownerMessageId
    )
      continue
    eligible.push(usage)
  }
  const admittedExecutions = unique.size
  const status = (covered: number): UsageMetricSummary['status'] =>
    covered === 0 ? 'unknown' : covered === admittedExecutions ? 'known' : 'partial'
  const metric = (field: 'modelTurns' | 'apiRequests' | 'costMicrousd'): UsageMetricSummary => {
    const values = eligible.map((usage) => usage[field]).filter(counter)
    const total = values.reduce((sum, value) => sum + value, 0)
    return counter(total) && values.length
      ? { status: status(values.length), coveredExecutions: values.length, total }
      : { status: 'unknown', coveredExecutions: 0 }
  }
  const tokenUsage = eligible.filter(
    (usage) =>
      counter(usage.inputTokens) && counter(usage.cacheTokens) && counter(usage.outputTokens)
  )
  const totals = tokenUsage.reduce(
    (sum, usage) => ({
      inputTokens: sum.inputTokens + usage.inputTokens!,
      cacheTokens: sum.cacheTokens + usage.cacheTokens!,
      outputTokens: sum.outputTokens + usage.outputTokens!
    }),
    { inputTokens: 0, cacheTokens: 0, outputTokens: 0 }
  )
  const tokens: ExecutionUsageSummary['tokens'] =
    tokenUsage.length && Object.values(totals).every(counter)
      ? { status: status(tokenUsage.length), coveredExecutions: tokenUsage.length, ...totals }
      : { status: 'unknown', coveredExecutions: 0 }
  return {
    admittedExecutions,
    ambiguousExecutions,
    tokens,
    modelTurns: metric('modelTurns'),
    apiRequests: metric('apiRequests'),
    costMicrousd: metric('costMicrousd')
  }
}
