import { createRequire } from 'node:module'
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false } }))
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { createEarthnanoMessagesProvider } from '../../../e2e/fixtures/earthnano-messages-provider'
import { initDataRoot } from '../storage-root'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { UploadRepository } from '../uploads/repository'
import { NotebookRuntimeSettingsModule } from '../settings/notebook-runtime-settings'
import { SettingsRepository } from '../settings/repository'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { NotebookRunRepository } from '../notebook/repository'
import { NotebookInputRegistry } from '../notebook/input-registry'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ArtifactRepository } from '../artifacts/repository'
import { SessionRepository, loadSessionMutationAuthority } from '../session-persistence/repository'
import { createCandidateSnapshotStore } from './candidate-snapshot'
import { createClaudeCandidateDriver } from './claude-candidate-driver'
import { createPersistentCandidateOwners } from './persistent-candidate-owner'
import { emptyExecutionState, ExecutionCore } from './execution-core'
import type { ExecutionRequest } from '../../shared/earthnano/execution-port'

configureTestRuntimeMetadata()
it.skipIf(process.platform === 'win32' || !process.env.EARTHNANO_RESEARCH_PYTHON)(
  'runs the original Python MCP and producer owners against an old fixed source Version in one Core',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'earthnano-scientific-')))
    // Launch the original source MCP entry points from ordinary Node. The desktop production
    // bundle is Electron-owned and its entry must not be imported as an ordinary Node program.
    const mcpEntryPath = join(root, 'original-mcp-entry.cjs')
    await writeFile(
      mcpEntryPath,
      `const jiti = require(${JSON.stringify(createRequire(import.meta.url).resolve('jiti'))}).createJiti(__filename);
(async () => {
const notebook = process.argv.includes('--open-science-notebook-mcp');
const api = await jiti.import(notebook ? ${JSON.stringify(resolve('src/main/notebook/mcp-server.ts'))} : ${JSON.stringify(resolve('src/main/artifacts/mcp-server.ts'))});
await (notebook ? api.runNotebookMcpServer() : api.runArtifactMcpServer());
})().catch(error => { process.stderr.write(String(error)); process.exitCode = 1 });
`
    )
    initDataRoot(root)
    const configRoot = join(root, 'config')
    await mkdir(configRoot)
    const client = createProjectDbClient(configRoot)
    await migrateApplicationDatabase(client)
    const projectId = 'scientific-project',
      sourceSessionId = 'scientific-source'
    await client.project.create({ data: { id: projectId, name: 'Scientific candidate owners' } })
    const versions = new ManagedFileVersionService({
      storageRoot: root,
      getClient: async () => client
    })
    const sessions = new SessionRepository(configRoot)
    await sessions.saveSession({
      id: sourceSessionId,
      projectId,
      title: 'Source',
      cwd: root,
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    const uploads = new UploadRepository(root, { getClient: async () => client })
    const source = join(root, 'measurements.csv'),
      content = 'sample,value\na,2\nb,4\nc,6\n'
    await writeFile(source, content)
    const upload = await uploads.stageLocalFile({
      transferId: 'source-upload',
      sourcePath: source,
      name: 'measurements.csv',
      mimeType: 'text/csv',
      size: Buffer.byteLength(content)
    })
    const [fixed] = await uploads.finalizePendingSessionUploads(
      sourceSessionId,
      [upload],
      projectId
    )
    const lease = await versions.openVersion(
      { source: 'upload', projectId, fileId: fixed.id },
      fixed.versionId!
    )
    const managedInput = {
      sourceKind: 'upload-version' as const,
      sourceProjectId: projectId,
      sourceSessionId,
      sourceFileId: fixed.id,
      inputFileVersionId: fixed.versionId!,
      filename: lease.version.filename,
      sizeBytes: lease.size,
      checksum: lease.version.checksum
    }
    await lease.close()
    // Seed a later head through original immutable upload byte ingestion. CSV is intentionally
    // not an editable text extension; the fixture moves the second immutable Version into the
    // original logical file to model a later source revision without changing old bytes.
    await writeFile(source, 'sample,value\nchanged,999\n')
    const stagedLater = await uploads.stageLocalFile({
      transferId: 'later-source',
      sourcePath: source,
      name: 'measurements.csv',
      mimeType: 'text/csv',
      size: Buffer.byteLength('sample,value\nchanged,999\n')
    })
    const [later] = await uploads.finalizePendingSessionUploads(
      sourceSessionId,
      [stagedLater],
      projectId
    )
    await client.$transaction(async (tx) => {
      await tx.uploadFile.update({ where: { id: later.id }, data: { currentVersionId: null } })
      await tx.uploadVersion.update({
        where: { id: later.versionId! },
        data: { uploadFileId: fixed.id, versionNumber: 2, basedOnVersionId: fixed.versionId }
      })
      await tx.uploadFile.update({
        where: { id: fixed.id },
        data: { currentVersionId: later.versionId }
      })
    })
    const settings = new NotebookRuntimeSettingsModule(new SettingsRepository(configRoot))
    const python = await realpath(process.env.EARTHNANO_RESEARCH_PYTHON ?? '/usr/bin/python3')
    await settings.addManualInterpreter('python', python)
    await settings.setEnvironmentEnabled('python', python, true)
    const notebook = new NotebookRuntimeService({
      configRoot,
      dataRoot: root,
      projectId,
      notebookRuntimeSettings: settings,
      backgroundExecutionEnabled: false
    })
    notebook.setExecutionApproval(async () => false)
    notebook.setRuntimeBindingApproval(async () => false)
    const provenance = new ArtifactProvenanceRepository({
      storageRoot: root,
      getClient: async () => client,
      compatibilityRepository: new ArtifactRepository(root),
      loadSession: async (project, session) => {
        const value = await loadSessionMutationAuthority(sessions, project, session)
        if (value.status !== 'found') throw new Error('Session missing')
        return value.session
      }
    })
    const rpc = new NotebookLocalRpcServer(notebook, {
      transport: 'tcp',
      artifactProvenance: provenance,
      inputRegistry: new NotebookInputRegistry({
        storageRoot: root,
        inputAuthority: new ImmutableInputAuthority({
          storageRoot: root,
          managedFileVersions: versions
        })
      })
    })
    let owners = createPersistentCandidateOwners({
      dataRoot: root,
      configRoot,
      getClient: async () => client,
      notebook: { service: notebook, rpc, mcpEntryPath }
    })
    const provider = await createEarthnanoMessagesProvider(false)
    // The cleanup is registered before native execution; optional access covers initialization failure.
    let disposeCore = (): void => undefined
    onTestFinished(async () => {
      disposeCore()
      await owners.shutdown()
      await rpc.close()
      await notebook.dispose()
      await provider.close()
      await client.$disconnect()
      const unlock = async (path: string): Promise<void> => {
        const stat = await lstat(path)
        if (stat.isSymbolicLink()) return
        if (stat.isDirectory()) {
          await chmod(path, 0o700)
          for (const name of await readdir(path)) await unlock(join(path, name))
        }
      }
      await unlock(root)
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })
    const binding = (
      await notebook.listRuntimes({ projectId, sessionId: sourceSessionId, workspaceCwd: root })
    ).runtimes.find((entry) => entry.runtimeId === python)!
    const {
      language,
      runtimeId,
      source: runtimeSource,
      provenance: runtimeProvenance,
      interpreterPath,
      version
    } = binding
    const snapshots = await createCandidateSnapshotStore({
      root: join(root, 'snapshots'),
      candidatesRoot: join(root, 'candidates')
    })
    const refs = await snapshots.freeze({
      task: {
        prompt:
          'Use csv and statistics to compute count, sum and mean for measurements.csv and publish research-results.json.',
        files: [],
        managedInputs: [managedInput]
      },
      harness: {
        instructions:
          'Analyze the original fixed input with Notebook Python; publish a real producer report.',
        skills: [],
        tools: 'notebook-python'
      },
      agent: {
        backend: 'claude-code',
        model: 'deepseek-flash',
        providerRef: 'scientific-local',
        runtimeVersion: '2.1.232'
      },
      environment: {
        isolation: 'directory-process',
        network: 'provider-and-notebook-policy',
        notebook: {
          runtime: {
            language: language as 'python',
            runtimeId,
            source: runtimeSource,
            provenance: runtimeProvenance,
            interpreterPath,
            ...(version ? { version } : {})
          }
        }
      }
    })
    const invocationRef = await snapshots.freezeInvocation({
      taskSnapshotRef: refs.taskSnapshotRef,
      harnessRevisionRef: refs.harnessRevisionRef,
      mission: 'Compute the scientific task using the original Python tools.'
    })
    const request: ExecutionRequest = {
      contractVersion: 1,
      requestKey: 'scientific-candidate',
      projectId,
      ...refs,
      invocationRef,
      role: 'candidate',
      origin: { kind: 'optimization', optimizationId: 'scientific', stageId: 'candidate' },
      interactionPolicy: 'deny-unresolved',
      budgetRef: 'one-scientific',
      timeoutMs: 60_000
    }
    let state = emptyExecutionState()
    const core = new ExecutionCore(
      {
        load: () => structuredClone(state),
        commit: (next) => {
          state = structuredClone(next)
        }
      },
      createClaudeCandidateDriver({
        snapshots,
        openOwner: (input) => owners.openOwner(input),
        binding: async (agent) => ({
          executablePath: createRequire(import.meta.url).resolve(
            `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`
          ),
          runtimeVersion: agent.runtimeVersion,
          providerRef: agent.providerRef,
          provider: {
            type: 'custom',
            model: agent.model,
            key: provider.token,
            baseUrl: provider.url,
            apiEndpoints: ['messages']
          }
        })
      })
    )
    disposeCore = () => core.dispose()
    core.configureBudget(projectId, request.budgetRef, 1)
    const handle = await core.submit(request)
    const record = await core.waitForTerminal(handle.executionId)
    expect(record, JSON.stringify(record)).toMatchObject({
      phase: 'completed',
      cleanup: 'confirmed'
    })
    expect(Object.keys(state.records)).toEqual([record.executionId])
    expect(Object.values(state.budgets)).toEqual([{ limit: 1, admitted: 1 }])
    expect(record.evidence.artifacts).toHaveLength(1)
    const result = await owners.exportResult(record)
    expect(JSON.parse(result.files[0].content)).toEqual({ count: 3, sum: 12, mean: 4 })
    const runs = await new NotebookRunRepository(root).readSessionRuns(
      projectId,
      record.identity.sessionId!
    )
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      kernelKind: 'python',
      status: 'completed',
      executionInvocationId: expect.any(String),
      inputFiles: [expect.objectContaining(managedInput)]
    })
    const versionRow = await client.artifactVersion.findUniqueOrThrow({
      where: { id: record.evidence.artifacts[0].versionId }
    })
    expect(versionRow.producerRunId).toBe(runs[0].runId)
    expect(versionRow.filename).toBe('research-results.json')
    expect(
      await client.uploadFile.count({ where: { sessionId: record.identity.sessionId! } })
    ).toBe(0)
    expect((await owners.readReviews(record))[0].outcome).toBe('pass')
    const calls = provider.stats.requests
    expect(await owners.shutdown()).toEqual({ reaped: true })
    owners = createPersistentCandidateOwners({
      dataRoot: root,
      configRoot,
      getClient: async () => client,
      notebook: { service: notebook, rpc, mcpEntryPath }
    })
    expect((await owners.exportResult(record)).files).toEqual(result.files)
    expect(provider.stats.requests).toBe(calls)
  },
  120_000
)
