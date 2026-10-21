import type { NotebookLanguage } from '../notebook-language-contract'
import { resolveActiveConversationMessages } from '../conversation-graph'
import type { PersistedChatMessage, PersistedChatSession } from '../session-persistence'

/** A source-message identity, never renderer-supplied paths, inputs or runtime authority. */
export interface NotebookOptimizationSource {
  promptMessageId: string
  /** Absent only on compatible Python requests; never infer language from prompt text. */
  language?: NotebookLanguage
}
export function normalizeNotebookOptimizationSource(
  value: unknown
): NotebookOptimizationSource | undefined {
  if (value === undefined) return undefined
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['promptMessageId', 'language'].includes(key)) ||
    (Object.hasOwn(value, 'language') &&
      !['python', 'r'].includes((value as NotebookOptimizationSource).language as string)) ||
    !Object.hasOwn(value, 'promptMessageId') ||
    typeof (value as NotebookOptimizationSource).promptMessageId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test((value as NotebookOptimizationSource).promptMessageId)
  )
    throw new Error('Invalid Notebook source message')
  const source = value as NotebookOptimizationSource
  return {
    promptMessageId: source.promptMessageId,
    ...(Object.hasOwn(source, 'language') ? { language: source.language } : {})
  }
}

/** Read the legacy default without adding a field to old request/snapshot identities. */
export function notebookOptimizationLanguage(source: NotebookOptimizationSource): NotebookLanguage {
  return source.language ?? 'python'
}

/** Exact source-message metadata rule shared by the picker and Main. Version bytes and runtime
 * authority remain with the original Main owners; this predicate grants no file access. */
export function isSupportedNotebookOptimizationMessage(
  message: PersistedChatMessage | undefined
): message is PersistedChatMessage {
  return !(
    !message ||
    message.role !== 'user' ||
    message.status !== 'complete' ||
    message.images?.length ||
    message.annotations?.length ||
    message.pdfContext ||
    message.structuredOutputEvidence ||
    message.structuredOutputEvidenceInvalid ||
    message.attribution ||
    message.delegatedTask ||
    message.turnIntent ||
    message.relayedFrom ||
    message.delegatedCallerSource ||
    message.delegatedInputVersionIds?.length ||
    message.parts?.some((part) => part.type !== 'text' && part.type !== 'artifact')
  )
}

/** Original fixed-reference parsing, before original ManagedFileVersion reads and byte checks. */
interface NotebookSourceReference {
  source: 'upload' | 'artifact'
  fileId: string
  versionId: string
  checksum?: string
  sessionId?: string
  name: string
  size?: number
}
export function notebookOptimizationSourceReferences(
  message: PersistedChatMessage,
  sourceSessionId: string,
  options: { allowEmpty?: boolean } = {}
): NotebookSourceReference[] {
  const expected: NotebookSourceReference[] = []
  for (const upload of message.uploads ?? []) {
    if (!upload.id || !upload.versionId || !upload.sha256 || upload.sessionId !== sourceSessionId)
      throw new Error('Notebook source upload has no fixed authority')
    expected.push({
      source: 'upload',
      fileId: upload.id,
      versionId: upload.versionId,
      checksum: upload.sha256,
      sessionId: upload.sessionId,
      name: upload.name,
      size: upload.size
    })
  }
  for (const reference of message.parts ?? []) {
    if (reference.type !== 'artifact') continue
    if (
      (reference.source !== 'upload' && reference.source !== 'artifact') ||
      !reference.sourceFileId ||
      !reference.versionId
    )
      throw new Error('Notebook source reference has no fixed authority')
    expected.push({
      source: reference.source,
      fileId: reference.sourceFileId,
      versionId: reference.versionId,
      checksum: reference.checksum,
      name: reference.name
    })
  }
  if ((!expected.length && !options.allowEmpty) || expected.length > 32)
    throw new Error('Notebook source inputs unavailable')
  const unique = [
    ...new Map(
      expected.map((entry) => [
        JSON.stringify([entry.source, entry.fileId, entry.versionId]),
        entry
      ])
    ).values()
  ]
  if (unique.length > 10) throw new Error('Notebook task exceeds the original attachment limit')
  return unique
}

/** Current active branch only; unreadable metadata is an unavailable picker option. */
export function notebookOptimizationSourceMessages(
  session: PersistedChatSession
): PersistedChatSession['messages'] {
  const messages = session.conversationGraph
    ? resolveActiveConversationMessages(session.conversationGraph)
    : session.messages
  return messages.filter((message) => {
    if (!isSupportedNotebookOptimizationMessage(message)) return false
    try {
      notebookOptimizationSourceReferences(message, session.id)
      return true
    } catch {
      return false
    }
  })
}
