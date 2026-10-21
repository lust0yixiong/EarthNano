import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import fixtures from '../../../contracts/execution/fixtures.json'
import type {
  ArtifactReference,
  ExecutionRecord,
  ExecutionRequest
} from '../../shared/earthnano/execution-port'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { initDataRoot } from '../storage-root'
import { NodeVersionFileOperator } from '../managed-file-versions/version-file-operator'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { createOriginalTurnEvidenceReader } from './original-turn-evidence'
import { createPersistentCandidateOwners } from './persistent-candidate-owner'
import { emptyExecutionState, ExecutionCore } from './execution-core'
import { requestDigest } from './execution-contract'
import { SessionRepository } from '../session-persistence/repository'
import { SettingsRepository } from '../settings/repository'
import { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { UploadRepository } from '../uploads/repository'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { NotebookRunRepository } from '../notebook/repository'
import { createRootNotebookLane } from '../notebook/lane-identity'
import { originalEvidenceCanonical, originalEvidenceDigest } from './original-turn-evidence'
import { createCandidateSnapshotStore } from './candidate-snapshot'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false } }))
const authority = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../session-persistence/repository', async (original) => ({
  ...(await original<typeof import('../session-persistence/repository')>()),
  loadSessionMutationAuthority: authority.load
}))
configureTestRuntimeMetadata()
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPrsAAAAASUVORK5CYII=',
  'base64'
)
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Phase-one boundary fixture: real original immutable Version files/leases, in-memory database
 * rows and Session authority. This does not claim native Notebook production or scientific validity. */
