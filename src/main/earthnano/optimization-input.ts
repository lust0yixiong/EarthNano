import type { PersistedChatSession } from '../../shared/session-persistence'
import { createHash } from 'node:crypto'
import {
  normalizeOptimizationArtifactInputs,
  type OptimizationArtifactInput
} from '../../shared/earthnano/optimization-input'
import type { ManagedFileVersionReadPort } from '../managed-file-versions/read-port'

/** Freeze through the original version lease. This grants no workspace or arbitrary file access. */
export async function resolveOptimizationArtifactInputs(options: {
  projectId: string
  sourceSessionId: string
  artifacts: OptimizationArtifactInput[]
  files: Array<{ path: string; content: string }>
  loadSession(): Promise<PersistedChatSession>
  versions: Pick<ManagedFileVersionReadPort, 'openVersion'>
}): Promise<Array<{ path: string; content: string }>> {
  const references = normalizeOptimizationArtifactInputs(options.artifacts)!
  const session = await options.loadSession()
  if (
    session.projectId !== options.projectId ||
    session.id !== options.sourceSessionId ||
    session.archivedAt ||
    session.packageOrigin
  )
    throw new Error('Optimization source Session unavailable')
  const files = structuredClone(options.files)
  const paths = new Set(files.map((file) => file.path.normalize('NFC').toLowerCase()))
  let size = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0)
  if (files.length + references.length > 32 || size > 128_000)
    throw new Error('Optimization inputs exceed the text profile limit')
  for (const reference of references) {
    const key = reference.path.normalize('NFC').toLowerCase()
    if (
      [...paths].some(
        (path) => path === key || path.startsWith(key + '/') || key.startsWith(path + '/')
      )
    )
      throw new Error('Optimization inputs collide')
    const attached = session.artifacts?.find(
      (file) =>
        file.artifactId === reference.artifactId &&
        file.versionId === reference.versionId &&
        file.sha256 === reference.checksum
    )
    if (!attached) throw new Error('Optimization input is not a fixed artifact in this Session')
    const lease = await options.versions.openVersion(
      { source: 'artifact', projectId: options.projectId, fileId: reference.artifactId },
      reference.versionId
    )
    try {
      if (
        lease.logicalFile.projectId !== options.projectId ||
        lease.logicalFile.sessionId !== options.sourceSessionId ||
        lease.logicalFile.id !== reference.artifactId ||
        lease.version.id !== reference.versionId ||
        lease.version.checksum !== reference.checksum ||
        lease.size > 64_000 ||
        size + lease.size > 128_000
      )
        throw new Error('Optimization source version or text profile mismatch')
      const bytes = await lease.readRange(0, lease.size)
      await lease.verifyUnchanged()
      if (
        bytes.byteLength !== lease.size ||
        createHash('sha256').update(bytes).digest('hex') !== reference.checksum
      )
        throw new Error('Optimization source content changed')
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      if (content.includes('\0')) throw new Error('Optimization input is not text')
      size += bytes.byteLength
      files.push({ path: reference.path, content })
      paths.add(key)
    } finally {
      await lease.close()
    }
  }
  return files
}
