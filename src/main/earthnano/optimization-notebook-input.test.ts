import { createHash } from 'node:crypto'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import { expect, it, vi } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type {
  ManagedFileReadLease,
  ManagedFileVersionReadPort
} from '../managed-file-versions/read-port'
import {
  resolveOptimizationNotebookInputs,
  resolveOptimizationComputeInputs
} from './optimization-notebook-input'
const bytes = Buffer.from('sample,value\nA,2\nB,4\nC,6\n')
const checksum = createHash('sha256').update(bytes).digest('hex')
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- preserve typed test mocks
const fixture = () => {
  const lease = {
    logicalFile: {
      source: 'upload',
      projectId: 'project',
      sessionId: 'session',
      id: 'source-file'
    },
    version: { id: 'version-1', filename: 'measurements.csv', checksum },
    size: bytes.length,
    readRange: vi.fn(async (begin: number, end: number) => bytes.subarray(begin, end)),
    verifyUnchanged: vi.fn(async () => {}),
    close: vi.fn(async () => {})
  } as unknown as ManagedFileReadLease
  const session = {
    id: 'session',
    projectId: 'project',
    messages: [
      {
        id: 'prompt',
        role: 'user',
        status: 'complete',
        content: 'Calculate CSV mean using Notebook',
        uploads: [
          {
            id: 'source-file',
            versionId: 'version-1',
            sessionId: 'session',
            name: 'measurements.csv',
            originalName: 'measurements.csv',
            sha256: checksum,
            size: bytes.length
          }
        ]
      }
    ]
  } as PersistedChatSession
  const options = {
    projectId: 'project',
    sourceSessionId: 'session',
    source: { promptMessageId: 'prompt' },
    prompt: session.messages[0].content,
    loadSession: vi.fn(async () => session),
    versions: { openVersion: vi.fn<ManagedFileVersionReadPort['openVersion']>(async () => lease) }
  }
  return { options, lease, session }
}
it('allows an exact Compute source with no attachments while retaining Python/R nonempty requirements', async () => {
  const { options, session } = fixture()
  session.messages[0].uploads = []
  expect(await resolveOptimizationComputeInputs(options)).toEqual([])
  await expect(resolveOptimizationNotebookInputs(options)).rejects.toThrow(/inputs unavailable/)
  expect(options.versions.openVersion).not.toHaveBeenCalled()
})

it('uses the same fixed Version bytes and closed lease for Compute inputs', async () => {
  const { options, lease } = fixture()
  const notebook = await resolveOptimizationNotebookInputs(options)
  const compute = await resolveOptimizationComputeInputs(options)
  expect(compute).toEqual(notebook)
  expect(options.versions.openVersion.mock.calls.map((call) => call[1])).toEqual([
    'version-1',
    'version-1'
  ])
  expect(lease.verifyUnchanged).toHaveBeenCalledTimes(2)
  expect(lease.close).toHaveBeenCalledTimes(2)
})

it.each(['project', 'session', 'prompt', 'archived', 'attribution'] as const)(
  'rejects an empty Compute source with invalid %s authority before reading versions',
  async (attack) => {
    const { options, session } = fixture()
    session.messages[0].uploads = []
    if (attack === 'project') session.projectId = 'foreign'
    if (attack === 'session') session.id = 'foreign'
    if (attack === 'prompt') options.prompt = 'different task'
    if (attack === 'archived') session.archivedAt = 1
    if (attack === 'attribution')
      session.messages[0].attribution = {
        kind: 'application',
        feature: 'background-results',
        purpose: 'agent-result-delivery',
        deliveryKey: 'agent-result-delivery:other',
        deliveryIds: ['foreign']
      }
    await expect(resolveOptimizationComputeInputs(options)).rejects.toThrow()
    expect(options.versions.openVersion).not.toHaveBeenCalled()
  }
)

it('rejects changed Compute input bytes and closes the original Version lease', async () => {
  const { options, lease } = fixture()
  vi.mocked(lease.readRange).mockImplementation(async (begin, end) => Buffer.alloc(end - begin, 0))
  await expect(resolveOptimizationComputeInputs(options)).rejects.toThrow(/bytes changed/)
  expect(lease.close).toHaveBeenCalledOnce()
})