const fixture = async (
  inputs: Array<{ path: string; bytes: Buffer; contentType?: string }>,
  configured = true
): Promise<{
  root: string
  rows: Map<string, Record<string, unknown>>
  lineages: Map<string, Record<string, unknown>>
  session: PersistedChatSession
  reader: ReturnType<typeof createOriginalTurnEvidenceReader>
  references: ArtifactReference[]
  record: ExecutionRecord
  owners: ReturnType<typeof createPersistentCandidateOwners>
  projectionRoot: string
  storagePaths: string[]
  createOwners(): ReturnType<typeof createPersistentCandidateOwners>
  versions: ManagedFileVersionService
}> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'earthnano-binary-owner-')))
  initDataRoot(root)
  const configRoot = join(root, 'config')
  await mkdir(configRoot)
  const operator = new NodeVersionFileOperator({ storageRoot: root })
  const rows = new Map<string, Record<string, unknown>>()
  const lineages = new Map<string, Record<string, unknown>>()
  const references = [] as Array<{ artifactId: string; versionId: string; checksum: string }>
  const storagePaths: string[] = []
  for (const [index, input] of inputs.entries()) {
    const artifactId = `artifact-${index}`,
      versionId = `version-${index}`
    const filename = 'candidate-output--' + encodeURIComponent(input.path)
    const request = {
      operationId: `write-${index}`,
      scope: {
        source: 'artifact' as const,
        projectId: 'project',
        sessionId: 'session',
        logicalFileId: artifactId
      },
      logicalFilename: filename,
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(request)
    const stored = await operator.publishImmutable({
      ...request,
      plannedFile,
      content: input.bytes
    })
    storagePaths.push(join(root, stored.storageRef))
    references.push({ artifactId, versionId, checksum: stored.checksum })
    lineages.set(artifactId, {
      id: artifactId,
      projectId: 'project',
      sessionId: 'session',
      filename,
      currentVersionId: versionId
    })
    rows.set(versionId, {
      id: versionId,
      artifactId,
      filename,
      state: 'finalized',
      managedVisibleAt: new Date(1),
      originKind: 'agent_generated',
      basedOnVersionId: null,
      storageTag: null,
      storedFilename: stored.storedFilename,
      writeOperationId: `write-${index}`,
      contentStorageKey: stored.storageRef,
      contentType: input.contentType ?? null,
      sizeBytes: BigInt(input.bytes.length),
      checksum: stored.checksum,
      versionNumber: 1,
      createdAt: new Date(1)
    })
  }
  const nullable = { findUnique: async () => null }
  const client = {
    project: { findUnique: async () => ({ id: 'project', archivedAt: null }) },
    projectDeletionIntent: nullable,
    fileOriginSession: nullable,
    managedFileSessionSync: nullable,
    managedFile: nullable,
    artifactLineage: {
      findFirst: async ({ where }: { where: { id: string; projectId: string } }) =>
        where.projectId === 'project' ? (lineages.get(where.id) ?? null) : null
    },
    artifactVersion: {
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null
    }
  } as unknown as PrismaClient
  const session: PersistedChatSession = {
    id: 'session',
    projectId: 'project',
    title: 'Original',
    cwd: root,
    status: 'idle',
    createdAt: 1,
    updatedAt: 3,
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'Read fixed outputs',
        eventIds: [],
        status: 'complete',
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'reply',
        role: 'agent',
        content: 'Original answer',
        artifactIds: references.map((ref) => ref.versionId),
        responseToMessageId: 'prompt',
        eventIds: [],
        status: 'complete',
        createdAt: 2,
        updatedAt: 2
      }
    ],
    artifacts: references.map((ref, index) => ({
      id: ref.versionId,
      artifactId: ref.artifactId,
      versionId: ref.versionId,
      kind: 'managed-file',
      path: storagePaths[index],
      name: rows.get(ref.versionId)!.filename as string,
      mimeType: inputs[index].contentType,
      size: inputs[index].bytes.length
    }))
  }
  authority.load.mockImplementation(async (_repository, projectId, sessionId) =>
    projectId === session.projectId && sessionId === session.id
      ? { status: 'found', session }
      : { status: 'missing' }
  )
  const versions = new ManagedFileVersionService({
    storageRoot: root,
    getClient: async () => client
  })
  const reader = createOriginalTurnEvidenceReader({
    dataRoot: root,
    load: async () => session,
    versions
  })
  const repository = new SessionRepository(configRoot)
  const coordinator = new SessionPersistenceCoordinator(
    repository,
    new ManagedFileIndexRepository(
      async () => client,
      root,
      versions,
      new UploadRepository(root, { getClient: async () => client })
    )
  )
  const request: ExecutionRequest = {
    ...(structuredClone(fixtures.valid) as ExecutionRequest),
    projectId: 'project',
    role: 'candidate'
  }
  let state = emptyExecutionState()
  const core = new ExecutionCore(
    {
      load: () => structuredClone(state),
      commit: (next) => {
        state = structuredClone(next)
      }
    },
    {
      execute: async (_request, context) => {
        const promptMessageId = `candidate-prompt-${context.executionId}`
        session.messages[0]!.id = promptMessageId
        session.messages[1]!.responseToMessageId = promptMessageId
        session.runtimeSessionAdmissions = [
          {
            executionId: 'original-native-execution',
            promptMessageId,
            promptRuntimeSegmentId: 'segment',
            rootFrameId: 'root',
            agentFrameId: 'root',
            messageBranchId: 'branch',
            runtimeSegmentId: 'segment'
          }
        ]
        const turn = await reader.scopeSnapshot('project', 'session', promptMessageId)
        context.identity({
          sessionId: 'session',
          promptMessageId,
          runtimeExecutionId: 'original-native-execution'
        })
        context.running()
        return {
          phase: 'completed',
          cleanup: 'confirmed',
          evidence: {
            status: 'complete',
            scope: 'Phase-one lease fixture',
            text: 'Original answer',
            artifacts: references,
            references: [turn.reference],
            limitations: ['No native producer verification in this fixture.']
          }
        }
      }
    }
  )
  core.configureBudget('project', request.budgetRef, 1)
  const submitted = await core.submit(request)
  const record = await core.waitForTerminal(submitted.executionId)
  const projectionRoot = join(root, 'projections')
  const createOwners = (): ReturnType<typeof createPersistentCandidateOwners> =>
    createPersistentCandidateOwners({
      dataRoot: root,
      configRoot,
      getClient: async () => client,
      settings: new SettingsRepository(configRoot),
      sessionPersistence: { repository, coordinator },
      ...(configured ? { artifactProjectionRoot: projectionRoot } : {})
    })
  const owners = createOwners()
  onTestFinished(async () => {
    core.dispose()
    await owners.shutdown()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    rows,
    lineages,
    session,
    reader,
    references,
    record,
    owners,
    projectionRoot,
    storagePaths,
    createOwners,
    versions
  }
}

