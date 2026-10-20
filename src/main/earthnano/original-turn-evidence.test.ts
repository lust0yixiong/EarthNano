import { expect, it, vi } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ExecutionRecord } from '../../shared/earthnano/execution-port'
import type { ManagedFileVersionService } from '../managed-file-versions/service'
import { createOriginalTurnEvidenceReader, originalTurnReply } from './original-turn-evidence'

const fixture = (): {
  session: PersistedChatSession
  versions: Pick<ManagedFileVersionService, 'openVersion'>
  openVersion: ReturnType<typeof vi.fn>
  readRange: ReturnType<typeof vi.fn>
  verifyUnchanged: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} => {
  const session: PersistedChatSession = {
    id: 'session',
    projectId: 'project',
    title: 'Original',
    cwd: '/tmp',
    status: 'idle',
    createdAt: 1,
    updatedAt: 3,
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'analyze binary',
        eventIds: [],
        status: 'complete',
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'reply',
        role: 'agent',
        content: 'original answer',
        artifactIds: ['version'],
        responseToMessageId: 'prompt',
        eventIds: [],
        status: 'complete',
        createdAt: 2,
        updatedAt: 2
      }
    ],
    artifacts: [
      {
        id: 'version',
        artifactId: 'artifact',
        versionId: 'version',
        kind: 'managed-file',
        path: '/original/binary.tif',
        name: 'binary.tif',
        mimeType: 'image/tiff',
        size: 32 * 1024 * 1024
      }
    ]
  }
  const readRange = vi.fn(async () => {
    throw new Error('Generic reader must not decode rich/binary bytes')
  })
  const verifyUnchanged = vi.fn(async () => undefined)
  const close = vi.fn(async () => undefined)
  const openVersion = vi.fn(async () => ({
    size: 32 * 1024 * 1024,
    version: { filename: 'binary.tif', checksum: 'a'.repeat(64) },
    readRange,
    verifyUnchanged,
    close
  }))
  return {
    session,
    versions: { openVersion } as unknown as Pick<ManagedFileVersionService, 'openVersion'>,
    openVersion,
    readRange,
    verifyUnchanged,
    close
  }
}
it('pins original large binary ArtifactVersions without the candidate UTF-8 or size profile', async () => {
  const f = fixture()
  const reader = createOriginalTurnEvidenceReader({
    dataRoot: '/tmp',
    versions: f.versions,
    load: async () => f.session
  })
  const turn = await reader.scopeSnapshot('project', 'session', 'prompt')
  expect(originalTurnReply(turn)).toBe('original answer')
  expect(await reader.artifacts(turn)).toEqual([
    { artifactId: 'artifact', versionId: 'version', checksum: 'a'.repeat(64) }
  ])
  expect(f.openVersion).toHaveBeenCalledWith(
    { source: 'artifact', projectId: 'project', fileId: 'artifact' },
    'version'
  )
  expect(f.readRange).not.toHaveBeenCalled()
  expect(f.verifyUnchanged).toHaveBeenCalledTimes(2)
  expect(f.close).toHaveBeenCalledTimes(2)
})
it('rejects changed fixed bytes and always closes their original lease', async () => {
  const f = fixture()
  f.verifyUnchanged.mockRejectedValue(new Error('changed bytes'))
  const reader = createOriginalTurnEvidenceReader({
    dataRoot: '/tmp',
    versions: f.versions,
    load: async () => f.session
  })
  await expect(reader.scopeSnapshot('project', 'session', 'prompt')).rejects.toThrow(
    'changed bytes'
  )
  expect(f.close).toHaveBeenCalledOnce()
})
it('rejects changed Session turn, artifact inventory, checksum and cross-session identity', async () => {
  const f = fixture()
  const reader = createOriginalTurnEvidenceReader({
    dataRoot: '/tmp',
    versions: f.versions,
    load: async () => f.session
  })
  const turn = await reader.scopeSnapshot('project', 'session', 'prompt')
  const record = {
    request: { projectId: 'project' },
    identity: { sessionId: 'session', promptMessageId: 'prompt' },
    evidence: { references: [turn.reference], artifacts: await reader.artifacts(turn) }
  } as ExecutionRecord
  await expect(reader.pinnedTurn(record)).resolves.toMatchObject({ reference: turn.reference })
  const wrongChecksum = structuredClone(record)
  wrongChecksum.evidence.artifacts[0].checksum = 'b'.repeat(64)
  await expect(reader.pinnedTurn(wrongChecksum)).rejects.toThrow('checksums')
  const duplicate = structuredClone(record)
  duplicate.evidence.artifacts.push(duplicate.evidence.artifacts[0])
  await expect(reader.pinnedTurn(duplicate)).rejects.toThrow('inventory')
  const otherSession = structuredClone(record)
  otherSession.identity.sessionId = 'other'
  await expect(reader.pinnedTurn(otherSession)).rejects.toThrow('identity')
  f.session.messages[1].content = 'tampered'
  await expect(reader.pinnedTurn(record)).rejects.toThrow('changed')
})
