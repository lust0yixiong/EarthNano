import { expect, it } from 'vitest'
import { createLinearConversationGraph } from '../conversation-graph'
import type { PersistedChatMessage, PersistedChatSession } from '../session-persistence'
import {
  notebookOptimizationSourceMessages,
  normalizeNotebookOptimizationSource
} from './notebook-source'

const message = (id: string): PersistedChatMessage => ({
  id,
  role: 'user',
  content: id,
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1,
  uploads: [
    {
      id: 'file',
      sessionId: 'session',
      versionId: 'version',
      sha256: 'a'.repeat(64),
      name: 'input.csv',
      originalName: 'input.csv',
      size: 5
    }
  ]
})
const source = (): PersistedChatSession =>
  ({ id: 'session', projectId: 'project', messages: [message('active')] }) as PersistedChatSession

it('uses the original active graph rather than stale flat source messages', () => {
  const session = source()
  session.conversationGraph = createLinearConversationGraph({
    sessionId: session.id,
    messages: session.messages,
    createdAt: 1,
    updatedAt: 1
  })
  session.messages = [message('stale-flat')]
  expect(notebookOptimizationSourceMessages(session).map((entry) => entry.id)).toEqual(['active'])
})
it('hides unsupported source metadata and incomplete upload authority from the picker', () => {
  const session = source()
  const relay = { ...message('relay'), turnIntent: 'plan-first' } as PersistedChatMessage
  const missingVersion = message('missing-version')
  delete missingVersion.uploads![0].versionId
  const foreign = message('foreign-owner')
  foreign.uploads![0].sessionId = 'other-session'
  session.messages.push(relay, missingVersion, foreign)
  expect(notebookOptimizationSourceMessages(session).map((entry) => entry.id)).toEqual(['active'])
})
it('retains version-bound references whose original file owner differs from the prompt Session', () => {
  const session = source()
  delete session.messages[0].uploads
  session.messages[0].parts = [
    {
      type: 'artifact',
      id: 'part',
      source: 'artifact',
      sourceFileId: 'retained-file',
      versionId: 'retained-version',
      name: 'input.csv',
      path: 'artifact-version:retained-version'
    }
  ]
  expect(notebookOptimizationSourceMessages(session)).toHaveLength(1)
})

it('preserves old source request bytes and accepts only explicitly declared supported languages', () => {
  expect(JSON.stringify(normalizeNotebookOptimizationSource({ promptMessageId: 'old' }))).toBe(
    '{"promptMessageId":"old"}'
  )
  for (const language of ['python', 'r'] as const)
    expect(normalizeNotebookOptimizationSource({ promptMessageId: 'task', language })).toEqual({
      promptMessageId: 'task',
      language
    })
  for (const language of ['R', 'javascript', '', null, undefined])
    expect(() =>
      normalizeNotebookOptimizationSource({ promptMessageId: 'task', language })
    ).toThrow()
  expect(() =>
    normalizeNotebookOptimizationSource({
      promptMessageId: 'task',
      language: 'r',
      interpreterPath: '/R'
    })
  ).toThrow()
})
