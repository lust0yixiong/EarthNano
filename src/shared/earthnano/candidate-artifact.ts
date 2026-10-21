import type { ArtifactReference } from './execution-port'

/** The original UTF-8 export shape. No discriminator or metadata is added to old text entries. */
export interface CandidateTextArtifactFile {
  path: string
  content: string
  digest: string
  artifactRef: ArtifactReference
}

/** Metadata only. Bytes remain exclusively with the original immutable ArtifactVersion owner. */
export interface CandidateBinaryArtifactFile {
  path: string
  representation: 'binary'
  sizeBytes: number
  contentType?: string
  digest: string
  artifactRef: ArtifactReference
}

export type CandidateArtifactFile = CandidateTextArtifactFile | CandidateBinaryArtifactFile

const fail = (): never => {
  throw new Error('Invalid candidate artifact projection')
}
const plain = (value: unknown): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail()
  return value as Record<string, unknown>
}
const text = (value: unknown, limit: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) return fail()
  for (const character of value) {
    const point = character.codePointAt(0)!
    if (point < 32 || point === 127 || (point >= 0xd800 && point <= 0xdfff)) return fail()
  }
  return value
}

/** Validates wire shape and reference consistency only. The original owner must still authorize
 * the exact target/Version, apply its path/resource rules and verify the complete immutable bytes.
 * This function never reads a path or grants access to an ArtifactReference. */
export function normalizeCandidateArtifactFile(value: unknown): CandidateArtifactFile {
  const entry = plain(value)
  const binary = entry.representation === 'binary'
  const required = binary
    ? ['path', 'representation', 'sizeBytes', 'digest', 'artifactRef']
    : ['path', 'content', 'digest', 'artifactRef']
  const optional = binary ? ['contentType'] : []
  if (
    required.some((key) => !Object.hasOwn(entry, key)) ||
    Object.keys(entry).some((key) => !required.includes(key) && !optional.includes(key))
  )
    return fail()
  const reference = plain(entry.artifactRef)
  if (Object.keys(reference).sort().join(',') !== 'artifactId,checksum,versionId') return fail()
  const checksum = reference.checksum
  if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum)) return fail()
  if (entry.digest !== `sha256:${checksum}`) return fail()
  const artifactRef: ArtifactReference = {
    artifactId: text(reference.artifactId, 256),
    versionId: text(reference.versionId, 256),
    checksum
  }
  const path = text(entry.path, 4096)
  if (!binary) {
    if (typeof entry.content !== 'string') return fail()
    return { path, content: entry.content, digest: entry.digest, artifactRef }
  }
  if (!Number.isSafeInteger(entry.sizeBytes) || (entry.sizeBytes as number) < 0) return fail()
  return {
    path,
    representation: 'binary',
    sizeBytes: entry.sizeBytes as number,
    ...(Object.hasOwn(entry, 'contentType') ? { contentType: text(entry.contentType, 256) } : {}),
    digest: entry.digest,
    artifactRef
  }
}
