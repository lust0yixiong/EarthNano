import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
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
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false } }))
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { createCandidateOwnerTestPorts } from '../../../test/earthnano/candidate-owner-ports'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { initDataRoot } from '../storage-root'
import { SessionRepository, loadSessionMutationAuthority } from '../session-persistence/repository'
import { resolveTurnOutcome } from '../../shared/session-persistence'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ArtifactRepository } from '../artifacts/repository'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { NotebookInputRegistry } from '../notebook/input-registry'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import { getNotebookDataRoot, NotebookRunRepository } from '../notebook/repository'
import { ComputeHostRepository } from '../compute/repository'
import { ComputeJobRepository } from '../compute/job-repository'
import { ComputeJobOperationRepository } from '../compute/compute-job-operation-repository'
import { ComputeService } from '../compute/compute-service'
import { AgentComputeService } from '../compute/agent-compute-service'
import { EnabledComputeHostsRegistry } from '../compute/enabled-hosts-registry'
import { SessionEnabledComputeHostsOwner } from '../compute/session-enabled-hosts-owner'
import { ApplicationEventHub, type ApplicationEventSource } from '../application-events'
import { BackgroundResultDeliveryRepository } from '../background-result-delivery/repository'
import { BackgroundResultDeliveryOwner } from '../background-result-delivery/owner'
import { ComputeJobResultDeliveryAdapter } from '../background-result-delivery/compute-adapter'
import { resolveBackgroundResultSources } from '../background-result-delivery/source-resolver'
import { routeCandidateContinuations } from '../composition/background-results'
import { toJobSummary } from '../compute/ipc'
import { freezeComputeContext } from './compute-context'
import { createCandidateSnapshotStore } from './candidate-snapshot'
import { createPersistentCandidateOwners } from './persistent-candidate-owner'
import {
  createClaudeCandidateDriver,
  type ClaudeCandidateDriverOptions
} from './claude-candidate-driver'
import { ExecutionCore } from './execution-core'
import { FileExecutionStore } from './execution-store'
import type { ExecutionRequest } from '../../shared/earthnano/execution-port'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWOQAAAAASUVORK5CYII=',
  'base64'
)
type Block = { type: string; name?: string; content?: unknown; input?: Record<string, unknown> }
type Body = {
  model: string
  tools?: { name: string }[]
  messages: { role: string; content: string | Block[] }[]
}
const emit = (
  response: ServerResponse,
  model: string,
  content: { text: string } | { name: string; input: object }
): void => {
  const tool = 'name' in content
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'local-fixture',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 }
        }
      }
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: tool
          ? { type: 'tool_use', id: `local-${Date.now()}`, name: content.name, input: {} }
          : { type: 'text', text: '' }
      }
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: tool
          ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) }
          : { type: 'text_delta', text: content.text }
      }
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 }
      }
    ],
    ['message_stop', { type: 'message_stop' }]
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  )
}
const nestedRunIds = (value: unknown): string[] => {
  if (typeof value === 'string') {
    try {
      return nestedRunIds(JSON.parse(value))
    } catch {
      return []
    }
  }
  if (Array.isArray(value)) return value.flatMap(nestedRunIds)
  if (!value || typeof value !== 'object') return []
  const object = value as Record<string, unknown>
  return [
    ...(typeof object.runId === 'string' ? [object.runId] : []),
    ...(object.activityKind === 'notebook-run' && typeof object.activityId === 'string'
      ? [object.activityId]
      : []),
    ...Object.values(object).flatMap(nestedRunIds)
  ]
}

configureTestRuntimeMetadata()