it('keeps the original text JSON shape and strictly verified bytes beside a binary descriptor', async () => {
  const text = '\ufeff{"count":3}\r\n'
  const f = await fixture([
    { path: 'result.json', bytes: Buffer.from(text), contentType: 'application/json' },
    { path: 'plots/figure.png', bytes: png, contentType: 'image/png' },
    { path: 'empty.txt', bytes: Buffer.alloc(0) }
  ])
  const result = await f.owners.exportResult(f.record)
  expect(result.files).toEqual([
    {
      path: 'result.json',
      content: text,
      digest: 'sha256:' + sha(Buffer.from(text)),
      artifactRef: f.references[0]
    },
    {
      path: 'plots/figure.png',
      representation: 'binary',
      sizeBytes: png.length,
      contentType: 'image/png',
      digest: 'sha256:' + sha(png),
      artifactRef: f.references[1]
    },
    {
      path: 'empty.txt',
      content: '',
      digest: 'sha256:' + sha(Buffer.alloc(0)),
      artifactRef: f.references[2]
    }
  ])
  expect(JSON.stringify(result.files[0])).toBe(
    JSON.stringify({
      path: 'result.json',
      content: text,
      digest: 'sha256:' + sha(Buffer.from(text)),
      artifactRef: f.references[0]
    })
  )
})

it('streams a binary larger than the old text limit while retaining the old text limit', async () => {
  const f = await fixture([
    {
      path: 'large.png',
      bytes: Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]),
      contentType: 'image/png'
    }
  ])
  const original = ManagedFileVersionService.prototype.openVersion
  const ranges: number[] = []
  vi.spyOn(ManagedFileVersionService.prototype, 'openVersion').mockImplementation(async function (
    this: ManagedFileVersionService,
    ...args
  ) {
    const lease = await original.apply(this, args)
    const read = lease.readRange
    lease.readRange = async (begin, end) => {
      ranges.push(end - begin)
      return read(begin, end)
    }
    return lease
  })
  expect((await f.owners.exportResult(f.record)).files[0]).toMatchObject({
    representation: 'binary',
    sizeBytes: png.length + 2 * 1024 * 1024
  })
  expect(ranges.length).toBeGreaterThan(32)
  expect(Math.max(...ranges)).toBeLessThanOrEqual(64 * 1024)
  const largeText = await fixture([
    { path: 'large.txt', bytes: Buffer.alloc(1024 * 1024 + 1, 65), contentType: 'text/plain' }
  ])
  await expect(largeText.owners.exportResult(largeText.record)).rejects.toThrow(
    'text export profile'
  )
})

