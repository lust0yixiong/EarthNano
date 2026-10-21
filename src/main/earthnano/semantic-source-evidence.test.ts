import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ManagedFileReadLease } from '../managed-file-versions/read-port'
import type { FrozenNotebookInput } from '../../shared/earthnano/notebook-profile'
import { readSemanticSourceVersions } from './semantic-source-evidence'

function setup(
  bytes: Buffer,
  count = 1
): {
  inputs: FrozenNotebookInput[]
  leases: ManagedFileReadLease[]
  versions: {
    openVersion: ReturnType<
      typeof vi.fn<
        (identity: { fileId: string }, versionId: string) => Promise<ManagedFileReadLease>
      >
    >
  }
} {
  const inputs: FrozenNotebookInput[] = Array.from({ length: count }, (_, i) => ({
    sourceKind: 'upload-version',
    sourceProjectId: 'p',
    sourceSessionId: 's',
    sourceFileId: `f${i}`,
    inputFileVersionId: `v${i}`,
    filename: `file${i}.csv`,
    sizeBytes: bytes.length,
    checksum: createHash('sha256').update(bytes).digest('hex')
  }))
  const leases: ManagedFileReadLease[] = []
  const versions = {
    openVersion: vi.fn(async (identity, versionId) => {
      const input = inputs.find((entry) => entry.inputFileVersionId === versionId)!
      const lease = {
        logicalFile: { source: 'upload', id: identity.fileId, projectId: 'p', sessionId: 's' },
        version: {
          id: versionId,
          fileId: identity.fileId,
          filename: input.filename,
          checksum: input.checksum
        },
        size: bytes.length,
        readRange: vi.fn(async (begin, end) => bytes.subarray(begin, end)),
        verifyUnchanged: vi.fn(async () => {}),
        close: vi.fn(async () => {})
      } as unknown as ManagedFileReadLease
      leases.push(lease)
      return lease
    })
  }
  return { inputs, leases, versions }
}
describe('controlled independent source evidence', () => {
  it('represents an explicitly empty Compute input set without changing the Notebook default', async () => {
    const f = setup(Buffer.alloc(0), 0)
    const result = await readSemanticSourceVersions({ ...f, projectId: 'p', allowEmpty: true })
    expect(result).toMatchObject({ schemaVersion: 1, profile: 'bounded-utf8-v1', inputs: [] })
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    await expect(readSemanticSourceVersions({ ...f, projectId: 'p' })).rejects.toThrow()
    expect(f.versions.openVersion).not.toHaveBeenCalled()
  })

  it('preserves exact UTF8 including BOM and rejects cross-project authority', async () => {
    const f = setup(Buffer.from('\ufeffcolumn\r\n一\r\n'))
    const result = await readSemanticSourceVersions({ ...f, projectId: 'p' })
    expect(result.inputs[0]).toMatchObject({
      status: 'available',
      content: '\ufeffcolumn\r\n一\r\n',
      digest: `sha256:${f.inputs[0].checksum}`
    })
    expect(f.leases[0].close).toHaveBeenCalledOnce()
    await expect(readSemanticSourceVersions({ ...f, projectId: 'foreign' })).rejects.toThrow(
      'Foreign'
    )
    expect(f.versions.openVersion).toHaveBeenCalledOnce()
  })
  it('marks binary data unavailable without replacement-decoding', async () => {
    const f = setup(Buffer.from([0xff, 0, 1]))
    expect((await readSemanticSourceVersions({ ...f, projectId: 'p' })).inputs[0]).toMatchObject({
      status: 'unavailable',
      reason: 'binary-or-invalid-utf8'
    })
  })
  it('does not label a binary format complete merely because its bytes happen to be ASCII', async () => {
    const f = setup(Buffer.from('%PDF-1.4 ASCII-only container'))
    const open = f.versions.openVersion.getMockImplementation()!
    f.versions.openVersion.mockImplementation(async (...args) => {
      const lease = await open(...args)
      lease.version.contentType = 'application/pdf'
      return lease
    })
    expect((await readSemanticSourceVersions({ ...f, projectId: 'p' })).inputs[0]).toMatchObject({
      status: 'unavailable',
      reason: 'binary-or-invalid-utf8'
    })
  })

  it('streams full oversized source integrity without retaining a truncated body', async () => {
    const f = setup(Buffer.alloc(1024 * 1024 + 1, 65))
    const result = await readSemanticSourceVersions({ ...f, projectId: 'p' })
    expect(result.inputs[0]).toEqual({
      input: f.inputs[0],
      status: 'unavailable',
      reason: 'per-file-limit'
    })
    expect(f.leases[0].readRange).toHaveBeenCalledTimes(17)
    expect(f.leases[0].readRange).toHaveBeenLastCalledWith(1024 * 1024, 1024 * 1024 + 1)
    expect(f.leases[0].close).toHaveBeenCalledOnce()
  })
  it('represents total-limit evidence explicitly and deterministically', async () => {
    const f = setup(Buffer.alloc(1024 * 1024, 65), 5)
    const result = await readSemanticSourceVersions({ ...f, projectId: 'p' })
    expect(result.inputs.slice(0, 4).every((entry) => entry.status === 'available')).toBe(true)
    expect(result.inputs[4]).toMatchObject({ status: 'unavailable', reason: 'total-limit' })
    expect(await readSemanticSourceVersions({ ...f, projectId: 'p' })).toEqual(result)
  })
  it('closes original leases on content tampering and cancellation during read', async () => {
    const f = setup(Buffer.from('safe'))
    f.inputs[0] = { ...f.inputs[0], checksum: 'a'.repeat(64) }
    await expect(readSemanticSourceVersions({ ...f, projectId: 'p' })).rejects.toThrow(
      'bytes changed'
    )
    expect(f.leases[0].close).toHaveBeenCalledOnce()
    const g = setup(Buffer.alloc(128 * 1024, 65)),
      controller = new AbortController()
    const open = g.versions.openVersion.getMockImplementation()!
    g.versions.openVersion.mockImplementation(async (...args) => {
      const lease = await open(...args)
      vi.mocked(lease.readRange).mockImplementation(async (begin, end) => {
        controller.abort()
        return Buffer.alloc(end - begin, 65)
      })
      return lease
    })
    await expect(
      readSemanticSourceVersions({ ...g, projectId: 'p', signal: controller.signal })
    ).rejects.toThrow()
    expect(g.leases[0].readRange).toHaveBeenCalledOnce()
    expect(g.leases[0].close).toHaveBeenCalledOnce()
  })
})
