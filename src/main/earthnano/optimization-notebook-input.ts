import { createHash } from 'node:crypto'
import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { NotebookOptimizationSource } from '../../shared/earthnano/notebook-source'
import {
  normalizeFrozenNotebookInputs,
  type FrozenNotebookInput
} from '../../shared/earthnano/notebook-profile'
import type { ManagedFileVersionReadPort } from '../managed-file-versions/read-port'

/** Main checks original message authority; the original Notebook registry later stages exact versions.
 * No latest lookup, new upload publication, inline binary copy or arbitrary path authorization. */
export async function resolveOptimizationNotebookInputs(options: {
  projectId: string
  sourceSessionId: string
  source: NotebookOptimizationSource
  prompt: string
  loadSession(): Promise<PersistedChatSession>
  versions: Pick<ManagedFileVersionReadPort, 'openVersion'>
  signal?: AbortSignal
}): Promise<FrozenNotebookInput[]> {
  options.signal?.throwIfAborted()
  const session = await options.loadSession()
  if (
    session.projectId !== options.projectId ||
    session.id !== options.sourceSessionId ||
    session.archivedAt ||
    session.packageOrigin
  )
    throw new Error('Notebook source Session unavailable')
  const messages = session.conversationGraph
    ? resolveActiveConversationMessages(session.conversationGraph)
    : session.messages
  const message = messages.find((entry) => entry.id === options.source.promptMessageId)
  if (
    !message ||
    message.role !== 'user' ||
    message.status !== 'complete' ||
    message.content !== options.prompt ||
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
    throw new Error('Notebook optimization requires an exact supported source task')
  const expected: Array<{
    source: 'upload' | 'artifact'
    fileId: string
    versionId: string
    checksum?: string
    sessionId?: string
    name: string
    size?: number
  }> = []
  for (const upload of message.uploads ?? []) {
    if (!upload.id || !upload.versionId || !upload.sha256 || upload.sessionId !== session.id)
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
  if (!expected.length || expected.length > 32)
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
  const inputs: FrozenNotebookInput[] = []
  for (const reference of unique) {
    options.signal?.throwIfAborted()
    const lease = await options.versions.openVersion(
      { source: reference.source, projectId: options.projectId, fileId: reference.fileId },
      reference.versionId
    )
    try {
      if (
        lease.logicalFile.projectId !== options.projectId ||
        lease.logicalFile.source !== reference.source ||
        lease.logicalFile.id !== reference.fileId ||
        lease.version.id !== reference.versionId ||
        (reference.sessionId !== undefined &&
          lease.logicalFile.sessionId !== reference.sessionId) ||
        (reference.checksum !== undefined && lease.version.checksum !== reference.checksum) ||
        lease.version.filename !== reference.name ||
        (reference.size !== undefined && lease.size !== reference.size) ||
        !Number.isSafeInteger(lease.size) ||
        lease.size < 0
      )
        throw new Error('Notebook source version identity mismatch')
      const hash = createHash('sha256')
      for (let offset = 0; offset < lease.size; offset += 1024 * 1024) {
        options.signal?.throwIfAborted()
        const end = Math.min(offset + 1024 * 1024, lease.size)
        const bytes = await lease.readRange(offset, end)
        if (bytes.byteLength !== end - offset) throw new Error('Notebook source read incomplete')
        hash.update(bytes)
      }
      await lease.verifyUnchanged()
      if (hash.digest('hex') !== lease.version.checksum)
        throw new Error('Notebook source bytes changed')
      inputs.push({
        sourceKind: reference.source === 'upload' ? 'upload-version' : 'artifact-version',
        sourceProjectId: options.projectId,
        sourceSessionId: lease.logicalFile.sessionId,
        sourceFileId: reference.fileId,
        inputFileVersionId: reference.versionId,
        filename: lease.version.filename,
        sizeBytes: lease.size,
        checksum: lease.version.checksum
      })
    } finally {
      await lease.close()
    }
  }
  options.signal?.throwIfAborted()
  return normalizeFrozenNotebookInputs([
    ...new Map(
      inputs.map((input) => [input.sourceKind + ':' + input.inputFileVersionId, input])
    ).values()
  ])
}
