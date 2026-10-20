import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ManagedFileReadLease } from '../managed-file-versions/read-port'
import { normalizeOptimizationArtifactInputs } from '../../shared/earthnano/optimization-input'
import { resolveOptimizationArtifactInputs } from './optimization-input'

const bytes = Buffer.from('{"count":3,"sum":12,"mean":4}\n')
const ref = {
  artifactId: 'artifact',
  versionId: 'version-1',
  checksum: createHash('sha256').update(bytes).digest('hex'),
  path: 'research.json'
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- retain fixture mocks
const fixture = () => {
  const lease = {
    logicalFile: { projectId: 'project', sessionId: 'session', id: ref.artifactId },
    version: { id: ref.versionId, checksum: ref.checksum },
    size: bytes.length,
    readRange: vi.fn(async () => bytes),
    verifyUnchanged: vi.fn(async () => {}),
    close: vi.fn(async () => {})
  } as unknown as ManagedFileReadLease
  const options = {
    projectId: 'project',
    sourceSessionId: 'session',
    artifacts: [ref],
    files: [] as Array<{ path: string; content: string }>,
    loadSession: vi.fn(
      async () =>
        ({
          id: 'session',
          projectId: 'project',
          artifacts: [
            { artifactId: ref.artifactId, versionId: ref.versionId, sha256: ref.checksum }
          ]
        }) as PersistedChatSession
    ),
    versions: { openVersion: vi.fn(async () => lease) }
  }
  return { options, lease }
}
it('freezes exact original version bytes and closes the lease without requesting a latest version or host path', async () => {
  const { options, lease } = fixture()
  expect(await resolveOptimizationArtifactInputs(options)).toEqual([
    { path: ref.path, content: bytes.toString('utf8') }
  ])
  expect(options.versions.openVersion).toHaveBeenCalledExactlyOnceWith(
    { source: 'artifact', projectId: 'project', fileId: 'artifact' },
    'version-1'
  )
  expect(lease.verifyUnchanged).toHaveBeenCalledOnce()
  expect(lease.close).toHaveBeenCalledOnce()
})
it('rejects foreign Session/version and forged checksums before opening content', async () => {
  for (const override of [
    { versionId: 'version-2' },
    { artifactId: 'foreign' },
    { checksum: 'f'.repeat(64) }
  ]) {
    const { options } = fixture()
    options.artifacts = [{ ...ref, ...override }]
    await expect(resolveOptimizationArtifactInputs(options)).rejects.toThrow('fixed artifact')
    expect(options.versions.openVersion).not.toHaveBeenCalled()
  }
  const { options } = fixture()
  options.sourceSessionId = 'other-session'
  await expect(resolveOptimizationArtifactInputs(options)).rejects.toThrow('Session unavailable')
})
it('retains the original version when a later version is attached to the same Session', async () => {
  const { options } = fixture()
  const session = await options.loadSession()
  session.artifacts!.push({
    id: 'new',
    kind: 'managed-file',
    path: 'ignored',
    artifactId: ref.artifactId,
    versionId: 'version-2',
    sha256: 'f'.repeat(64)
  })
  options.loadSession.mockResolvedValue(session)
  expect((await resolveOptimizationArtifactInputs(options))[0].content).toBe(bytes.toString())
  expect(options.versions.openVersion.mock.calls[0]).toEqual([
    { source: 'artifact', projectId: 'project', fileId: 'artifact' },
    'version-1'
  ])
})
it('rejects a lease from another Session, corruption, truncation or unknown integrity and always releases it', async () => {
  for (const attack of ['owner', 'changed', 'corrupt', 'short', 'oversized'] as const) {
    const { options, lease } = fixture()
    if (attack === 'owner') lease.logicalFile.sessionId = 'other'
    if (attack === 'changed')
      vi.mocked(lease.verifyUnchanged).mockRejectedValue(new Error('Changed'))
    if (attack === 'corrupt')
      vi.mocked(lease.readRange).mockResolvedValue(Buffer.alloc(bytes.length))
    if (attack === 'short') vi.mocked(lease.readRange).mockResolvedValue(bytes.subarray(1))
    if (attack === 'oversized') lease.size = 64_001
    await expect(resolveOptimizationArtifactInputs(options)).rejects.toThrow()
    expect(lease.close).toHaveBeenCalledOnce()
  }
})
it('combines raw and referenced inputs under one count/size/path profile', async () => {
  for (const files of [
    [{ path: 'RESEARCH.json', content: 'x' }],
    [{ path: 'research.json/nested.txt', content: 'x' }],
    Array.from({ length: 32 }, (_, index) => ({ path: `${index}.txt`, content: 'x' })),
    [{ path: 'raw.txt', content: 'x'.repeat(128_000) }]
  ]) {
    const { options } = fixture()
    options.files = files
    await expect(resolveOptimizationArtifactInputs(options)).rejects.toThrow()
  }
})
it.each(['../outside.txt', '/host/key.md', 'a\\b.txt', 'CON.json', 'result.exe'])(
  'rejects unsupported reference path %s at the shared DTO boundary',
  (path) => {
    expect(() => normalizeOptimizationArtifactInputs([{ ...ref, path }])).toThrow()
  }
)
it('rejects binary NUL and invalid UTF8 even when original bytes and checksum agree', async () => {
  for (const content of [Buffer.from([0, 1]), Buffer.from([0xff])]) {
    const { options, lease } = fixture()
    const checksum = createHash('sha256').update(content).digest('hex')
    options.artifacts = [{ ...ref, checksum }]
    const session = await options.loadSession()
    session.artifacts![0].sha256 = checksum
    options.loadSession.mockResolvedValue(session)
    lease.version.checksum = checksum
    lease.size = content.length
    vi.mocked(lease.readRange).mockResolvedValue(content)
    await expect(resolveOptimizationArtifactInputs(options)).rejects.toThrow()
    expect(lease.close).toHaveBeenCalledOnce()
  }
})