it('materializes exact original bytes into private read-only targets with stable distinct opaque aliases', async () => {
  const f = await fixture([
    { path: 'first/figure.png', bytes: png, contentType: 'image/png' },
    { path: 'second/figure.png', bytes: png, contentType: 'image/png' }
  ])
  const one = await f.owners.materializeArtifact!(f.record, f.references[0])
  const two = await f.owners.materializeArtifact!(f.record, f.references[1])
  expect(await readFile(one.assetPath)).toEqual(png)
  expect(await readFile(two.assetPath)).toEqual(png)
  expect(basename(one.assetPath)).toMatch(/^artifact-[a-f0-9]{64}\.png$/)
  expect(basename(one.assetPath)).not.toBe(basename(two.assetPath))
  expect(one.file).toEqual((await f.owners.exportResult(f.record)).files[0])
  if (process.platform !== 'win32') expect((await lstat(one.assetPath)).mode & 0o222).toBe(0)
  expect((await lstat(one.assetPath)).nlink).toBe(1)
  expect(await f.owners.materializeArtifact!(f.record, f.references[0])).toEqual(one)
  expect(await f.owners.shutdown()).toEqual({ reaped: true })
  expect(await readdir(f.projectionRoot)).toEqual([])
  const reopened = f.createOwners()
  try {
    expect(
      basename((await reopened.materializeArtifact!(f.record, f.references[0])).assetPath)
    ).toBe(basename(one.assetPath))
  } finally {
    await reopened.shutdown()
  }
})

it('requires an explicit host projection root and an exact completed task reference', async () => {
  const missing = await fixture(
    [{ path: 'figure.png', bytes: png, contentType: 'image/png' }],
    false
  )
  await expect(
    missing.owners.materializeArtifact!(missing.record, missing.references[0])
  ).rejects.toThrow('not configured')
  const f = await fixture([{ path: 'figure.png', bytes: png, contentType: 'image/png' }])
  for (const mutation of [
    'execution',
    'nativeExecution',
    'role',
    'phase',
    'cleanup',
    'project',
    'session',
    'checksum',
    'version'
  ] as const) {
    const record = structuredClone(f.record),
      ref = structuredClone(f.references[0])
    if (mutation === 'execution') record.executionId = 'foreign-core-execution'
    if (mutation === 'nativeExecution')
      record.identity.runtimeExecutionId = 'foreign-native-execution'
    if (mutation === 'role') record.request.role = 'reviewer'
    if (mutation === 'phase') record.phase = 'failed'
    if (mutation === 'cleanup') record.cleanup = 'unknown'
    if (mutation === 'project') record.request.projectId = 'foreign'
    if (mutation === 'session') record.identity.sessionId = 'foreign'
    if (mutation === 'checksum') ref.checksum = 'f'.repeat(64)
    if (mutation === 'version') ref.versionId = 'foreign'
    record.requestDigest = requestDigest(record.request)
    await expect(f.owners.materializeArtifact!(record, ref), mutation).rejects.toThrow()
  }
  expect(await readdir(f.root)).not.toContain('projections')
})

it('rejects original Version tampering and modified projection bytes', async () => {
  const f = await fixture([{ path: 'figure.png', bytes: png, contentType: 'image/png' }])
  const materialized = await f.owners.materializeArtifact!(f.record, f.references[0])
  await chmod(materialized.assetPath, 0o600)
  await writeFile(materialized.assetPath, Buffer.alloc(png.length))
  await expect(f.owners.materializeArtifact!(f.record, f.references[0])).rejects.toThrow(
    'projection bytes changed'
  )
  await chmod(f.storagePaths[0], 0o600)
  await writeFile(f.storagePaths[0], Buffer.alloc(png.length))
  await expect(f.owners.exportResult(f.record)).rejects.toThrow()
})

it.skipIf(process.platform === 'win32')(
  'rejects a linked projection root before writing through it',
  async () => {
    const f = await fixture([{ path: 'figure.png', bytes: png, contentType: 'image/png' }])
    const outside = join(f.root, 'outside')
    await mkdir(outside)
    await symlink(outside, f.projectionRoot, 'dir')
    await expect(f.owners.materializeArtifact!(f.record, f.references[0])).rejects.toThrow(
      'linked directory'
    )
    expect(await readdir(outside)).toEqual([])
  }
)