// This fixture exercises real native ACP, original Node REPL/RPC, SQLite Job/delivery owners,
// producer capture, Version leases and Reviews. Only the remote submit/harvest transport is injected.
it.each([
  'complete',
  'continuation-failure',
  'tool-failure-repaired',
  'multi-batch',
  'stop-continuation',
  'prepare-failure',
  'stop-unknown',
  'source-revoked'
] as const)(
  'joins original Compute lifecycle (%s) without replacing initial identity',
  async (mode) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'earthnano-compute-owner-')))
    initDataRoot(root)
    const configRoot = join(root, 'config')
    await mkdir(configRoot)
    const client = createProjectDbClient(configRoot)
    await migrateApplicationDatabase(client)
    const projectId = 'compute-project',
      sourceSessionId = 'compute-source'
    await client.project.create({
      data: { id: projectId, name: 'Original local Compute owner fixture' }
    })
    const sessions = new SessionRepository(configRoot)
    const ports = createCandidateOwnerTestPorts({
      dataRoot: root,
      configRoot,
      getClient: async () => client,
      repository: sessions
    })
    const source = await ports.sessionPersistence.coordinator.saveSession({
      id: sourceSessionId,
      projectId,
      title: 'Source',
      cwd: root,
      status: 'idle',
      messages: [],
      enabledComputeHosts: ['ssh:fixture'],
      selectedComputeHosts: [],
      createdAt: 1,
      updatedAt: 1
    })
    const hosts = new ComputeHostRepository(async () => client)
    await hosts.create({
      sshAlias: 'fixture',
      displayName: 'Owned fixture',
      executionMode: 'direct_ssh'
    })
    const frozenCompute = await freezeComputeContext({ source, hosts })
    const registry = new EnabledComputeHostsRegistry()
    const hostAccess = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async (id) => Boolean(await hosts.get(id)),
      listHostIds: async () => ['ssh:fixture'],
      sessionAuthority: {
        sessionProjectId: async (id) =>
          (await sessions.loadSessionSummaries()).find((session) => session.id === id)?.projectId,
        setSessionEnabledComputeHosts: async () => {
          throw new Error('Unexpected preference mutation')
        },
        pruneSessionEnabledComputeHosts: async () => ({ sessions: [], previousSelections: [] })
      },
      withDataRootWrite: async (work) => work()
    })
    const jobs = new ComputeJobRepository(async () => client)
    const operations = new ComputeJobOperationRepository(async () => client)
    const events = new ApplicationEventHub()
    const deliveries = new BackgroundResultDeliveryRepository(async () => client)
    const service = new ComputeService({
      repository: hosts,
      jobRepository: jobs,
      operationRepository: operations,
      runner: {
        run: async () => {
          throw new Error('No external SSH permitted in owner fixture')
        }
      }
    })
    let privateId: string | undefined
    let submissionCount = 0
    const submit = vi
      .spyOn(service, 'submitJob')
      .mockImplementation(async (providerId, intent, command, _options, context) => {
        expect(context.interactionPolicy).toBe('deny-unresolved')
        expect(context.sessionId).not.toBe(sourceSessionId)
        expect(context.producerRunId).toBeTruthy()
        privateId = context.sessionId
        const job = await jobs.create({
          id: submissionCount++ === 0 ? 'owned-job' : 'owned-job-2',
          providerId,
          shape: 'direct_ssh',
          executionMode: 'direct_ssh',
          sessionId: context.sessionId,
          projectId: context.projectId,
          intent,
          command,
          commandHash: createHash('sha256').update(command).digest('hex'),
          producerRunId: context.producerRunId,
          allowUnencryptedPersistence: true,
          initialStatus: 'submitted',
          remoteWorkdir: '/fixture/.open-science/jobs/owned-job'
        })
        return {
          job_id: job.job_id,
          provider_id: providerId,
          status: 'submitted',
          remote_workdir: job.remote_workdir!
        }
      })
    const cancel = vi.spyOn(service, 'cancelJob')
    const agentCompute = new AgentComputeService(service, registry, {
      onFinalJobObserved: async (_context, _providerId, snapshot) => {
        const job = await jobs.get(snapshot.job_id)
        if (!job) throw new Error('Original result Job missing')
        return adapter.observeResult(await toJobSummary(job, 'Owned fixture', root))
      }
    })
    const versions = new ManagedFileVersionService({
      storageRoot: root,
      getClient: async () => client
    })
    const provenance = new ArtifactProvenanceRepository({
      storageRoot: root,
      getClient: async () => client,
      compatibilityRepository: new ArtifactRepository(root),
      loadSession: async (project, id) => {
        const loaded = await loadSessionMutationAuthority(sessions, project, id)
        if (loaded.status !== 'found') throw new Error('Missing original fixture Session')
        return loaded.session
      }
    })
    const notebook = new NotebookRuntimeService({
      configRoot,
      dataRoot: root,
      projectId,
      backgroundExecutionEnabled: false
    })
    notebook.setExecutionApproval(async () => false)
    const rpc = new NotebookLocalRpcServer(notebook, {
      transport: 'tcp',
      artifactProvenance: provenance,
      computeService: agentCompute,
      inputRegistry: new NotebookInputRegistry({
        storageRoot: root,
        inputAuthority: new ImmutableInputAuthority({
          storageRoot: root,
          managedFileVersions: versions
        })
      })
    })
    const mcpEntryPath = join(root, 'original-mcp.cjs')
    await writeFile(
      mcpEntryPath,
      `const jiti=require(${JSON.stringify(createRequire(import.meta.url).resolve('jiti'))}).createJiti(__filename);(async()=>{const notebook=process.argv.includes('--open-science-notebook-mcp');const api=await jiti.import(notebook?${JSON.stringify(resolve('src/main/notebook/mcp-server.ts'))}:${JSON.stringify(resolve('src/main/artifacts/mcp-server.ts'))});await (notebook?api.runNotebookMcpServer():api.runArtifactMcpServer())})().catch(()=>process.exitCode=1);`
    )
    const createOwners = (): ReturnType<typeof createPersistentCandidateOwners> =>
      createPersistentCandidateOwners({
        ...ports,
        dataRoot: root,
        configRoot,
        getClient: async () => client,
        artifactProjectionRoot: join(root, 'projections'),
        notebook: { service: notebook, rpc, mcpEntryPath },
        compute: {
          hosts,
          hostAccess,
          jobs,
          operations,
          service,
          deliveries,
          events: events as ApplicationEventSource,
          cancelApprovals: vi.fn()
        }
      })
    if (mode === 'prepare-failure')
      vi.spyOn(notebook, 'registerHostPermissionPolicy').mockImplementation(() => {
        throw new Error('Fixture post-persistence preparation failure')
      })
    let owners = createOwners()
    notebook.setMcpRpcConnectionResolver(async (binding) =>
      rpc.issueControlConnection(
        binding.sessionId,
        binding.projectId,
        binding.agentFrameId,
        { role: 'main' },
        binding.executionCwd,
        await owners.resolveControlPolicy!(binding)
      )
    )
    const route = routeCandidateContinuations(
      {
        sendContinuation: () => {
          throw new Error('Private owner must never use ordinary Send')
        },
        isContinuationSaved: async () => {
          throw new Error('Private owner must never read ordinary Session')
        },
        canStartSessionTurn: () => {
          throw new Error('Private owner must never use ordinary admission')
        }
      },
      (id) => owners.resolveCandidateDelivery!(id)
    )
    const deliveryOwner = new BackgroundResultDeliveryOwner({
      repository: deliveries,
      ...route,
      waitForAuthoritiesReady: async () => {},
      onChanged: (event) => events.publish('background-result-delivery:changed', event),
      resolveSources: (rows) =>
        resolveBackgroundResultSources(rows, {
          loadNotebookRuns: async () => [],
          loadComputeJobs: async (sources) =>
            new Map(
              await Promise.all(
                sources.map(async ({ sourceId }) => {
                  const job = await jobs.get(sourceId)
                  if (!job) throw new Error('Missing original Job')
                  return [sourceId, await toJobSummary(job, 'Owned fixture', root)] as const
                })
              )
            )
        })
    })
    // dispose stops scheduling but the original owner deliberately keeps in-flight drains alive.
    // Join their actual promises before disconnecting/deleting this fixture's SQLite database.
    const deliveryDrains: ReturnType<BackgroundResultDeliveryOwner['drainSession']>[] = []
    const drainSession = deliveryOwner.drainSession.bind(deliveryOwner)
    vi.spyOn(deliveryOwner, 'drainSession').mockImplementation((sessionId) => {
      const drain = drainSession(sessionId)
      deliveryDrains.push(drain)
      return drain
    })
    const adapter = new ComputeJobResultDeliveryAdapter({
      register: (source) => deliveryOwner.register(source),
      enqueue: (source) => deliveryOwner.enqueue(source),
      acknowledgeObserved: (source) => deliveryOwner.acknowledgeObserved(source),
      listWaiting: () => deliveries.listWaiting('compute-job'),
      hasDeliveryPath: (kind, id) => deliveries.hasDeliveryPath(kind, id)
    })
    let stage = 0
    let modelRequests = 0
    const providerErrors: string[] = []
    const server = createServer(async (request, response) => {
      try {
        if (request.method === 'HEAD') {
          response.writeHead(200)
          response.end()
          return
        }
        let text = ''
        for await (const chunk of request) text += chunk
        if (request.url?.includes('count_tokens')) {
          response.end(JSON.stringify({ input_tokens: 10 }))
          return
        }
        const body = JSON.parse(text) as Body
        modelRequests += 1
        if (!body.tools?.some((tool) => tool.name.endsWith('repl_execute'))) {
          emit(response, body.model, { text: 'Owned Compute fixture' })
          return
        }
        const call = (suffix: string, input: object): void => {
          const tool = body.tools!.find((tool) => tool.name.endsWith(suffix))
          if (!tool) throw new Error(`Missing original ${suffix}`)
          emit(response, body.model, { name: tool.name, input })
        }
        const runs = nestedRunIds(body.messages)
        let next = stage++
        // Fail the native application Turn after a real control Run and partial Artifact publish,
        // rather than treating an ordinary recoverable Notebook tool error as a failed Turn.
        if (mode === 'continuation-failure' && next >= 5) {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: 'Local fixture terminal continuation failure'
              }
            })
          )
          return
        }
        if (mode === 'tool-failure-repaired') {
          if (next === 3)
            return call('repl_execute', {
              code: `throw new Error('Local fixture recoverable Notebook tool failure');`
            })
          if (next >= 4) next -= 1
        }
        if (next === 0)
          return call('repl_execute', {
            code: `const receipt=await host.compute.create('ssh:fixture').submitJob('owned fixture','printf done'); ${mode === 'multi-batch' ? "await host.compute.create('ssh:fixture').submitJob('owned fixture 2','printf later');" : ''} const fs=require('node:fs'); fs.writeFileSync('receipt.json',JSON.stringify({submitted:true}),{flag:'wx'}); fs.writeFileSync('initial.png',Buffer.from('${png.toString('base64')}','base64'),{flag:'wx'}); console.log(JSON.stringify(receipt));`
          })
        if (next === 1)
          return call('write_artifact_file', {
            filename: 'receipt.json',
            mimeType: 'application/json',
            source: { kind: 'localPath', path: 'receipt.json' },
            producerRunId: runs[0]
          })
        if (next === 2) {
          emit(response, body.model, {
            text: 'Original Job submitted; waiting for its durable outcome.'
          })
          return
        }
        if (next === 3 && mode === 'stop-continuation')
          return call('repl_execute', {
            code: `await new Promise(resolve=>setTimeout(resolve,60_000));`
          })
        if (next === 3)
          return call('repl_execute', {
            code: `const final=await host.compute.create('ssh:fixture').attachJob('owned-job').result(); if(!final.result_final) throw new Error('Original result is not final'); const resultfs=require('node:fs'); resultfs.writeFileSync('result.json',JSON.stringify({answer:JSON.parse(final.stdout_tail).answer}),{flag:'wx'}); resultfs.writeFileSync('figure.png',Buffer.from('${png.toString('base64')}','base64'),{flag:'wx'}); console.log('analysis result persisted');`
          })
        if (next === 4 || next === 5 || next === 6) {
          const filename = next === 4 ? 'result.json' : next === 5 ? 'figure.png' : 'initial.png'
          return call('write_artifact_file', {
            filename,
            mimeType: filename.endsWith('.png') ? 'image/png' : 'application/json',
            source: { kind: 'localPath', path: filename },
            producerRunId: next === 6 ? runs[0] : runs.at(-1)
          })
        }
        emit(response, body.model, { text: 'Original durable Compute analysis is complete.' })
      } catch (error) {
        providerErrors.push(String(error))
        response.statusCode = 500
        response.end('Bounded local fixture failed')
      }
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    let core: ExecutionCore | undefined = undefined
    let journal: FileExecutionStore | undefined
    const journalPath = join(root, 'execution.json')
    onTestFinished(async () => {
      deliveryOwner.dispose()
      core?.dispose()
      const retired = await owners.shutdown()
      await Promise.all(deliveryDrains)
      if (
        retired.reaped &&
        journal &&
        Object.values(journal.load().records).every(
          (record) =>
            ['completed', 'failed', 'cancelled'].includes(record.phase) &&
            record.cleanup === 'confirmed'
        )
      )
        journal.close()
      // Unknown records retain their original lock until this isolated fixture is removed.
      await rpc.close()
      await notebook.dispose()
      await new Promise<void>((done) => server.close(() => done()))
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
      await rm(root, { recursive: true, force: true })
    })
    const store = await createCandidateSnapshotStore({
      root: join(root, 'snapshots'),
      candidatesRoot: join(root, 'candidates')
    })
    const refs = await store.freeze({
      task: { prompt: 'Compute fixture', files: [] },
      harness: {
        instructions: 'Use original Compute, never fabricate its results.',
        skills: [],
        tools: 'notebook-compute'
      },
      agent: {
        backend: 'claude-code',
        model: 'local-fixture',
        providerRef: 'local-only',
        runtimeVersion: '2.1.232'
      },
      environment: {
        isolation: 'directory-process',
        network: 'provider-and-notebook-policy',
        compute: frozenCompute
      }
    })
    const invocationRef = await store.freezeInvocation({
      taskSnapshotRef: refs.taskSnapshotRef,
      harnessRevisionRef: refs.harnessRevisionRef,
      mission: 'Original asynchronous Compute ownership fixture'
    })
    const openOwner = vi.fn<ClaudeCandidateDriverOptions['openOwner']>((input) =>
      owners.openOwner(input)
    )
    const bindCandidate = vi.fn<ClaudeCandidateDriverOptions['binding']>(async (agent) => ({
      executablePath: createRequire(import.meta.url).resolve(
        `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`
      ),
      runtimeVersion: agent.runtimeVersion,
      providerRef: agent.providerRef,
      provider: {
        type: 'custom',
        model: agent.model,
        key: 'local-fixture-token',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        apiEndpoints: ['messages']
      }
    }))
    const createDriver = (): ReturnType<typeof createClaudeCandidateDriver> =>
      createClaudeCandidateDriver({
        snapshots: store,
        openOwner,
        binding: bindCandidate
      })
    journal = new FileExecutionStore(journalPath)
    core = new ExecutionCore(journal, createDriver())
    const request: ExecutionRequest = {
      contractVersion: 1,
      requestKey: 'owner-compute',
      projectId,
      ...refs,
      invocationRef,
      role: 'candidate',
      origin: {
        kind: 'optimization',
        sessionId: sourceSessionId,
        optimizationId: 'compute',
        stageId: 'candidate'
      },
      interactionPolicy: 'deny-unresolved',
      budgetRef: 'one',
      // Preserve the original delivery owner's three attempts; allow them to settle before the
      // Core deadline so this case proves the native failure outcome, not deadline cancellation.
      timeoutMs: mode === 'continuation-failure' ? 75_000 : 45_000
    }
    core.configureBudget(projectId, request.budgetRef, 1)
    const handle = await core.submit(request)
    if (mode === 'prepare-failure') {
      const record = await core.waitForTerminal(handle.executionId)
      expect(record.phase).toBe('failed')
      expect(record.identity).toEqual({
        sessionId: expect.any(String),
        promptMessageId: `candidate-prompt-${handle.executionId}`
      })
      expect(record.identity.runtimeExecutionId).toBeUndefined()
      const persisted = await loadSessionMutationAuthority(
        sessions,
        projectId,
        record.identity.sessionId!
      )
      expect(persisted.status).toBe('found')
      const identities = journal
        .load()
        .events[handle.executionId].filter((event) => event.type === 'identity')
      expect(identities).toHaveLength(1)
      expect(identities[0]).toMatchObject({ identity: record.identity })
      expect(submit).not.toHaveBeenCalled()
      expect(stage).toBe(0)
      expect(modelRequests).toBe(0)
      expect(await jobs.findByOwner({ projectId, sessionId: record.identity.sessionId! })).toEqual(
        []
      )
      return
    }
    await vi.waitFor(
      async () => {
        const record = await core!.get(handle.executionId)
        const runs = record.identity.sessionId
          ? await new NotebookRunRepository(root).readSessionRuns(
              projectId,
              record.identity.sessionId
            )
          : []
        expect(
          submit,
          JSON.stringify({
            phase: record.phase,
            error: record.error,
            stage,
            providerErrors,
            runs: runs.map((run) => ({ status: run.status, diagnostic: run.text.stderr }))
          })
        ).toHaveBeenCalledTimes(mode === 'multi-batch' ? 2 : 1)
      },
      { timeout: 20_000 }
    )
    await vi.waitFor(
      async () => {
        const loaded = await loadSessionMutationAuthority(sessions, projectId, privateId!)
        expect(loaded.status).toBe('found')
        if (loaded.status !== 'found') throw new Error('Missing private Session')
        expect(loaded.session.activeRun).toBeUndefined()
        expect(loaded.session.enabledComputeHosts).toEqual(['ssh:fixture'])
        expect(loaded.session.selectedComputeHosts).toEqual([])
      },
      { timeout: 20_000 }
    )
    const initial = await core.get(handle.executionId)
    expect(initial.phase).toBe('running')
    expect(initial.identity.promptMessageId).toBe(`candidate-prompt-${handle.executionId}`)
    const privateRoute = await owners.resolveCandidateDelivery!(privateId!)
    expect(privateRoute.kind).toBe('private')
    const privateSession = await loadSessionMutationAuthority(sessions, projectId, privateId!)
    if (privateSession.status !== 'found') throw new Error('Missing original private Session')
    const binding = {
      projectId,
      sessionId: privateId!,
      agentFrameId: privateSession.session.conversationGraph!.rootFrameId,
      executionCwd: getNotebookDataRoot(root, projectId, privateId!)
    }
    expect((await owners.resolveControlPolicy!(binding))?.interactionPolicy).toBe('deny-unresolved')
    for (const foreign of [
      { ...binding, executionCwd: root },
      { ...binding, agentFrameId: 'foreign-frame' },
      { ...binding, attemptId: 'foreign-attempt' },
      { ...binding, projectId: 'foreign-project' }
    ])
      await expect(owners.resolveControlPolicy!(foreign)).rejects.toThrow(
        'binding identity mismatch'
      )
    if (privateRoute.kind !== 'private') throw new Error('Missing private route')
    expect(await owners.resolveCandidateDelivery!('unowned-session')).toEqual({ kind: 'ordinary' })
    await expect(
      privateRoute.target.isContinuationSaved({
        sessionId: privateId!,
        deliveryIds: ['foreign-delivery'],
        continuationMessageId: 'foreign-message'
      })
    ).rejects.toThrow('exact original final Job')
    if (mode === 'stop-unknown' || mode === 'source-revoked') {
      if (mode === 'source-revoked') {
        await hosts.updateExecutionMode('ssh:fixture', 'slurm')
        await expect(
          owners.resolveControlPolicy!({
            projectId,
            sessionId: privateId!,
            agentFrameId: initial.identity.sessionId!,
            executionCwd: root
          })
        ).rejects.toThrow()
      }
      await core.cancel(handle.executionId)
      const stopped = await core.waitForTerminal(handle.executionId)
      expect(stopped).toMatchObject({
        phase: 'cancelled',
        cleanup: 'unknown',
        identity: initial.identity
      })
      expect(cancel).toHaveBeenCalledWith('owned-job', {
        projectId,
        sessionId: privateId!,
        providerId: 'ssh:fixture'
      })
      expect(await operations.get('owned-job', 'cancel')).toMatchObject({
        phase: 'active',
        outcome: null
      })
      expect(await owners.shutdown()).toEqual({ reaped: false })
      expect(await core.settle()).toBe(true)
      const unknown = journal.load()
      expect(unknown.records[handle.executionId]).toEqual(stopped)
      const bytes = await readFile(journalPath, 'utf8'),
        lock = await readFile(`${journalPath}.lock`, 'utf8')
      const counts = {
        submits: submit.mock.calls.length,
        models: modelRequests,
        bindings: bindCandidate.mock.calls.length,
        owners: openOwner.mock.calls.length
      }
      // This is a live original writer, not a dead-owner recovery fixture. Never force its lock.
      expect(() => new FileExecutionStore(journalPath)).toThrow(
        expect.objectContaining({ code: 'EEXIST' })
      )
      expect((await core.submit(request)).executionId).toBe(handle.executionId)
      // Original limit=1 is already spent. This proves no extra admission, not an independent
      // cleanup-fence error (the Core checks the exhausted budget first).
      await expect(core.submit({ ...request, requestKey: 'retry-unknown' })).rejects.toMatchObject({
        code: 'budget-exhausted'
      })
      expect(journal.load()).toEqual(unknown)
      expect(await readFile(journalPath, 'utf8')).toBe(bytes)
      expect(await readFile(`${journalPath}.lock`, 'utf8')).toBe(lock)
      expect({
        submits: submit.mock.calls.length,
        models: modelRequests,
        bindings: bindCandidate.mock.calls.length,
        owners: openOwner.mock.calls.length
      }).toEqual(counts)
      expect(await owners.resolveCandidateDelivery!(privateId!)).toEqual({
        kind: 'private-unavailable'
      })
      await expect(
        owners.resolveControlPolicy!({
          projectId,
          sessionId: privateId!,
          agentFrameId: 'unknown',
          executionCwd: root
        })
      ).rejects.toThrow('unavailable')
      // The original operation owner records definitive absence; local exit alone never did.
      const claim = await operations.claimNext('cancel', new Date(), 30_000, 'fixture-reaper')
      expect(claim?.jobId).toBe('owned-job')
      expect(await operations.fulfill(claim!, new Date(), true)).toBe(true)
      expect(await owners.shutdown()).toEqual({ reaped: true })
      expect((await core.get(handle.executionId)).cleanup).toBe('unknown')
      expect(submit).toHaveBeenCalledOnce()
      return
    }
    if (mode === 'multi-batch')
      await adapter.observeJob(
        await toJobSummary((await jobs.get('owned-job-2'))!, 'Owned fixture', root)
      )
    const runningJob = await jobs.get('owned-job')
    expect(runningJob).not.toBeNull()
    await adapter.observeJob(await toJobSummary(runningJob!, 'Owned fixture', root))
    const final = await jobs.update('owned-job', {
      status: 'success',
      finishedAt: new Date(),
      harvestedAt: new Date(),
      notifiedAt: new Date(),
      exitCode: 0,
      stdoutTail: JSON.stringify({ answer: 42 })
    })
    await adapter.observeNotification(await toJobSummary(final, 'Owned fixture', root))
    events.publish('compute:job-updated', await toJobSummary(final, 'Owned fixture', root))
    if (mode === 'stop-continuation') {
      await vi.waitFor(
        async () => {
          const runs = await new NotebookRunRepository(root).readSessionRuns(projectId, privateId!)
          expect(
            runs.some(
              (run) =>
                run.status === 'running' && run.promptMessageId !== initial.identity.promptMessageId
            )
          ).toBe(true)
        },
        { timeout: 20_000 }
      )
      await core.cancel(handle.executionId)
      const stopped = await core.waitForTerminal(handle.executionId)
      expect(stopped).toMatchObject({
        phase: 'cancelled',
        cleanup: 'confirmed',
        identity: initial.identity
      })
      expect(await operations.get('owned-job', 'cancel')).toBeNull()
      expect(await owners.shutdown()).toEqual({ reaped: true })
      expect(submit).toHaveBeenCalledOnce()
      return
    }
    if (mode === 'multi-batch') {
      await vi.waitFor(
        async () => {
          expect(
            await deliveries.findBySource({
              sourceKind: 'compute-job',
              sourceId: 'owned-job',
              projectId,
              sessionId: privateId!
            })
          ).toMatchObject({ state: 'consumed' })
          const current = await loadSessionMutationAuthority(sessions, projectId, privateId!)
          expect(current.status === 'found' && !current.session.activeRun).toBe(true)
        },
        { timeout: 20_000 }
      )
      expect((await core.get(handle.executionId)).phase).toBe('running')
      const later = await jobs.update('owned-job-2', {
        status: 'success',
        finishedAt: new Date(),
        harvestedAt: new Date(),
        notifiedAt: new Date(),
        exitCode: 0,
        stdoutTail: 'later result'
      })
      await adapter.observeNotification(await toJobSummary(later, 'Owned fixture', root))
      events.publish('compute:job-updated', await toJobSummary(later, 'Owned fixture', root))
    }
    const record = await core.waitForTerminal(handle.executionId)
    expect(providerErrors).toEqual([])
    if (mode === 'continuation-failure') {
      const current = await loadSessionMutationAuthority(sessions, projectId, privateId!)
      expect(current.status).toBe('found')
      if (current.status !== 'found') throw new Error('Missing original private Session')
      const messages = current.session.conversationGraph?.messages ?? current.session.messages
      const outcomes = messages
        .filter((message) => message.role === 'user')
        .map((message) => ({
          id: message.id,
          outcome: resolveTurnOutcome(current.session, message.id)
        }))
      const delivery = await deliveries.findBySource({
        sourceKind: 'compute-job',
        sourceId: 'owned-job',
        projectId,
        sessionId: privateId!
      })
      expect(outcomes.at(-1)?.outcome?.kind).toBe('failed')
      expect(
        record,
        JSON.stringify({
          phase: record.phase,
          error: record.error,
          stage,
          outcomes,
          delivery,
          agents: messages
            .filter((message) => message.role === 'agent')
            .map((message) => ({
              id: message.id,
              responseToMessageId: message.responseToMessageId,
              status: message.status
            })),
          artifacts: record.evidence.artifacts
        })
      ).toMatchObject({
        phase: 'failed',
        cleanup: 'confirmed',
        identity: initial.identity
      })
      expect(submit).toHaveBeenCalledOnce()
      return
    }
    expect(
      record,
      JSON.stringify({ phase: record.phase, error: record.error, stage })
    ).toMatchObject({
      phase: 'completed',
      cleanup: 'confirmed',
      identity: initial.identity
    })
    expect(Object.values(journal.load().budgets)).toEqual([{ limit: 1, admitted: 1 }])
    const runs = await new NotebookRunRepository(root).readSessionRuns(projectId, privateId!)
    expect(runs).toHaveLength(mode === 'tool-failure-repaired' ? 3 : 2)
    expect(new Set(runs.map((run) => run.promptMessageId)).size).toBe(2)
    expect(
      runs.every(
        (run) =>
          run.kernelKind === 'repl' &&
          (run.status === 'completed' ||
            (mode === 'tool-failure-repaired' && run.status === 'failed')) &&
          run.executionInvocationId
      )
    ).toBe(true)
    if (mode === 'tool-failure-repaired') {
      expect(runs.map((run) => run.status)).toEqual(['completed', 'failed', 'completed'])
      const saved = await loadSessionMutationAuthority(sessions, projectId, privateId!)
      if (saved.status !== 'found') throw new Error('Missing original private Session')
      const prompts = (saved.session.conversationGraph?.messages ?? saved.session.messages).filter(
        (message) => message.role === 'user'
      )
      expect(prompts.map((message) => resolveTurnOutcome(saved.session, message.id)?.kind)).toEqual(
        ['completed', 'completed']
      )
    }
    expect(runs.at(-1)?.script).toContain("attachJob('owned-job').result()")
    const exported = await owners.exportResult(record)
    expect(exported.files.map((file) => file.path)).toEqual([
      'receipt.json',
      'result.json',
      'figure.png',
      'initial.png'
    ])
    expect(await owners.readReviews(record)).toHaveLength(2)
    for (const file of exported.files.filter((file) => file.path.endsWith('.png'))) {
      const projected = await owners.materializeArtifact!(record, file.artifactRef)
      expect(await readFile(projected.assetPath)).toEqual(png)
    }
    expect(
      await owners.readSemanticSourceEvidence({ target: record, snapshots: store })
    ).toMatchObject({ schemaVersion: 1, profile: 'bounded-utf8-v1', inputs: [] })
    const checks = await owners.commitDeterministicReview!({
      target: record,
      checks: [
        { kind: 'json-value', path: 'receipt.json', pointer: '/submitted', expected: true },
        { kind: 'json-value', path: 'result.json', pointer: '/answer', expected: 42 }
      ]
    })
    expect(checks.reviewIds).toHaveLength(2)
    expect(checks.reviewIds).toContain(checks.reviewId)
    expect(await owners.shutdown()).toEqual({ reaped: true })
    expect(await core.settle()).toBe(true)
    const committed = journal.load()
    expect(
      Object.values(committed.records).every(
        (row) =>
          ['completed', 'failed', 'cancelled'].includes(row.phase) && row.cleanup === 'confirmed'
      )
    ).toBe(true)
    const counts = {
      submits: submit.mock.calls.length,
      models: modelRequests,
      bindings: bindCandidate.mock.calls.length,
      owners: openOwner.mock.calls.length
    }
    core.dispose()
    journal.close()
    journal = undefined
    owners = createOwners()
    journal = new FileExecutionStore(journalPath)
    const reopenedDriver = createDriver()
    const dispatch = vi.spyOn(reopenedDriver, 'execute')
    core = new ExecutionCore(journal, reopenedDriver)
    expect((await core.submit(request)).executionId).toBe(handle.executionId)
    expect(await core.get(handle.executionId)).toEqual(record)
    expect(await core.waitForTerminal(handle.executionId)).toEqual(record)
    expect(await core.settle()).toBe(true)
    expect(journal.load()).toEqual(committed)
    expect(dispatch).not.toHaveBeenCalled()
    expect({
      submits: submit.mock.calls.length,
      models: modelRequests,
      bindings: bindCandidate.mock.calls.length,
      owners: openOwner.mock.calls.length
    }).toEqual(counts)
    expect(await new NotebookRunRepository(root).readSessionRuns(projectId, privateId!)).toEqual(
      runs
    )
    expect((await owners.exportResult(record)).trajectoryText).toBe(exported.trajectoryText)
    await jobs.update('owned-job', { stdoutTail: 'changed after commitment' })
    await expect(owners.exportResult(record)).rejects.toThrow('evidence changed')
    expect(submit).toHaveBeenCalledTimes(mode === 'multi-batch' ? 2 : 1)
  },
  90_000
)
