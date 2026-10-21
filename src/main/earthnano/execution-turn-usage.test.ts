import { expect, it } from 'vitest'
import { toExecutionUsage } from './execution-turn-usage'

const identity = { sessionId: 'session', promptMessageId: 'prompt' }
it('preserves original input/cache/output/model turns and logical owner without inferring HTTP or cost', () => {
  expect(
    toExecutionUsage(
      {
        ownerMessageId: 'original-answer',
        usage: {
          inputTokens: 7,
          cacheTokens: 5,
          cachedReadTokens: 3,
          cachedWriteTokens: 2,
          outputTokens: 4,
          turnCount: 2
        },
        modelCallUsage: [
          { id: 'one', index: 0, inputTokens: 3, cacheTokens: 2, outputTokens: 1 },
          { id: 'two', index: 1, inputTokens: 4, cacheTokens: 3, outputTokens: 3 }
        ]
      },
      identity
    )
  ).toEqual({
    status: 'known',
    inputTokens: 7,
    cacheTokens: 5,
    cachedReadTokens: 3,
    cachedWriteTokens: 2,
    outputTokens: 4,
    modelTurns: 2,
    source: { scope: 'logical-prompt', ...identity, ownerMessageId: 'original-answer' }
  })
})
it('keeps reported zero totals distinct from absent usage and omits unknown optional fields', () => {
  expect(
    toExecutionUsage(
      { ownerMessageId: 'answer', usage: { inputTokens: 0, cacheTokens: 0, outputTokens: 0 } },
      identity
    )
  ).toEqual({
    status: 'known',
    inputTokens: 0,
    cacheTokens: 0,
    outputTokens: 0,
    source: { scope: 'logical-prompt', ...identity, ownerMessageId: 'answer' }
  })
  expect(toExecutionUsage(undefined, identity)).toEqual({ status: 'unknown' })
  expect(
    toExecutionUsage(
      { ownerMessageId: 'answer', usage: { inputTokens: 1, cacheTokens: 2, outputTokens: 3 } },
      { sessionId: 'session' }
    )
  ).toEqual({ status: 'unknown' })
})
it('reuses original sanitizers instead of copying untrusted fields or inconsistent optional pairs', () => {
  const original = {
    ownerMessageId: 'answer',
    usage: {
      inputTokens: 7,
      cacheTokens: 5,
      cachedReadTokens: 2,
      cachedWriteTokens: 2,
      outputTokens: 4,
      turnCount: 0,
      apiRequests: 99,
      costMicrousd: 10
    }
  }
  expect(toExecutionUsage(original, identity)).toEqual({
    status: 'known',
    inputTokens: 7,
    cacheTokens: 5,
    outputTokens: 4,
    source: { scope: 'logical-prompt', ...identity, ownerMessageId: 'answer' }
  })
  for (const invalid of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(
      toExecutionUsage(
        { ...original, usage: { ...original.usage, inputTokens: invalid } },
        identity
      )
    ).toEqual({ status: 'unknown' })
})