it('aborts bounded lease copying, releases the original lease and removes partial projections', async () => {
  const f = await fixture([
    {
      path: 'large.png',
      bytes: Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]),
      contentType: 'image/png'
    }
  ])
  const controller = new AbortController()
  const original = ManagedFileVersionService.prototype.openVersion
  let reads = 0,
    closes = 0,
    opens = 0
  vi.spyOn(ManagedFileVersionService.prototype, 'openVersion').mockImplementation(async function (
    this: ManagedFileVersionService,
    ...args
  ) {
    const lease = await original.apply(this, args)
    opens++
    const read = lease.read,
      close = lease.close
    lease.read = async (...args) => {
      const result = await read(...args)
      if (++reads === 1) controller.abort(new Error('Stop materialization'))
      return result
    }
    lease.close = async () => {
      closes++
      await close()
    }
    return lease
  })
  await expect(
    f.owners.materializeArtifact!(f.record, f.references[0], controller.signal)
  ).rejects.toThrow('Stop materialization')
  expect(await f.owners.shutdown()).toEqual({ reaped: true })
  expect(reads).toBe(1)
  expect(closes).toBe(opens)
  expect(await readdir(f.projectionRoot)).toEqual([])
})

it('keeps declared ASCII binary formats as descriptors and copies the exact old Version', async () => {
  const asciiPdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')
  const f = await fixture([
    { path: 'diagram.pdf', bytes: asciiPdf, contentType: 'application/pdf' }
  ])
  const old = structuredClone(f.rows.get('version-0')!)
  f.rows.set('new-version', {
    ...old,
    id: 'new-version',
    versionNumber: 2,
    checksum: 'f'.repeat(64)
  })
  f.lineages.get('artifact-0')!.currentVersionId = 'new-version'
  const output = await f.owners.exportResult(f.record)
  expect(output.files[0]).toEqual({
    path: 'diagram.pdf',
    representation: 'binary',
    sizeBytes: asciiPdf.length,
    contentType: 'application/pdf',
    digest: 'sha256:' + sha(asciiPdf),
    artifactRef: f.references[0]
  })
  expect('content' in output.files[0]!).toBe(false)
  const asset = await f.owners.materializeArtifact!(f.record, f.references[0])
  expect(await readFile(asset.assetPath)).toEqual(asciiPdf)
  expect(asset.file.artifactRef.versionId).toBe('version-0')
})

it('checks the original scientific producer and exact prompt again before export or projection', async () => {
  const f = await fixture([{ path: 'figure.png', bytes: png, contentType: 'image/png' }])
  const notebook = new NotebookRunRepository(f.root)
  const lane = createRootNotebookLane('project', 'session', 'root')
  await notebook.loadOrCreate({
    projectId: 'project',
    sessionId: 'session',
    workspaceCwd: f.root,
    lane
  })
  await notebook.appendRun({
    projectId: 'project',
    sessionId: 'session',
    lane,
    run: {
      runId: 'original-producer',
      cellId: 'original-cell',
      source: 'agent',
      kernelKind: 'python',
      script: 'make_original_plot()',
      status: 'completed',
      startedAt: 1,
      endedAt: 2,
      promptMessageId: f.record.identity.promptMessageId,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: []
    }
  })
  const runs = await notebook.readSessionRuns('project', 'session')
  f.record.evidence.references.push({
    id: `notebook-scientific:session:${f.record.identity.promptMessageId}`,
    version: f.record.identity.promptMessageId!,
    digest: originalEvidenceDigest(originalEvidenceCanonical(runs))
  })
  const execution = {
    schemaVersion: 2 as const,
    rootFrameId: 'root',
    agentFrameId: 'root',
    messageBranchId: 'branch',
    terminalPromptMessageId: f.record.identity.promptMessageId!,
    producerRunId: 'original-producer',
    producerRunIndex: 0,
    createdAt: new Date(2).toISOString(),
    inputFiles: [],
    runs: []
  }
  const producer = vi
    .spyOn(ArtifactProvenanceRepository.prototype, 'getVersionExecution')
    .mockResolvedValue({ execution })
  expect((await f.owners.exportResult(f.record)).files[0]).toMatchObject({
    representation: 'binary'
  })
  producer.mockResolvedValue({ execution: { ...execution, producerRunId: 'foreign-producer' } })
  await expect(f.owners.exportResult(f.record)).rejects.toThrow('original Notebook producer')
  await expect(f.owners.materializeArtifact!(f.record, f.references[0])).rejects.toThrow(
    'original Notebook producer'
  )
  producer.mockResolvedValue({
    execution: { ...execution, terminalPromptMessageId: 'foreign-prompt' }
  })
  await expect(f.owners.materializeArtifact!(f.record, f.references[0])).rejects.toThrow(
    'original Notebook producer'
  )
  expect(await readdir(f.root)).not.toContain('projections')
})

