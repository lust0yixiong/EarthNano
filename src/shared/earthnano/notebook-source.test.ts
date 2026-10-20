import { expect, it } from 'vitest'
import { createLinearConversationGraph } from '../conversation-graph'
import type { PersistedChatMessage, PersistedChatSession } from '../session-persistence'
import { notebookOptimizationSourceMessages } from './notebook-source'

const message = (id: string): PersistedChatMessage => ({
  id,
  role: 'user',
  content: id,
  status: 'complete',
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
