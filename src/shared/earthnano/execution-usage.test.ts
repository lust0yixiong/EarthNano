import { describe, expect, it } from 'vitest'
import type { ExecutionRecord, ExecutionUsage } from './execution-types'
import { summarizeExecutionUsage } from './execution-usage'

const record = (id: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord =>
  ({
    executionId: id,
    identity: { sessionId: `session-${id}`, promptMessageId: 'prompt' },
    phase: 'completed',
    usage: {
      status: 'known',
      inputTokens: 7,
      cacheTokens: 5,
      outputTokens: 4,
      modelTurns: 2,
      source: {
        scope: 'logical-prompt',
        sessionId: `session-${id}`,
        promptMessageId: 'prompt',
        ownerMessageId: 'answer'
      }
    },
    ...overrides
  }) as ExecutionRecord

describe('Core usage projection', () => {
  it('counts shared baselines once and keeps inference turns separate from HTTP and price', () => {
    const baseline = record('base')
    const result = summarizeExecutionUsage([
      baseline,
      record('candidate'),
      structuredClone(baseline)
    ])
    expect(result).toEqual({
      admittedExecutions: 2,
      ambiguousExecutions: 0,
      tokens: {
        status: 'known',
        coveredExecutions: 2,
        inputTokens: 14,
        cacheTokens: 10,
        outputTokens: 8
      },
      modelTurns: { status: 'known', coveredExecutions: 2, total: 4 },
      apiRequests: { status: 'unknown', coveredExecutions: 0 },
      costMicrousd: { status: 'unknown', coveredExecutions: 0 }
    })
  })

  it('does not sum cumulative same-prompt continuations, including an earlier unknown attempt', () => {
    const first = record('first', { usage: { status: 'unknown' }, phase: 'interrupted' })
    const continued = record('continued', {
      identity: first.identity,
      usage: {
        ...record('first').usage,
        inputTokens: 90,
        cacheTokens: 80,
        outputTokens: 70
      }
    })
    const result = summarizeExecutionUsage([first, continued, record('fresh')])
    expect(result.ambiguousExecutions).toBe(2)
    expect(result.tokens).toEqual({
      status: 'partial',
      coveredExecutions: 1,
      inputTokens: 7,
      cacheTokens: 5,
      outputTokens: 4
    })
    expect(result.modelTurns).toEqual({ status: 'partial', coveredExecutions: 1, total: 2 })
  })

  it('preserves explicit zero but never treats unavailable cancellation or legacy totals as zero', () => {
    const zero = record('zero')
    zero.usage = {
      ...zero.usage,
      inputTokens: 0,
      cacheTokens: 0,
      outputTokens: 0,
      modelTurns: 0,
      apiRequests: 0,
      costMicrousd: 0
    }
    const result = summarizeExecutionUsage([
      zero,
      record('cancelled', { phase: 'cancelled', usage: { status: 'unknown' } }),
      record('legacy', { usage: { status: 'known', inputTokens: 200, outputTokens: 100 } })
    ])
    expect(result.tokens).toMatchObject({ status: 'partial', coveredExecutions: 1, inputTokens: 0 })
    expect(result.apiRequests).toEqual({ status: 'partial', coveredExecutions: 1, total: 0 })
    expect(result.costMicrousd).toEqual({ status: 'partial', coveredExecutions: 1, total: 0 })
    expect(summarizeExecutionUsage([]).tokens).toEqual({ status: 'unknown', coveredExecutions: 0 })
  })

  it('rejects foreign attribution and conflicting snapshots of the same execution', () => {
    const foreign = record('foreign')
    foreign.usage.source!.sessionId = 'another-session'
    const first = record('conflict')
    const newer = structuredClone(first)
    newer.usage.inputTokens = 99
    expect(summarizeExecutionUsage([foreign, first, newer])).toMatchObject({
      admittedExecutions: 2,
      ambiguousExecutions: 1,
      tokens: { status: 'unknown', coveredExecutions: 0 }
    })
  })

  it('retains actual completed-owner usage even when later publication failed', () => {
    const result = summarizeExecutionUsage([record('failed', { phase: 'failed' })])
    expect(result.tokens.status).toBe('known')
    expect(result.tokens.outputTokens).toBe(4)
  })

  it('fails closed for overflow, invalid counters and missing individual metrics', () => {
    const invalid = record('invalid', {
      usage: { ...record('invalid').usage, inputTokens: -1 } as ExecutionUsage
    })
    const largest = record('largest')
    largest.usage.outputTokens = Number.MAX_SAFE_INTEGER
    largest.usage.modelTurns = Number.MAX_SAFE_INTEGER
    const result = summarizeExecutionUsage([invalid, largest, record('one')])
    expect(result.tokens).toEqual({ status: 'unknown', coveredExecutions: 0 })
    expect(result.modelTurns).toEqual({ status: 'unknown', coveredExecutions: 0 })
  })
})
