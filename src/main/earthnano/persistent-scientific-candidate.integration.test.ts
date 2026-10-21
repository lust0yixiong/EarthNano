import { createCandidateOwnerTestPorts } from '../../../test/earthnano/candidate-owner-ports'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
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
import type { ExecutionRecord, ExecutionRequest } from '../../shared/earthnano/execution-port'
import { notebookToolsForLanguage } from '../../shared/earthnano/notebook-profile'

import type { CandidateArtifactFile } from '../../shared/earthnano/candidate-artifact'
const textContent = (file: CandidateArtifactFile): string => {
  expect('content' in file).toBe(true)
  if (!('content' in file)) throw new Error('Expected original text artifact fixture')
  return file.content
}

configureTestRuntimeMetadata()
it.skipIf(process.platform === 'win32').for([
  {
    notebookLanguage: 'python' as const,
    displayLanguage: 'Python',
    runtimeCommand: process.env.EARTHNANO_RESEARCH_PYTHON
  },
  {
    notebookLanguage: 'r' as const,
    displayLanguage: 'R',
    runtimeCommand: process.env.EARTHNANO_RESEARCH_R
  },
  {
    notebookLanguage: 'r' as const,
    displayLanguage: 'R binary',
    runtimeCommand: process.env.EARTHNANO_RESEARCH_R,
    scientificBinary: true
  }
])(
  'runs the original $displayLanguage MCP and producer owners against an old fixed source Version in one Core',
  { timeout: 120_000 },
  async (scenario, context) => {
    const { notebookLanguage, displayLanguage, runtimeCommand } = scenario
    const scientificBinary = 'scientificBinary' in scenario && scenario.scientificBinary
    const evidenceDirectory = scientificBinary
      ? process.env.EARTHNANO_BINARY_SCIENTIFIC_EVIDENCE_DIR
      : undefined
    if (!runtimeCommand) return context.skip()
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
    const sourceName = scientificBinary ? 'measurements.rds' : 'measurements.csv'
    const sourceMime = scientificBinary ? 'application/octet-stream' : 'text/csv'
    const source = join(root, sourceName)
    let content: string | Buffer = 'sample,value\na,2\nb,4\nc,6\n'
    if (scientificBinary) {
      execFileSync(runtimeCommand, [
        '--vanilla',
        '-e',
        `saveRDS(c(2,4,6), ${JSON.stringify(source)}, version=2)`
      ])
      content = await readFile(source)
    } else await writeFile(source, content)
    const upload = await uploads.stageLocalFile({
      transferId: 'source-upload',
      sourcePath: source,
      name: sourceName,
      mimeType: sourceMime,
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
    let laterContent: string | Buffer = 'sample,value\nchanged,999\n'
    if (scientificBinary) {
      execFileSync(runtimeCommand, [
        '--vanilla',
        '-e',
        `saveRDS(999, ${JSON.stringify(source)}, version=2)`
      ])
      laterContent = await readFile(source)
    } else await writeFile(source, laterContent)
    const stagedLater = await uploads.stageLocalFile({
      transferId: 'later-source',
      sourcePath: source,
      name: sourceName,
      mimeType: sourceMime,
      size: Buffer.byteLength(laterContent)
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
    const interpreter = await realpath(runtimeCommand)
    await settings.addManualInterpreter(notebookLanguage, interpreter)
    await settings.setEnvironmentEnabled(notebookLanguage, interpreter, true)
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
    const inputAuthority = new ImmutableInputAuthority({
      storageRoot: root,
      managedFileVersions: versions
    })
    const stagedInputEvidence: Array<{
      sessionId: string
      path: string
      checksum: string
      size: number
    }> = []
    if (scientificBinary) {
      const originalStage = inputAuthority.stageContent.bind(inputAuthority)
      vi.spyOn(inputAuthority, 'stageContent').mockImplementation(async (...args) => {
        const path = await originalStage(...args)
        const bytes = await readFile(path)
        expect(bytes).toEqual(content)
        const checksum = createHash('sha256').update(bytes).digest('hex')
        expect(checksum).toBe(managedInput.checksum)
        stagedInputEvidence.push({ sessionId: args[1], path, checksum, size: bytes.length })
        return path
      })
    }
    const rpc = new NotebookLocalRpcServer(notebook, {
      transport: 'tcp',
      artifactProvenance: provenance,
      inputRegistry: new NotebookInputRegistry({
        storageRoot: root,
        inputAuthority
      })
    })
    let owners = createPersistentCandidateOwners({
      ...createCandidateOwnerTestPorts({
        dataRoot: root,
        configRoot,
        getClient: async () => client,
        repository: sessions
      }),
      dataRoot: root,
      configRoot,
      getClient: async () => client,
      notebook: { service: notebook, rpc, mcpEntryPath },
      ...(scientificBinary ? { artifactProjectionRoot: join(root, 'artifact-projections') } : {})
    })
    const provider = await createEarthnanoMessagesProvider(false, true, false, {
      scientificLanguage: notebookLanguage,
      ...(scientificBinary ? { scientificBinary: true } : {})
    })
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
    ).runtimes.find((entry) => entry.runtimeId === interpreter)!
    expect(binding).toMatchObject({
      language: notebookLanguage,
      runtimeId: interpreter,
      runnable: true
    })
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
        prompt: scientificBinary
          ? 'Use readRDS and base R to compute count, sum and mean for the fixed measurements.rds and publish research-results.json plus measurements.png using the real Notebook producer.'
          : notebookLanguage === 'r'
            ? 'Use read.csv and base R to compute count, sum and mean for measurements.csv and publish research-results.json.'
            : 'Use csv and statistics to compute count, sum and mean for measurements.csv and publish research-results.json.',
        files: [],
        managedInputs: [managedInput]
      },
      harness: {
        instructions: `Analyze the original fixed input with Notebook ${displayLanguage}; publish a real producer report.`,
        skills: [],
        tools: notebookToolsForLanguage(notebookLanguage)
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
            language,
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
      mission: `Compute the scientific task using the original ${displayLanguage} tools.`
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
    core.configureBudget(projectId, request.budgetRef, notebookLanguage === 'r' ? 2 : 1)
    let baseline: ExecutionRecord | undefined
    if (notebookLanguage === 'r') {
      const baselineHandle = await core.submit({
        ...request,
        role: 'baseline',
        requestKey: 'scientific-baseline',
        origin: { ...request.origin, stageId: 'baseline' }
      })
      baseline = await core.waitForTerminal(baselineHandle.executionId)
      expect(baseline, JSON.stringify(baseline)).toMatchObject({
        phase: 'completed',
        cleanup: 'confirmed'
      })
      expect(baseline.request).toMatchObject({
        ...refs,
        invocationRef,
        role: 'baseline'
      })
    }
    const handle = await core.submit(request)
    const record = await core.waitForTerminal(handle.executionId)
    expect(record, JSON.stringify(record)).toMatchObject({
      phase: 'completed',
      cleanup: 'confirmed'
    })
    if (notebookLanguage === 'python') {
      expect(Object.keys(state.records)).toEqual([record.executionId])
      expect(Object.values(state.budgets)).toEqual([{ limit: 1, admitted: 1 }])
    } else {
      expect(Object.keys(state.records)).toEqual([baseline!.executionId, record.executionId])
      expect(Object.values(state.budgets)).toEqual([{ limit: 2, admitted: 2 }])
      expect(baseline!.identity.sessionId).not.toBe(record.identity.sessionId)
      expect(baseline!.identity.promptMessageId).not.toBe(record.identity.promptMessageId)
      expect(baseline!.identity.runtimeExecutionId).not.toBe(record.identity.runtimeExecutionId)
      expect(baseline!.identity.sessionId).not.toBe(sourceSessionId)
      expect(record.identity.sessionId).not.toBe(sourceSessionId)
      if (scientificBinary) {
        for (const target of [baseline!, record]) {
          const exported = await owners.exportResult(target)
          expect(exported.files.map((file) => file.path).sort()).toEqual([
            'measurements.png',
            'research-results.json'
          ])
          expect(
            JSON.parse(
              textContent(exported.files.find((file) => file.path === 'research-results.json')!)
            )
          ).toEqual({ count: 3, sum: 12, mean: 4 })
        }
      } else
        expect((await owners.exportResult(baseline!)).files.map(textContent)).toEqual(
          (await owners.exportResult(record)).files.map(textContent)
        )
      const baselineRuns = await new NotebookRunRepository(root).readSessionRuns(
        projectId,
        baseline!.identity.sessionId!
      )
      expect(baselineRuns).toHaveLength(1)
      expect(baselineRuns[0]).toMatchObject({
        kernelKind: 'r',
        status: 'completed',
        executionInvocationId: expect.any(String),
        inputFiles: [expect.objectContaining(managedInput)]
      })
      expect(baseline!.evidence.artifacts).toHaveLength(scientificBinary ? 2 : 1)
      const baselineVersion = await client.artifactVersion.findUniqueOrThrow({
        where: { id: baseline!.evidence.artifacts[0].versionId }
      })
      expect(baselineVersion).toMatchObject({
        producerRunId: baselineRuns[0].runId,
        notebookSessionId: baseline!.identity.sessionId,
        promptMessageId: baseline!.identity.promptMessageId,
        filename: 'research-results.json',
        state: 'finalized'
      })
      expect(baselineRuns[0].frozenRuntimeTarget).toMatchObject({
        language,
        runtimeId,
        source: runtimeSource,
        interpreterPath
      })
      expect(
        (
          await notebook.listRuntimes({
            projectId,
            sessionId: baseline!.identity.sessionId!,
            workspaceCwd: root
          })
        ).bindings[notebookLanguage]
      ).toMatchObject({
        language,
        runtimeId,
        source: runtimeSource,
        provenance: runtimeProvenance,
        interpreterPath,
        ...(version ? { version } : {})
      })
      expect(baselineRuns[0].runtimeId ?? baselineRuns[0].frozenRuntimeTarget?.runtimeId).toBe(
        runtimeId
      )
      expect(baselineRuns[0].promptMessageId).toBe(baseline!.identity.promptMessageId)
    }
    expect(record.evidence.artifacts).toHaveLength(scientificBinary ? 2 : 1)
    const result = await owners.exportResult(record)
    expect(
      JSON.parse(
        textContent(
          scientificBinary
            ? result.files.find((file) => file.path === 'research-results.json')!
            : result.files[0]!
        )
      )
    ).toEqual({ count: 3, sum: 12, mean: 4 })
    const runs = await new NotebookRunRepository(root).readSessionRuns(
      projectId,
      record.identity.sessionId!
    )
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      kernelKind: notebookLanguage,
      status: 'completed',
      executionInvocationId: expect.any(String),
      inputFiles: [expect.objectContaining(managedInput)]
    })
    expect(runs[0].runtimeId ?? runs[0].frozenRuntimeTarget?.runtimeId).toBe(runtimeId)
    expect(runs[0].frozenRuntimeTarget).toMatchObject({
      language,
      runtimeId,
      source: runtimeSource,
      interpreterPath
    })
    expect(
      (
        await notebook.listRuntimes({
          projectId,
          sessionId: record.identity.sessionId!,
          workspaceCwd: root
        })
      ).bindings[notebookLanguage]
    ).toMatchObject({
      language,
      runtimeId,
      source: runtimeSource,
      provenance: runtimeProvenance,
      interpreterPath,
      ...(version ? { version } : {})
    })
    expect(runs[0].promptMessageId).toBe(record.identity.promptMessageId)
    if (baseline) {
      const prior = await client.artifactVersion.findUniqueOrThrow({
        where: { id: baseline.evidence.artifacts[0].versionId }
      })
      expect(prior.producerRunId).not.toBe(runs[0].runId)
    }
    const versionRow = await client.artifactVersion.findUniqueOrThrow({
      where: { id: record.evidence.artifacts[0].versionId }
    })
    expect(versionRow).toMatchObject({
      producerRunId: runs[0].runId,
      notebookSessionId: record.identity.sessionId,
      promptMessageId: record.identity.promptMessageId,
      filename: 'research-results.json',
      state: 'finalized'
    })
    const binaryOutputEvidence: Array<{
      role: ExecutionRequest['role']
      executionId: string
      producerRunId: string
      artifactRef: ExecutionRecord['evidence']['artifacts'][number]
      sizeBytes: number
      checksum: string
      projectionPath: string
      inputProjectionPath: string
    }> = []
    if (scientificBinary) {
      for (const target of [baseline!, record]) {
        const targetRuns = await new NotebookRunRepository(root).readSessionRuns(
          projectId,
          target.identity.sessionId!
        )
        expect(targetRuns).toHaveLength(1)
        expect(targetRuns[0].script).toContain('readRDS(')
        expect(targetRuns[0].script).toContain("grDevices::png('measurements.png'")
        expect(
          stagedInputEvidence.some(
            (entry) =>
              entry.sessionId === target.identity.sessionId &&
              entry.checksum === managedInput.checksum &&
              entry.size === managedInput.sizeBytes
          )
        ).toBe(true)
        const exported = await owners.exportResult(target)
        const image = exported.files.find((file) => file.path === 'measurements.png')!
        if (!('representation' in image))
          throw new Error('Original PNG did not export a binary descriptor')
        expect(image).toMatchObject({
          representation: 'binary',
          contentType: 'image/png',
          sizeBytes: expect.any(Number)
        })
        expect(image).not.toHaveProperty('content')
        const pngLease = await versions.openVersion(
          { source: 'artifact', projectId, fileId: image.artifactRef.artifactId },
          image.artifactRef.versionId
        )
        let bytes: Buffer
        try {
          bytes = Buffer.from(await pngLease.readRange(0, pngLease.size))
          expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          expect(bytes.length).toBe(image.sizeBytes)
          expect('sha256:' + createHash('sha256').update(bytes).digest('hex')).toBe(image.digest)
          expect(pngLease.version.checksum).toBe(image.artifactRef.checksum)
          await pngLease.verifyUnchanged()
        } finally {
          await pngLease.close()
        }
        for (const artifact of target.evidence.artifacts) {
          const row = await client.artifactVersion.findUniqueOrThrow({
            where: { id: artifact.versionId }
          })
          expect(row).toMatchObject({
            artifactId: artifact.artifactId,
            checksum: artifact.checksum,
            producerRunId: targetRuns[0].runId,
            notebookSessionId: target.identity.sessionId,
            promptMessageId: target.identity.promptMessageId,
            state: 'finalized'
          })
          const original = await provenance.getVersionExecution({
            projectId,
            appSessionId: target.identity.sessionId!,
            artifactId: artifact.artifactId,
            versionId: artifact.versionId
          })
          expect(original.execution).toMatchObject({
            producerRunId: targetRuns[0].runId,
            terminalPromptMessageId: target.identity.promptMessageId
          })
        }
        const materialized = await owners.materializeArtifact!(target, image.artifactRef)
        expect(materialized.file).toEqual(image)
        expect(await readFile(materialized.assetPath)).toEqual(bytes)
        const assetSnapshots = await createCandidateSnapshotStore({
          root: join(root, `binary-context-snapshots-${target.request.role}`),
          candidatesRoot: join(root, `binary-contexts-${target.request.role}`),
          materializeAsset: (asset, signal) => {
            expect(asset.sourceExecutionId).toBe(target.executionId)
            expect(asset.artifact).toEqual(image)
            return owners.materializeArtifact!(target, asset.artifact.artifactRef, signal)
          }
        })
        const assetRefs = await assetSnapshots.freeze({
          task: { prompt: 'Inspect the fixed anonymous image.', files: [] },
          harness: {
            instructions: 'Read the supplied image asset.',
            skills: [],
            tools: 'workspace-only'
          },
          agent: (await snapshots.resolve(request)).agent,
          environment: { isolation: 'directory-process', network: 'provider-only' }
        })
        const assetInvocation = await assetSnapshots.freezeInvocation({
          taskSnapshotRef: assetRefs.taskSnapshotRef,
          harnessRevisionRef: assetRefs.harnessRevisionRef,
          mission: 'Inspect the original binary Version.',
          assets: [
            {
              path: 'assets/measurements.png',
              sourceExecutionId: target.executionId,
              artifact: image
            }
          ]
        })
        const input = await assetSnapshots.materialize({
          executionId: 'image-consumer',
          refs: { ...assetRefs, invocationRef: assetInvocation }
        })
        const inputProjectionPath = join(input.inputDir, 'assets', 'measurements.png')
        expect(await readFile(inputProjectionPath)).toEqual(bytes)
        expect(input.manifest).toContainEqual({
          path: 'workspace/inputs/assets/measurements.png',
          digest: image.digest,
          bytes: image.sizeBytes
        })
        binaryOutputEvidence.push({
          role: target.request.role,
          executionId: target.executionId,
          producerRunId: targetRuns[0].runId,
          artifactRef: image.artifactRef,
          sizeBytes: image.sizeBytes,
          checksum: image.artifactRef.checksum,
          projectionPath: materialized.assetPath,
          inputProjectionPath
        })
        if (evidenceDirectory) {
          await mkdir(evidenceDirectory, { recursive: true })
          await writeFile(join(evidenceDirectory, `${target.request.role}-measurements.png`), bytes)
        }
      }
    }
    for (const target of baseline ? [baseline, record] : [record]) {
      for (const artifact of target.evidence.artifacts) {
        const inputs = await client.artifactVersionInput.findMany({
          where: { artifactVersionId: artifact.versionId }
        })
        expect(
          inputs,
          JSON.stringify({
            role: target.request.role,
            notebookRuns: await new NotebookRunRepository(root).readSessionRuns(
              projectId,
              target.identity.sessionId!
            )
          })
        ).toHaveLength(1)
        expect(inputs[0]).toMatchObject({
          sourceKind: 'upload-version',
          inputFileVersionId: managedInput.inputFileVersionId,
          sourceUploadVersionId: managedInput.inputFileVersionId,
          sourceProjectId: projectId,
          sourceSessionId,
          sourceFileId: fixed.id,
          checksum: managedInput.checksum,
          sizeBytes: BigInt(managedInput.sizeBytes)
        })
      }
    }
    expect(
      (await client.uploadFile.findUniqueOrThrow({ where: { id: fixed.id } })).currentVersionId
    ).toBe(later.versionId)
    const frozen = await snapshots.resolve(request)
    const expectedPrompt = `${frozen.task.prompt}\n\n${frozen.invocation.mission}\n\n${
      notebookLanguage === 'r'
        ? 'Use the bound R Notebook (execute with explicit language:r)'
        : 'Use the bound Python Notebook'
    } and the fixed Notebook input versions listed below. Publish bounded artifacts (data, figures or reports) with write_artifact_file and the real producerRunId. The host has pinned the runtime; do not bind or switch it, install packages, use Shell or start background work.`
    const readPrompt = async (target: ExecutionRecord): Promise<string | undefined> => {
      const persisted = await loadSessionMutationAuthority(
        sessions,
        projectId,
        target.identity.sessionId!
      )
      expect(persisted.status).toBe('found')
      if (persisted.status !== 'found') throw new Error('Scientific Session is unavailable')
      return persisted.session.messages.find(
        (message) => message.id === target.identity.promptMessageId
      )?.content
    }
    // Python is the original owner-composed prompt byte for byte. Both R roles receive the
    // same task/mission and explicit R requirement through their independent original Sessions.
    expect(await readPrompt(record)).toBe(expectedPrompt)
    if (baseline) expect(await readPrompt(baseline)).toBe(expectedPrompt)
    for (const target of baseline ? [baseline, record] : [record]) {
      expect(
        await client.uploadFile.count({ where: { sessionId: target.identity.sessionId! } })
      ).toBe(0)
    }
    const sourceEvidence = await owners.readSemanticSourceEvidence({ target: record, snapshots })
    expect(sourceEvidence.inputs).toHaveLength(1)
    expect(sourceEvidence.inputs[0].status).toBe(scientificBinary ? 'unavailable' : 'available')
    expect(sourceEvidence.inputs[0].input.inputFileVersionId).toBe(managedInput.inputFileVersionId)
    if (scientificBinary) {
      expect(sourceEvidence.inputs[0]).toMatchObject({
        status: 'unavailable',
        reason: 'binary-or-invalid-utf8'
      })
      expect(sourceEvidence.inputs[0]).not.toHaveProperty('content')
    } else
      expect(sourceEvidence.inputs[0]).toMatchObject({
        status: 'available',
        content
      })
    const reviews = await owners.readReviews(record)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({
      outcome: 'pass',
      sessionId: record.identity.sessionId,
      turnMessageId: record.identity.promptMessageId
    })
    const baselineSourceEvidence = baseline
      ? await owners.readSemanticSourceEvidence({ target: baseline, snapshots })
      : undefined
    const baselineReviews = baseline ? await owners.readReviews(baseline) : undefined
    const baselineResult = baseline ? await owners.exportResult(baseline) : undefined
    if (baseline) {
      expect(baselineSourceEvidence).toEqual(sourceEvidence)
      expect(baselineReviews).toHaveLength(1)
      expect(baselineReviews![0]).toMatchObject({
        outcome: 'pass',
        sessionId: baseline.identity.sessionId,
        turnMessageId: baseline.identity.promptMessageId
      })
      expect(baselineReviews![0].id).not.toBe(reviews[0].id)
      expect(baseline.evidence.artifacts[0].artifactId).not.toBe(
        record.evidence.artifacts[0].artifactId
      )
      expect(baseline.evidence.artifacts[0].versionId).not.toBe(
        record.evidence.artifacts[0].versionId
      )
    }
    const calls = provider.stats.requests
    expect(await owners.shutdown()).toEqual({ reaped: true })
    if (scientificBinary) expect(await readdir(join(root, 'artifact-projections'))).toEqual([])
    owners = createPersistentCandidateOwners({
      ...createCandidateOwnerTestPorts({
        dataRoot: root,
        configRoot,
        getClient: async () => client,
        repository: sessions
      }),
      dataRoot: root,
      configRoot,
      getClient: async () => client,
      notebook: { service: notebook, rpc, mcpEntryPath },
      ...(scientificBinary ? { artifactProjectionRoot: join(root, 'artifact-projections') } : {})
    })
    expect(await owners.readSemanticSourceEvidence({ target: record, snapshots })).toEqual(
      sourceEvidence
    )
    expect((await owners.exportResult(record)).files).toEqual(result.files)
    expect(await owners.readReviews(record)).toEqual(reviews)
    expect(await readPrompt(record)).toBe(expectedPrompt)
    if (baseline) {
      expect(await owners.readSemanticSourceEvidence({ target: baseline, snapshots })).toEqual(
        baselineSourceEvidence
      )
      expect((await owners.exportResult(baseline)).files).toEqual(baselineResult!.files)
      expect(await owners.readReviews(baseline)).toEqual(baselineReviews)
      expect(await readPrompt(baseline)).toBe(expectedPrompt)
    }
    if (scientificBinary) {
      for (const target of [baseline!, record]) {
        const previous = binaryOutputEvidence.find(
          (entry) => entry.executionId === target.executionId
        )!
        const reopened = await owners.materializeArtifact!(target, previous.artifactRef)
        const bytes = await readFile(reopened.assetPath)
        expect(bytes.length).toBe(previous.sizeBytes)
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(previous.checksum)
      }
    }
    expect(provider.stats.requests).toBe(calls)

    for (const scenario of ['tampered-source', 'changed-runtime', 'disabled-runtime'] as const) {
      if (scenario === 'disabled-runtime')
        await settings.setEnvironmentEnabled(
          notebookLanguage,
          frozen.environment.notebook!.runtime.runtimeId,
          false
        )
      const rejectedRefs = await snapshots.freeze({
        task:
          scenario === 'tampered-source'
            ? { ...frozen.task, managedInputs: [{ ...managedInput, checksum: 'f'.repeat(64) }] }
            : frozen.task,
        harness: frozen.harness,
        agent: frozen.agent,
        environment:
          scenario === 'changed-runtime'
            ? {
                ...frozen.environment,
                notebook: {
                  runtime: {
                    ...frozen.environment.notebook!.runtime,
                    version: '0.0.0-unavailable'
                  }
                }
              }
            : frozen.environment
      })
      const rejectedInvocation = await snapshots.freezeInvocation({
        taskSnapshotRef: rejectedRefs.taskSnapshotRef,
        harnessRevisionRef: rejectedRefs.harnessRevisionRef,
        mission: frozen.invocation.mission
      })
      const rejection: ExecutionRequest = {
        ...request,
        ...rejectedRefs,
        invocationRef: rejectedInvocation,
        requestKey: scenario,
        budgetRef: scenario
      }
      core.configureBudget(projectId, scenario, 1)
      const beforeReject = provider.stats.requests
      const rejectedHandle = await core.submit(rejection)
      const rejected = await core.waitForTerminal(rejectedHandle.executionId)
      expect(rejected).toMatchObject({
        phase: 'failed',
        cleanup: 'confirmed',
        error: { code: 'candidate-preparation-failed' }
      })
      expect(rejected.evidence.artifacts).toEqual([])
      expect(provider.stats.requests).toBe(beforeReject)
    }
    expect(provider.stats.upstreamRequests).toBe(0)
    if (evidenceDirectory) {
      await writeFile(
        join(evidenceDirectory, 'r-binary-scientific.json'),
        JSON.stringify(
          {
            source:
              'Original managedInputs -> NotebookInputRegistry -> ImmutableInputAuthority -> R readRDS',
            fixedInput: managedInput,
            laterHeadVersionId: later.versionId,
            fixedSourceChecksum: createHash('sha256').update(content).digest('hex'),
            laterSourceChecksum: createHash('sha256').update(laterContent).digest('hex'),
            frozenRuntime: frozen.environment.notebook!.runtime,
            baseline,
            candidate: record,
            baselineRuns: await new NotebookRunRepository(root).readSessionRuns(
              projectId,
              baseline!.identity.sessionId!
            ),
            candidateRuns: runs,
            originalProducerVersions: await client.artifactVersion.findMany({
              where: {
                id: {
                  in: [...baseline!.evidence.artifacts, ...record.evidence.artifacts].map(
                    (artifact) => artifact.versionId
                  )
                }
              }
            }),
            originalUsedInputs: await client.artifactVersionInput.findMany({
              where: {
                artifactVersionId: {
                  in: [...baseline!.evidence.artifacts, ...record.evidence.artifacts].map(
                    (artifact) => artifact.versionId
                  )
                }
              }
            }),
            binaryOutputEvidence,
            stagedInputEvidence,
            semanticSourceEvidence: sourceEvidence,
            baselineResult,
            candidateResult: result,
            originalIntegrityReviews: { baseline: baselineReviews, candidate: reviews },
            providerStats: provider.stats,
            ownerReopenedWithoutProviderReplay: provider.stats.requests === calls,
            limitations: [
              'Source RDS is explicitly unavailable to the text-only semantic assessor; no binary scientific assessment or visual interpretation is claimed.'
            ]
          },
          (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
          2
        ) + '\n'
      )
    }
  }
)
