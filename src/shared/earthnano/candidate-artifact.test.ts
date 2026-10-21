import { createHash } from 'node:crypto'
import { expect, expectTypeOf, it } from 'vitest'
import type { PersistentCandidateFile } from '../../main/earthnano/persistent-candidate-owner'
import {
  normalizeCandidateArtifactFile,
  type CandidateTextArtifactFile,
  type CandidateBinaryArtifactFile
} from './candidate-artifact'

const checksum = createHash('sha256').update('{"count":3}\n').digest('hex')
const artifactRef = { artifactId: 'artifact', versionId: 'version-1', checksum }
const original = {
  path: 'research-results.json',
  content: '{"count":3}\n',
  digest: `sha256:${checksum}`,
  artifactRef
}
const binaryBytes = Buffer.from([0x89, 0, 0xff, 0x80])
const binaryChecksum = createHash('sha256').update(binaryBytes).digest('hex')
const binary = {
  path: 'data.bin',
  representation: 'binary' as const,
  sizeBytes: binaryBytes.length,
  contentType: 'application/octet-stream',
  digest: `sha256:${binaryChecksum}`,
  artifactRef: {
    artifactId: 'binary-artifact',
    versionId: 'binary-version',
    checksum: binaryChecksum
  }
}

it('preserves the original UTF-8 owner export type, JSON bytes and exact Version reference', () => {
  expectTypeOf<
    Extract<PersistentCandidateFile, { content: string }>
  >().toEqualTypeOf<CandidateTextArtifactFile>()
  const normalized = normalizeCandidateArtifactFile(original)
  expect(normalized).toStrictEqual(original)
  expect(JSON.stringify(normalized)).toBe(JSON.stringify(original))
  expect(normalized).not.toHaveProperty('representation')
  expect(normalized).not.toHaveProperty('sizeBytes')
  expect(normalized.artifactRef).not.toBe(artifactRef)
})

it('retains binary identity and original Version metadata without pretending to export bytes', () => {
  expectTypeOf<CandidateBinaryArtifactFile>().not.toHaveProperty('content')
  const normalized = normalizeCandidateArtifactFile(binary)
  expect(normalized).toStrictEqual(binary)
  expect(normalized).not.toHaveProperty('content')
  expect(normalized).not.toHaveProperty('bytes')
  expect(normalized.artifactRef).toStrictEqual(binary.artifactRef)
  const emptyChecksum = createHash('sha256').update('').digest('hex')
  const empty = {
    ...binary,
    sizeBytes: 0,
    digest: `sha256:${emptyChecksum}`,
    artifactRef: { ...binary.artifactRef, versionId: 'empty-version', checksum: emptyChecksum }
  }
  delete (empty as { contentType?: string }).contentType
  expect(normalizeCandidateArtifactFile(empty)).toStrictEqual(empty)
})

it('rejects fake binary text, embedded bytes and additional authority fields', () => {
  for (const extra of [
    { content: 'replacement decoded data' },
    { bytes: [137, 80, 78, 71] },
    { base64: 'iVBORw==' },
    { hostPath: '/private/original/figure.png' },
    { projectId: 'foreign' },
    { producerRunId: 'invented' }
  ])
    expect(() => normalizeCandidateArtifactFile({ ...binary, ...extra })).toThrow()
  expect(() => normalizeCandidateArtifactFile({ ...original, representation: 'text' })).toThrow()
  expect(() => normalizeCandidateArtifactFile({ ...original, representation: 'binary' })).toThrow()
})

it('rejects inconsistent Version references and malformed binary metadata', () => {
  for (const sizeBytes of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '70', null])
    expect(() => normalizeCandidateArtifactFile({ ...binary, sizeBytes })).toThrow()
  for (const contentType of ['', null, undefined, 'image/png\nforged'])
    expect(() => normalizeCandidateArtifactFile({ ...binary, contentType })).toThrow()
  for (const digest of ['a'.repeat(64), `sha256:${'b'.repeat(64)}`, undefined])
    expect(() => normalizeCandidateArtifactFile({ ...binary, digest })).toThrow()
  expect(() =>
    normalizeCandidateArtifactFile({
      ...binary,
      artifactRef: { ...artifactRef, projectId: 'foreign' }
    })
  ).toThrow()
  for (const value of [null, [], Object.create({ ...binary })])
    expect(() => normalizeCandidateArtifactFile(value)).toThrow()
})
