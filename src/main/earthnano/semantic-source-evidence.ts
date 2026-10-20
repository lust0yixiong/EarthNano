import { createHash } from 'node:crypto'
import type { FrozenNotebookInput } from '../../shared/earthnano/notebook-profile'
import { normalizeFrozenNotebookInputs } from '../../shared/earthnano/notebook-profile'
import type { ManagedFileVersionReadPort } from '../managed-file-versions/read-port'
import { originalEvidenceCanonical, originalEvidenceDigest } from './original-turn-evidence'

export type SemanticSourceEntry = {
  input: FrozenNotebookInput
} & (
  | { status: 'available'; content: string; digest: string }
  | { status: 'unavailable'; reason: 'binary-or-invalid-utf8' | 'per-file-limit' | 'total-limit' }
)
export interface SemanticSourceEvidence {
  schemaVersion: 1
  profile: 'bounded-utf8-v1'
  inputs: SemanticSourceEntry[]
  digest: string
}

/** Host-only reader. The caller must authorize these exact frozen identities against the target's
 * TaskSnapshot before calling; no model-facing raw-source capability is created here. */
export async function readSemanticSourceVersions(options: {
  versions: Pick<ManagedFileVersionReadPort, 'openVersion'>
  projectId: string
  inputs: readonly FrozenNotebookInput[]
  signal?: AbortSignal
}): Promise<SemanticSourceEvidence> {
  const inputs = normalizeFrozenNotebookInputs(options.inputs)
  const entries: SemanticSourceEntry[] = []
  let retained = 0
  for (const input of inputs) {
    options.signal?.throwIfAborted()
    if (input.sourceProjectId !== options.projectId)
      throw new Error('Foreign semantic source Project')
    const lease = await options.versions.openVersion(
      {
        source: input.sourceKind === 'upload-version' ? 'upload' : 'artifact',
        projectId: options.projectId,
        fileId: input.sourceFileId
      },
      input.inputFileVersionId
    )
    try {
      if (
        lease.logicalFile.source !==
          (input.sourceKind === 'upload-version' ? 'upload' : 'artifact') ||
        lease.version.fileId !== input.sourceFileId ||
        lease.logicalFile.projectId !== input.sourceProjectId ||
        lease.logicalFile.sessionId !== input.sourceSessionId ||
        lease.logicalFile.id !== input.sourceFileId ||
        lease.version.id !== input.inputFileVersionId ||
        lease.version.filename !== input.filename ||
        lease.size !== input.sizeBytes ||
        lease.version.checksum !== input.checksum
      )
        throw new Error('Semantic source differs from frozen Version')
      const reason =
        lease.size > 1024 * 1024
          ? ('per-file-limit' as const)
          : retained + lease.size > 4 * 1024 * 1024
            ? ('total-limit' as const)
            : undefined
      // Verify the entire immutable source even when it cannot be represented as bounded text.
      const hash = createHash('sha256')
      const chunks: Uint8Array[] = []
      for (let offset = 0; offset < lease.size; offset += 64 * 1024) {
        options.signal?.throwIfAborted()
        const end = Math.min(lease.size, offset + 64 * 1024)
        const bytes = await lease.readRange(offset, end)
        if (bytes.length !== end - offset) throw new Error('Incomplete semantic source read')
        hash.update(bytes)
        if (!reason) chunks.push(bytes)
      }
      options.signal?.throwIfAborted()
      await lease.verifyUnchanged()
      if (hash.digest('hex') !== input.checksum) throw new Error('Semantic source bytes changed')
      if (reason) entries.push({ input, status: 'unavailable', reason })
      else {
        const bytes = Buffer.concat(chunks)
        const contentType = lease.version.contentType?.split(';')[0].toLowerCase()
        const binaryType = Boolean(
          contentType &&
          (/^(image|audio|video)\//.test(contentType) ||
            [
              'application/pdf',
              'application/zip',
              'application/gzip',
              'application/x-tar',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            ].includes(contentType))
        )
        let content: string | undefined
        try {
          content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
          for (const character of content) {
            const point = character.codePointAt(0)!
            if ((point < 32 && ![9, 10, 13].includes(point)) || point === 127) {
              content = undefined
              break
            }
          }
        } catch {
          /* Binary source is explicitly unavailable, never replacement-decoded. */
        }
        if (binaryType) content = undefined
        if (content === undefined)
          entries.push({ input, status: 'unavailable', reason: 'binary-or-invalid-utf8' })
        else {
          retained += bytes.length
          entries.push({
            input,
            status: 'available',
            content,
            digest: originalEvidenceDigest(bytes)
          })
        }
      }
    } finally {
      await lease.close()
    }
  }
  options.signal?.throwIfAborted()
  const manifest = {
    schemaVersion: 1 as const,
    profile: 'bounded-utf8-v1' as const,
    inputs: entries
  }
  return { ...manifest, digest: originalEvidenceDigest(originalEvidenceCanonical(manifest)) }
}
