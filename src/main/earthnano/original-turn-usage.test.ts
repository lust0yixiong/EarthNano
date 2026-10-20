import { describe, expect, it } from 'vitest'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import { readExecutionTurnUsage, readOriginalTurnUsage } from './original-turn-usage'

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

const admittedGraphSession = (
  prompts: PersistedChatMessage[],
  answers: PersistedChatMessage[],
  executionId = 'execution',
  promptMessageId = prompts[0]!.id
): PersistedChatSession => {
  const source = session([...prompts, ...answers])
  const graph = createLinearConversationGraph({
    sessionId: source.id,
    messages: [...prompts, ...answers],
    createdAt: 1,
    updatedAt: 10
  })
  source.conversationGraph = graph
  const prompt = graph.messages.find(({ id }) => id === promptMessageId)!
  source.runtimeSessionAdmissions = [
    {
      executionId,
      promptMessageId,
      promptRuntimeSegmentId: prompt.runtimeSegmentId!,
      rootFrameId: graph.rootFrameId,
      agentFrameId: graph.rootFrameId,
      messageBranchId: graph.frames.find(({ id }) => id === graph.rootFrameId)!.activeBranchId,
      runtimeSegmentId: prompt.runtimeSegmentId!
    }
  ]
  return source
}

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

describe('readExecutionTurnUsage', () => {
  const usage = { inputTokens: 8, cacheTokens: 2, outputTokens: 3 }

  it('requires exact Session, prompt, execution, and a unique root admission', () => {
    const source = admittedGraphSession(
      [message('prompt', 'user')],
      [message('answer', 'agent', { turnUsage: usage })]
    )
    const read = (
      runtimeExecutionId = 'execution',
      sessionId = 'session',
      promptMessageId = 'prompt'
    ): ReturnType<typeof readExecutionTurnUsage> =>
      readExecutionTurnUsage(source, {
        runtimeExecutionId,
        sessionId,
        promptMessageId
      })

    expect(read()).toEqual({ usage })
    expect(read('other-execution')).toBeUndefined()
    expect(read('execution', 'other-session')).toBeUndefined()
    expect(read('execution', 'session', 'other-prompt')).toBeUndefined()
    source.runtimeSessionAdmissions!.push({ ...source.runtimeSessionAdmissions![0]! })
    expect(read()).toBeUndefined()
  })

  it('uses the exact admitted branch after active-branch changes and same-prompt re-admission', () => {
    const source = admittedGraphSession(
      [message('prompt', 'user')],
      [message('original-answer', 'agent', { turnUsage: usage })]
    )
    const graph = source.conversationGraph!
    const root = graph.branches[0]!
    const originalPrompt = graph.messages.find(({ id }) => id === 'prompt')!
    graph.messages.push({
      ...graph.messages.find(({ id }) => id === 'original-answer')!,
      id: 'alternate-answer',
      content: 'alternate',
      parentMessageId: 'prompt',
      introducedOnBranchId: 'alternate-branch',
      turnUsage: { inputTokens: 99, cacheTokens: 0, outputTokens: 9 }
    })
    graph.branches.push({
      id: 'alternate-branch',
      agentFrameId: graph.rootFrameId,
      parentBranchId: root.id,
      forkMessageId: 'prompt',
      headMessageId: 'alternate-answer',
      createdAt: 2,
      updatedAt: 10
    })
    graph.frames.find(({ id }) => id === graph.rootFrameId)!.activeBranchId = 'alternate-branch'
    source.runtimeSessionAdmissions!.push({
      ...source.runtimeSessionAdmissions![0]!,
      executionId: 'resumed-execution',
      messageBranchId: 'alternate-branch',
      runtimeSegmentId: originalPrompt.runtimeSegmentId!
    })

    expect(
      readExecutionTurnUsage(source, {
        runtimeExecutionId: 'execution',
        sessionId: source.id,
        promptMessageId: 'prompt'
      })
    ).toEqual({ usage })
    expect(
      readExecutionTurnUsage(source, {
        runtimeExecutionId: 'resumed-execution',
        sessionId: source.id,
        promptMessageId: 'prompt'
      })
    ).toEqual({ usage: { inputTokens: 99, cacheTokens: 0, outputTokens: 9 } })
  })

  it('accepts an application-attributed prompt only through exact root admission', () => {
    const appPrompt = message('prompt', 'user', {
      attribution: {
        kind: 'application',
        feature: 'reviewer',
        purpose: 'correction',
        causeReviewId: 'review'
      }
    })
    const source = admittedGraphSession(
      [appPrompt],
      [message('answer', 'agent', { turnUsage: usage })]
    )

    expect(readOriginalTurnUsage(source, 'prompt')).toBeUndefined()
    expect(
      readExecutionTurnUsage(source, {
        runtimeExecutionId: 'execution',
        sessionId: source.id,
        promptMessageId: 'prompt'
      })
    ).toEqual({ usage })
  })

  it('rejects delegated or inherited prompt evidence and ambiguous owners', () => {
    const delegated = admittedGraphSession(
      [
        message('prompt', 'user', {
          delegatedCallerSource: { rootMessageId: 'root', toolInvocationId: 'tool' }
        })
      ],
      [message('answer', 'agent', { turnUsage: usage })]
    )
    const inherited = admittedGraphSession(
      [
        message('prompt', 'user', {
          usageOrigin: { sessionId: 'source-session', messageId: 'source-prompt' }
        })
      ],
      [message('answer', 'agent', { turnUsage: usage })]
    )
    const ambiguous = admittedGraphSession(
      [message('prompt', 'user')],
      [
        message('answer-1', 'agent', { turnUsage: usage }),
        message('answer-2', 'agent', {
          turnUsage: { inputTokens: 100, cacheTokens: 0, outputTokens: 10 }
        })
      ]
    )
    const read = (source: PersistedChatSession): ReturnType<typeof readExecutionTurnUsage> =>
      readExecutionTurnUsage(source, {
        runtimeExecutionId: 'execution',
        sessionId: source.id,
        promptMessageId: 'prompt'
      })

    expect(read(delegated)).toBeUndefined()
    expect(read(inherited)).toBeUndefined()
    expect(read(ambiguous)).toBeUndefined()
  })
})
