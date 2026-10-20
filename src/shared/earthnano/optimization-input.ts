/** A user-selected immutable version in the source Session; never a host path or latest alias. */
export interface OptimizationArtifactInput {
  artifactId: string
  versionId: string
  checksum: string
  path: string
}

export const isOptimizationTextPath = (path: string): boolean =>
  path.length <= 180 &&
  /\.(txt|md|csv|tsv|json|ya?ml|log)$/i.test(path) &&
  path
    .split('/')
    .every(
      (part) =>
        /^[A-Za-z0-9_. -]+$/.test(part) &&
        part !== '.' &&
        part !== '..' &&
        !/[. ]$/.test(part) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )

export function normalizeOptimizationArtifactInputs(
  value: unknown
): OptimizationArtifactInput[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid optimization versions')
  const seen = new Set<string>()
  return value.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !== 'artifactId,checksum,path,versionId' ||
      ![entry.artifactId, entry.versionId].every(
        (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(id)
      ) ||
      typeof entry.checksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.checksum) ||
      typeof entry.path !== 'string' ||
      !isOptimizationTextPath(entry.path)
    )
      throw new Error('Invalid optimization version reference')
    const key = entry.path.normalize('NFC').toLowerCase()
    if (seen.has(key)) throw new Error('Duplicate optimization input path')
    seen.add(key)
    return {
      artifactId: entry.artifactId,
      versionId: entry.versionId,
      checksum: entry.checksum,
      path: entry.path
    }
  })
}
