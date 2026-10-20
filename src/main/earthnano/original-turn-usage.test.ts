import { describe, expect, it } from 'vitest'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import { readOriginalTurnUsage } from './original-turn-usage'

const message = (
  id: string,
  role: PersistedChatMessage['role'],
  overrides: Partial<PersistedChatMessage> = {}
): PersistedChatMessage => ({
  id,
  role,
  content: id,
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const session = (
  messages: PersistedChatMessage[],
  overrides: Partial<PersistedChatSession> = {}
): PersistedChatSession =>
  ({
    id: 'session',
    projectId: 'project',
    title: 'Session',
    cwd: '/workspace',
    status: 'idle',
    pinned: false,
    revision: 1,
    activeMessageCount: messages.length,
    artifactCount: 0,
    filesRevision: 0,
    createdAt: 1,
    updatedAt: 10,
    needsStartupRecovery: false,
    messages,
    ...overrides
  }) as PersistedChatSession

describe('readOriginalTurnUsage', () => {
  it('reads only the requested root prompt interval and excludes later turns', () => {
    const firstUsage = { inputTokens: 11, cacheTokens: 3, outputTokens: 5 }
    const secondUsage = { inputTokens: 90, cacheTokens: 0, outputTokens: 20 }
    const source = session([
      message('prompt-1', 'user'),
      message('answer-1', 'agent', { turnUsage: firstUsage }),
      message('prompt-2', 'user'),
      message('answer-2', 'agent', { turnUsage: secondUsage })
    ])

    expect(readOriginalTurnUsage(source, 'prompt-1')).toEqual({ usage: firstUsage })
    expect(readOriginalTurnUsage(source, 'prompt-2')).toEqual({ usage: secondUsage })
  })

  it('uses the prompt admission branch even after another root branch becomes active', () => {
    const originalUsage = { inputTokens: 20, cacheTokens: 1, outputTokens: 6 }
    const source = session([
      message('prompt', 'user'),
      message('answer', 'agent', { turnUsage: originalUsage })
    ])
    const graph = createLinearConversationGraph({
      sessionId: source.id,
      messages: source.messages,
      createdAt: 1,
      updatedAt: 10
    })
    const root = graph.branches[0]!
    const frame = graph.frames.find(({ id }) => id === graph.rootFrameId)!
    const alternate = {
      ...graph.messages.find(({ id }) => id === 'answer')!,
      id: 'alternate-answer',
      content: 'alternate',
      parentMessageId: 'prompt',
      introducedOnBranchId: 'alternate-branch',
      turnUsage: { inputTokens: 40, cacheTokens: 2, outputTokens: 12 }
    }
    graph.messages.push(alternate)
    graph.branches.push({
      id: 'alternate-branch',
      agentFrameId: graph.rootFrameId,
      parentBranchId: root.id,
      forkMessageId: 'prompt',
      headMessageId: alternate.id,
      createdAt: 2,
      updatedAt: 10
    })
    frame.activeBranchId = 'alternate-branch'
    source.conversationGraph = graph
    source.runtimeSessionAdmissions = [
      {
        executionId: 'original-execution',
        promptMessageId: 'prompt',
        promptRuntimeSegmentId: graph.messages.find(({ id }) => id === 'prompt')!.runtimeSegmentId!,
        rootFrameId: graph.rootFrameId,
        agentFrameId: graph.rootFrameId,
        messageBranchId: root.id,
        runtimeSegmentId: graph.messages.find(({ id }) => id === 'prompt')!.runtimeSegmentId!
      }
    ]

    expect(readOriginalTurnUsage(source, 'prompt')).toEqual({
      usage: originalUsage
    })
  })

  it('fails closed for graph turns without an exact persisted root admission', () => {
    const source = session([message('prompt', 'user'), message('answer', 'agent')])
    source.conversationGraph = createLinearConversationGraph({
      sessionId: source.id,
      messages: [
        message('prompt', 'user'),
        message('answer', 'agent', {
          turnUsage: { inputTokens: 10, cacheTokens: 0, outputTokens: 2 }
        })
      ],
      createdAt: 1,
      updatedAt: 10
    })

    expect(readOriginalTurnUsage(source, 'prompt')).toBeUndefined()
  })

  it('returns unknown for absent, unavailable, or ambiguous repeated turn usage', () => {
    expect(readOriginalTurnUsage(session([message('prompt', 'user')]), 'prompt')).toBeUndefined()
    expect(
      readOriginalTurnUsage(
        session([
          message('prompt', 'user'),
          message('answer', 'agent', { turnUsageUnavailable: true })
        ]),
        'prompt'
      )
    ).toBeUndefined()
    expect(
      readOriginalTurnUsage(
        session([
          message('prompt', 'user'),
          message('inherited-answer', 'agent', {
            usageOrigin: { sessionId: 'source-session', messageId: 'source-answer' },
            turnUsage: { inputTokens: 99, cacheTokens: 2, outputTokens: 10 }
          })
        ]),
        'prompt'
      )
    ).toBeUndefined()
    expect(
      readOriginalTurnUsage(
        session([
          message('prompt', 'user'),
          message('answer-1', 'agent', {
            turnUsage: { inputTokens: 1, cacheTokens: 0, outputTokens: 1 }
          }),
          message('answer-2', 'agent', {
            turnUsage: { inputTokens: 2, cacheTokens: 0, outputTokens: 1 }
          })
        ]),
        'prompt'
      )
    ).toBeUndefined()
    const duplicate = message('answer', 'agent', {
      turnUsage: { inputTokens: 1, cacheTokens: 0, outputTokens: 1 }
    })
    expect(
      readOriginalTurnUsage(
        session([message('prompt', 'user'), duplicate, { ...duplicate }]),
        'prompt'
      )
    ).toBeUndefined()
    expect(readOriginalTurnUsage(session([message('prompt', 'user')]), 'missing')).toBeUndefined()
  })

  it('preserves explicit zero totals and validated cache split', () => {
    const zero = { inputTokens: 0, cacheTokens: 0, outputTokens: 0 }
    expect(
      readOriginalTurnUsage(
        session([message('prompt', 'user'), message('answer', 'agent', { turnUsage: zero })]),
        'prompt'
      )
    ).toEqual({ usage: zero })

    const usage = {
      inputTokens: 7,
      cacheTokens: 5,
      cachedReadTokens: 3,
      cachedWriteTokens: 2,
      outputTokens: 4,
      turnCount: 2
    }
    const modelCallUsage = [
      { id: 'call-1', index: 0, inputTokens: 3, cacheTokens: 2, outputTokens: 1 },
      { id: 'call-2', index: 1, inputTokens: 4, cacheTokens: 3, outputTokens: 3 }
    ]
    expect(
      readOriginalTurnUsage(
        session([
          message('prompt', 'user'),
          message('answer', 'agent', { turnUsage: usage, modelCallUsage })
        ]),
        'prompt'
      )
    ).toEqual({ usage, modelCallUsage })
  })

  it('does not turn context-window facts into turn usage and drops an inconsistent cache split', () => {
    const source = session([
      message('prompt', 'user'),
      message('answer', 'agent', {
        contextWindowSamples: [
          {
            id: 'sample',
            timestamp: 2,
            termination: { kind: 'stop', stopReason: 'end_turn' },
            contextWindow: { used: 999 },
            source: 'provider-response'
          }
        ],
        turnUsage: {
          inputTokens: 7,
          cacheTokens: 5,
          cachedReadTokens: 2,
          cachedWriteTokens: 2,
          outputTokens: 4
        }
      })
    ])

    expect(readOriginalTurnUsage(source, 'prompt')).toEqual({
      usage: { inputTokens: 7, cacheTokens: 5, outputTokens: 4 }
    })
  })
})