it('retains a failed original copy-lease close for shutdown retry and never exposes the projection', async () => {
  const f = await fixture([{ path: 'figure.png', bytes: png, contentType: 'image/png' }])
  const original = ManagedFileVersionService.prototype.openVersion
  let failClose = true,
    outstanding = 0
  vi.spyOn(ManagedFileVersionService.prototype, 'openVersion').mockImplementation(async function (
    this: ManagedFileVersionService,
    ...args
  ) {
    const lease = await original.apply(this, args)
    outstanding++
    let copying = false,
      closed = false
    const read = lease.read,
      close = lease.close
    lease.read = async (...args) => {
      copying = true
      return read(...args)
    }
    lease.close = async () => {
      if (copying && failClose) throw new Error('Original lease close failed')
      await close()
      if (!closed) {
        outstanding--
        closed = true
      }
    }
    return lease
  })
  await expect(f.owners.materializeArtifact!(f.record, f.references[0])).rejects.toThrow(
    'Original lease close failed'
  )
  expect(outstanding).toBe(1)
  expect(await f.owners.shutdown()).toEqual({ reaped: false })
  expect(await readdir(f.projectionRoot)).toEqual([])
  failClose = false
  expect(await f.owners.shutdown()).toEqual({ reaped: true })
  expect(outstanding).toBe(0)
})

