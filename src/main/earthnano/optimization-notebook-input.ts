import type { NotebookLanguage } from '../../shared/notebook-language-contract'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import { createHash } from 'node:crypto'
import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  isSupportedNotebookOptimizationMessage,
  notebookOptimizationSourceReferences,
  type NotebookOptimizationSource
} from '../../shared/earthnano/notebook-source'
import {
  normalizeFrozenNotebookInputs,
  normalizeFrozenManagedInputs,
  normalizeFrozenNotebookRuntime,
  type FrozenNotebookRuntime,
  type FrozenNotebookInput
} from '../../shared/earthnano/notebook-profile'
import type { ManagedFileVersionReadPort } from '../managed-file-versions/read-port'

interface OptimizationSourceInputOptions {
  projectId: string
  sourceSessionId: string
  source: NotebookOptimizationSource
  prompt: string
  loadSession(): Promise<PersistedChatSession>
  versions: Pick<ManagedFileVersionReadPort, 'openVersion'>
  signal?: AbortSignal
}

/** Python/R retain the original nonempty attachment and runtime requirements. */
export async function resolveOptimizationNotebookInputs(
  options: OptimizationSourceInputOptions
): Promise<FrozenNotebookInput[]> {
  return resolveOptimizationSourceInputs(options, false)
}

/** Compute may use no input files; every supplied reference uses the same original Version lease. */
export async function resolveOptimizationComputeInputs(
  options: OptimizationSourceInputOptions
): Promise<FrozenNotebookInput[]> {
  return resolveOptimizationSourceInputs(options, true)
}

/** Main checks original message authority; the original Notebook registry later stages exact versions.
 * No latest lookup, new upload publication, inline binary copy or arbitrary path authorization. */
async function resolveOptimizationSourceInputs(
  options: OptimizationSourceInputOptions,
  allowEmpty: boolean
): Promise<FrozenNotebookInput[]> {
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
  if (!isSupportedNotebookOptimizationMessage(message) || message.content !== options.prompt)
    throw new Error('Notebook optimization requires an exact supported source task')
  const unique = notebookOptimizationSourceReferences(message, session.id, { allowEmpty })
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
  const normalizeInputs = allowEmpty ? normalizeFrozenManagedInputs : normalizeFrozenNotebookInputs
  return normalizeInputs([
    ...new Map(
      inputs.map((input) => [input.sourceKind + ':' + input.inputFileVersionId, input])
    ).values()
  ])
}

/** Common original runtime resolution for legacy and catalog starts. Callers must first authorize
 * the source Session. An unavailable exact language binding never falls back to another target. */
export async function resolveOptimizationNotebookRuntime(options: {
  service: Pick<NotebookRuntimeService, 'listRuntimes'>
  projectId: string
  source: Pick<PersistedChatSession, 'id' | 'cwd'>
  language: NotebookLanguage
  signal?: AbortSignal
}): Promise<FrozenNotebookRuntime | undefined> {
  options.signal?.throwIfAborted()
  const listing = await options.service.listRuntimes({
    projectId: options.projectId,
    sessionId: options.source.id,
    workspaceCwd: options.source.cwd ?? ''
  })
  options.signal?.throwIfAborted()
  const bound = listing.bindings[options.language]
  if (
    !bound ||
    bound.language !== options.language ||
    (bound.status ?? 'active') !== 'active' ||
    !listing.runtimes.some(
      (runtime) =>
        runtime.language === options.language &&
        runtime.runtimeId === bound.runtimeId &&
        runtime.runnable &&
        (runtime.status ?? 'active') === 'active'
    )
  )
    return undefined
  return normalizeFrozenNotebookRuntime({
    language: bound.language,
    runtimeId: bound.runtimeId,
    source: bound.source,
    provenance: bound.provenance,
    interpreterPath: bound.interpreterPath,
    ...(bound.version ? { version: bound.version } : {})
  })
}