it('freezes the exact original task and upload version without copying bytes into the snapshot or reading latest', async () => {
  const { options, lease } = fixture()
  const result = await resolveOptimizationNotebookInputs(options)
  expect(result).toEqual([
    {
      sourceKind: 'upload-version',
      sourceProjectId: 'project',
      sourceSessionId: 'session',
      sourceFileId: 'source-file',
      inputFileVersionId: 'version-1',
      filename: 'measurements.csv',
      sizeBytes: bytes.length,
      checksum
    }
  ])
  expect(options.versions.openVersion).toHaveBeenCalledExactlyOnceWith(
    { source: 'upload', projectId: 'project', fileId: 'source-file' },
    'version-1'
  )
  expect(lease.close).toHaveBeenCalledOnce()
  expect(JSON.stringify(result)).not.toContain(bytes.toString())
})
it('keeps the original source tuple when a later artifact version exists', async () => {
  const { options, lease, session } = fixture()
  session.messages[0].uploads = []
  session.messages[0].parts = [
    {
      type: 'artifact',
      source: 'artifact',
      id: 'row',
      sourceFileId: 'source-file',
      versionId: 'version-1',
      name: 'measurements.csv',
      path: 'artifact-version:version-1'
    }
  ]
  session.artifacts = [
    {
      id: 'version-2',
      artifactId: 'source-file',
      versionId: 'version-2',
      kind: 'managed-file',
      path: 'artifact-version:version-2',
      sha256: 'f'.repeat(64)
    }
  ]
  lease.logicalFile.source = 'artifact'
  lease.logicalFile.sessionId = 'original-input-session'
  expect(await resolveOptimizationNotebookInputs(options)).toMatchObject([
    {
      sourceKind: 'artifact-version',
      sourceSessionId: 'original-input-session',
      inputFileVersionId: 'version-1',
      checksum
    }
  ])
  expect(options.versions.openVersion.mock.calls[0]?.[1]).toBe('version-1')
})
it('rejects unrelated, incomplete or altered source tasks before opening content', async () => {
  for (const attack of [
    'project',
    'session',
    'message',
    'prompt',
    'not-user',
    'legacy-upload',
    'image',
    'linked-folder',
    'archived',
    'intent',
    'relay',
    'delegated',
    'structured'
  ] as const) {
    const { options, session } = fixture()
    if (attack === 'project') options.projectId = 'foreign'
    if (attack === 'session') options.sourceSessionId = 'foreign'
    if (attack === 'message') options.source.promptMessageId = 'foreign'
    if (attack === 'prompt') options.prompt += 'different task'
    if (attack === 'not-user') session.messages[0].role = 'agent'
    if (attack === 'legacy-upload') delete session.messages[0].uploads![0].versionId
    if (attack === 'image') session.messages[0].images = [{ id: 'image' }] as never
    if (attack === 'linked-folder')
      session.messages[0].parts = [
        {
          type: 'artifact',
          source: 'linked-folder',
          id: 'f',
          name: 'f',
          rootId: 'root',
          relativePath: 'f'
        }
      ]
    if (attack === 'archived') session.archivedAt = 1
    if (attack === 'intent') session.messages[0].turnIntent = 'plan-first'
    if (attack === 'relay')
      session.messages[0].relayedFrom = { kind: 'side-chat', direction: 'to-main' }
    if (attack === 'delegated') session.messages[0].delegatedInputVersionIds = ['version-1']
    if (attack === 'structured') session.messages[0].structuredOutputEvidenceInvalid = true
    await expect(resolveOptimizationNotebookInputs(options)).rejects.toThrow()
    expect(options.versions.openVersion).not.toHaveBeenCalled()
  }
})
it('closes exact leases on foreign versions, corruption, incomplete reads and interrupted verification', async () => {
  for (const attack of [
    'project',
    'file',
    'version',
    'owner',
    'name',
    'checksum',
    'size',
    'bytes',
    'short',
    'changed'
  ] as const) {
    const { options, lease } = fixture()
    if (attack === 'project') lease.logicalFile.projectId = 'foreign'
    if (attack === 'file') lease.logicalFile.id = 'foreign'
    if (attack === 'version') lease.version.id = 'foreign'
    if (attack === 'owner') lease.logicalFile.sessionId = 'foreign'
    if (attack === 'name') lease.version.filename = 'foreign.csv'
    if (attack === 'checksum') lease.version.checksum = 'f'.repeat(64)
    if (attack === 'size') lease.size++
    if (attack === 'bytes') vi.mocked(lease.readRange).mockResolvedValue(Buffer.alloc(bytes.length))
    if (attack === 'short') vi.mocked(lease.readRange).mockResolvedValue(bytes.subarray(1))
    if (attack === 'changed')
      vi.mocked(lease.verifyUnchanged).mockRejectedValue(new Error('changed'))
    await expect(resolveOptimizationNotebookInputs(options)).rejects.toThrow()
    expect(lease.close).toHaveBeenCalledOnce()
  }
  const { options, lease } = fixture()
  const controller = new AbortController()
  vi.mocked(lease.readRange).mockImplementation(async () => {
    controller.abort()
    return bytes
  })
  await expect(
    resolveOptimizationNotebookInputs({ ...options, signal: controller.signal })
  ).rejects.toThrow()
  expect(lease.close).toHaveBeenCalledOnce()
})

it('uses the original active conversation graph rather than a stale message projection', async () => {
  const { options, session } = fixture()
  session.conversationGraph = createLinearConversationGraph({
    sessionId: session.id,
    messages: session.messages,
    frameworkId: 'claude-code',
    createdAt: 1,
    updatedAt: 1
  })
  session.messages = [{ ...session.messages[0], content: 'stale user projection', uploads: [] }]
  expect(await resolveOptimizationNotebookInputs(options)).toMatchObject([
    { inputFileVersionId: 'version-1', checksum }
  ])
})