it('waits for original source verification to release its lease when stopped before projection allocation', async () => {
  const f = await fixture([{ path: 'figure.png', bytes: png, contentType: 'image/png' }])
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const original = ManagedFileVersionService.prototype.openVersion
  let opens = 0,
    closes = 0
  vi.spyOn(ManagedFileVersionService.prototype, 'openVersion').mockImplementation(async function (
    this: ManagedFileVersionService,
    ...args
  ) {
    const lease = await original.apply(this, args)
    opens++
    const read = lease.readRange,
      close = lease.close
    lease.readRange = async (...args) => {
      entered.resolve()
      await release.promise
      return read(...args)
    }
    lease.close = async () => {
      await close()
      closes++
    }
    return lease
  })
  const materializing = f.owners.materializeArtifact!(f.record, f.references[0])
  void materializing.catch(() => undefined)
  await entered.promise
  let stopped = false
  const shutdown = f.owners.shutdown().then((result) => {
    stopped = true
    return result
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(stopped).toBe(false)
  expect(closes).toBeLessThan(opens)
  release.resolve()
  await expect(materializing).rejects.toThrow('shutting down')
  expect(await shutdown).toEqual({ reaped: true })
  expect(closes).toBe(opens)
  expect(await readdir(f.root)).not.toContain('projections')
})

it('retains exact projection cleanup after its directory identity changes and retries only its own tree', async () => {
  const f = await fixture([{ path: 'figure.png', bytes: png, contentType: 'image/png' }])
  await f.owners.materializeArtifact!(f.record, f.references[0])
  const saved = join(f.root, 'saved-projections')
  await rename(f.projectionRoot, saved)
  await mkdir(f.projectionRoot)
  const foreign = join(f.projectionRoot, 'foreign.txt')
  await writeFile(foreign, 'untouched')
  expect(await f.owners.shutdown()).toEqual({ reaped: false })
  expect(await readFile(foreign, 'utf8')).toBe('untouched')
  await rm(f.projectionRoot, { recursive: true })
  await rename(saved, f.projectionRoot)
  expect(await f.owners.shutdown()).toEqual({ reaped: true })
  expect(await readdir(f.projectionRoot)).toEqual([])
})

it('feeds original binary Version bytes through the existing snapshot INPUT projection callback', async () => {
  const f = await fixture([{ path: 'figure.png', bytes: png, contentType: 'image/png' }])
  const candidatesRoot = join(f.root, 'candidate-contexts')
  const snapshots = await createCandidateSnapshotStore({
    root: join(f.root, 'snapshots'),
    candidatesRoot,
    materializeAsset: (asset, signal) => {
      expect(asset.sourceExecutionId).toBe(f.record.executionId)
      return f.owners.materializeArtifact!(f.record, asset.artifact.artifactRef, signal)
    }
  })
  const exported = await f.owners.exportResult(f.record)
  const artifact = exported.files[0]!
  if (!('representation' in artifact)) throw new Error('Expected original binary descriptor')
  const refs = await snapshots.freeze({
    task: {
      prompt: 'Inspect the anonymous plot.',
      files: [{ path: 'task.txt', content: 'Original text stays unchanged.' }]
    },
    harness: {
      instructions: 'Use Read on the supplied INPUT assets.',
      skills: [],
      tools: 'workspace-only'
    },
    agent: {
      backend: 'claude-code',
      model: 'fixture',
      providerRef: 'fixture',
      runtimeVersion: 'fixture'
    },
    environment: { isolation: 'directory-process', network: 'provider-only' }
  })
  const invocationRef = await snapshots.freezeInvocation({
    taskSnapshotRef: refs.taskSnapshotRef,
    harnessRevisionRef: refs.harnessRevisionRef,
    mission: 'Inspect the fixed binary asset.',
    assets: [{ path: 'assets/anonymous.png', sourceExecutionId: f.record.executionId, artifact }]
  })
  const projected = await snapshots.materialize({
    executionId: 'reader-context',
    refs: { ...refs, invocationRef }
  })
  try {
    expect(await readFile(join(projected.inputDir, 'assets', 'anonymous.png'))).toEqual(png)
    expect(await readFile(join(projected.inputDir, 'task.txt'), 'utf8')).toBe(
      'Original text stays unchanged.'
    )
    expect(projected.manifest).toContainEqual({
      path: 'workspace/inputs/assets/anonymous.png',
      digest: 'sha256:' + sha(png),
      bytes: png.length
    })
    expect(JSON.stringify(projected.snapshots.invocation.assets)).not.toContain(f.projectionRoot)
  } finally {
    const unlock = async (path: string): Promise<void> => {
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return
      await chmod(path, 0o700)
      for (const name of await readdir(path)) await unlock(join(path, name))
    }
    await unlock(candidatesRoot)
  }
})

it.each([
  ['figure.png', 'FIGURE.png'],
  ['report', 'report/figure.png'],
  ['report', 'report-other', 'report/figure.png'],
  ['CON.png']
])('rejects colliding, overlapping or nonportable binary paths: %j', async (...paths) => {
  const f = await fixture(paths.map((path) => ({ path, bytes: png, contentType: 'image/png' })))
  await expect(f.owners.exportResult(f.record)).rejects.toThrow(/Colliding|Overlapping|portable/)
  await expect(f.owners.materializeArtifact!(f.record, f.references[0])).rejects.toThrow(
    /Colliding|Overlapping|portable/
  )
  expect(await readdir(f.root)).not.toContain('projections')
})
