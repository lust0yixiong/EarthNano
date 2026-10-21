import { createRequire } from 'node:module'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
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
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ArtifactRepository } from '../artifacts/repository'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { NotebookInputRegistry } from '../notebook/input-registry'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import { NotebookRunRepository } from '../notebook/repository'
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
import { createClaudeCandidateDriver } from './claude-candidate-driver'
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

import { createComputeExecution } from '@aipoch/compute/node'
import type { ComputeJob } from '../../shared/compute'
import { createComputeProtocolTransport } from '../../../test/earthnano/compute-transport'
import { ComputeApprovalBroker } from '../compute/compute-approval-broker'
import { createComputePermissionGrantAdapter } from '../compute/permission-grant-adapter'
import { createPermissionGrantRegistry } from '../permission-grants/registry'
import { OptionalSecureStorageStringProtection } from '../compute/credential-vault'
import { dispatchComputeJob } from '../compute/dispatch-evidence'
import { createComputeJobRuntime } from '../compute/job-runtime'

configureTestRuntimeMetadata()

// Every state owner below is original. Native messages use a fixed local provider; remote wire
// operations and the local cipher port are fixtures, not SSH/Linux/Slurm/OS-keychain certification.
it.each(['authorized', 'no-grant', 'protection-unavailable'] as const)(
  'runs original candidate Compute workflow with %s',
  async (mode) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'earthnano-compute-workflow-')))
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
    const remoteRoot = join(root, 'remote')
    await hosts.updateScratchPinned('ssh:fixture', remoteRoot)
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
    const transport = await createComputeProtocolTransport(remoteRoot, {
      'metrics.json': Buffer.from(JSON.stringify({ values: [2, 4, 6] })),
      'figure.png': png
    })
    const cipherKey = Buffer.alloc(32, 7) // Test-only key; never an OS keychain claim.
    const protection = new OptionalSecureStorageStringProtection({
      isEncryptionAvailable: () => mode !== 'protection-unavailable',
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (value) => {
        const iv = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', cipherKey, iv)
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
      },
      decryptString: (bytes) => {
        const decipher = createDecipheriv('aes-256-gcm', cipherKey, bytes.subarray(0, 12))
        decipher.setAuthTag(bytes.subarray(12, 28))
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
          'utf8'
        )
      }
    })
    const jobs = new ComputeJobRepository(async () => client, protection)
    const operations = new ComputeJobOperationRepository(async () => client, protection)
    expect(jobs.isFieldProtectionAvailable()).toBe(mode !== 'protection-unavailable')
    const grants = await createPermissionGrantRegistry({ getClient: async () => client })
    const permissions = createComputePermissionGrantAdapter(grants)
    if (mode !== 'no-grant')
      await permissions.remember(
        {
          projectId,
          sessionId: sourceSessionId,
          providerId: 'ssh:fixture',
          operation: 'submit_job'
        },
        'project'
      )
    const approvalBroadcast = vi.fn()
    const approvalId = vi.fn((): string => {
      throw new Error('Noninteractive candidate must never allocate an approval card')
    })
    const approval = new ComputeApprovalBroker({
      generateId: approvalId,
      broadcast: approvalBroadcast,
      permissionGrants: permissions,
      isProviderCurrent: async ({ providerId, ownerId }) =>
        (await hosts.get(providerId))?.id === ownerId
    })
    const execution = createComputeExecution()
    const events = new ApplicationEventHub()
    const deliveries = new BackgroundResultDeliveryRepository(async () => client)
    const effects: Promise<unknown>[] = []
    const changes: { status: string; jobId: string; harvested: boolean; notified: boolean }[] = []
    const publish = (job: ComputeJob): void => {
      changes.push({
        status: job.status,
        jobId: job.job_id,
        harvested: job.harvested_at !== undefined,
        notified: job.notified_at !== undefined
      })
      const effect = (async () => {
        const summary = await toJobSummary(job, 'Protocol fixture', root)
        await adapter.observeJob(summary)
        events.publish('compute:job-updated', summary)
      })()
      effects.push(effect)
      void effect.catch(() => undefined) // Joined below; no failed side effect is discarded.
    }
    const queue = execution.createQueue({
      jobs,
      hosts,
      publish,
      dispatch: (jobId, onJobUpdated) =>
        dispatchComputeJob(jobId, {
          execution,
          connectionBroker: transport.broker,
          hostRepository: hosts,
          jobRepository: jobs,
          storageRoot: root,
          onJobUpdated
        }),
      sessionPolicy: {
        resolve: (id, project) => sessions.loadComputePolicy(project, id),
        save: async () => {
          throw new Error('Unexpected fixture concurrency mutation')
        }
      }
    })
    const service = new ComputeService({
      execution,
      repository: hosts,
      jobRepository: jobs,
      operationRepository: operations,
      storageRoot: root,
      concurrencyManager: queue,
      approvalBroker: approval,
      onJobUpdated: publish,
      connectionBroker: transport.broker,
      runner: {
        run: async () => {
          throw new Error('No SSH runner may escape the protocol fixture')
        }
      }
    })
    const runtime = createComputeJobRuntime(
      {
        computeService: service,
        hostRepository: hosts,
        jobRepository: jobs,
        operationRepository: operations,
        connectionBroker: transport.broker,
        storageRoot: root
      },
      {
        broadcast: (summary) => {
          const effect = adapter.observeNotification(summary).then(() => {
            events.publish('compute:job-updated', summary)
          })
          effects.push(effect)
          void effect.catch(() => undefined)
        }
      }
    )
    const agentCompute = new AgentComputeService(service, registry, {
      onFinalJobObserved: async (_context, _providerId, snapshot) => {
        const job = await jobs.get(snapshot.job_id)
        if (!job) throw new Error('Missing original Job')
        return adapter.observeResult(await toJobSummary(job, 'Protocol fixture', root))
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
          cancelApprovals: (id) => approval.cancelSession(id)
        }
      })
    const owners = createOwners()
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
    let stage = 0,
      modelRequests = 0
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
          response.writeHead(404)
          response.end()
          return
        }
        const body = JSON.parse(text) as Body
        modelRequests++
        if (!body.tools?.some((tool) => tool.name.endsWith('repl_execute'))) {
          emit(response, body.model, { text: 'Original workflow fixture' })
          return
        }
        const call = (suffix: string, input: object): void => {
          const tool = body.tools!.find((tool) => tool.name.endsWith(suffix))
          if (!tool) throw new Error('Original tool missing')
          emit(response, body.model, { name: tool.name, input })
        }
        const runs = nestedRunIds(body.messages),
          next = stage++
        if (next === 0)
          return call('repl_execute', {
            code: "const receipt=await host.compute.create('ssh:fixture').submitJob('workflow fixture','printf protocol-workload',{outputs:['metrics.json','figure.png'],timeoutSeconds:30});console.log(JSON.stringify(receipt));"
          })
        if (next === 1) {
          emit(response, body.model, { text: 'Submission settled; await original full result.' })
          return
        }
        if (next === 2)
          return call('repl_execute', {
            code: "const result=await host.compute.create('ssh:fixture').attachJob(receipt.job_id).result();if(!result.result_final)throw new Error('Result is not final');const fs=require('node:fs');const metrics=JSON.parse(fs.readFileSync('../'+result.featured_files.find(p=>p.endsWith('metrics.json')),'utf8'));fs.writeFileSync('report.json',JSON.stringify({count:metrics.values.length,mean:metrics.values.reduce((a,b)=>a+b,0)/metrics.values.length}),{flag:'wx'});fs.writeFileSync('derived.png',fs.readFileSync('../'+result.featured_files.find(p=>p.endsWith('figure.png'))),{flag:'wx'});console.log('Derived from original harvested bytes');"
          })
        if (next === 3 || next === 4) {
          const filename = next === 3 ? 'report.json' : 'derived.png'
          return call('write_artifact_file', {
            filename,
            mimeType: next === 3 ? 'application/json' : 'image/png',
            source: { kind: 'localPath', path: filename },
            producerRunId: runs.at(-1)
          })
        }
        emit(response, body.model, {
          text: 'Original state owners completed the protocol workflow.'
        })
      } catch (error) {
        providerErrors.push(String(error))
        response.statusCode = 500
        response.end('Bounded fixture failure')
      }
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const handleOwner: { core?: ExecutionCore } = {}
    const journal = new FileExecutionStore(join(root, 'execution.json'))
    onTestFinished(async () => {
      deliveryOwner.dispose()
      handleOwner.core?.dispose()
      await owners.shutdown()
      await runtime.stop()
      await execution.waitForDispatch([...new Set(changes.map((change) => change.jobId))])
      await Promise.all([...effects, ...deliveryDrains])
      journal.close()
      await rpc.close()
      await notebook.dispose()
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
      await client.$disconnect()
      const unlock = async (path: string): Promise<void> => {
        const info = await lstat(path)
        if (info.isSymbolicLink()) throw new Error('Fixture acquired an unexpected link')
        if (info.isDirectory()) {
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
    const core = new ExecutionCore(
      journal,
      createClaudeCandidateDriver({
        snapshots: store,
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
            key: 'local-fixture-token',
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            apiEndpoints: ['messages']
          }
        })
      })
    )
    handleOwner.core = core
    const request: ExecutionRequest = {
      contractVersion: 1,
      requestKey: 'compute-workflow',
      projectId,
      ...refs,
      invocationRef,
      role: 'candidate',
      origin: {
        kind: 'optimization',
        sessionId: sourceSessionId,
        optimizationId: 'workflow',
        stageId: 'candidate'
      },
      interactionPolicy: 'deny-unresolved',
      budgetRef: 'one',
      timeoutMs: 60_000
    }
    core.configureBudget(projectId, 'one', 1)
    const handle = await core.submit(request)
    if (mode !== 'authorized') {
      const rejected = await core.waitForTerminal(handle.executionId)
      expect(rejected).toMatchObject({ phase: 'failed', cleanup: 'confirmed' })
      expect(
        await jobs.findByOwner({ projectId, sessionId: rejected.identity.sessionId! })
      ).toEqual([])
      const deniedRuns = await new NotebookRunRepository(root).readSessionRuns(
        projectId,
        rejected.identity.sessionId!
      )
      expect(deniedRuns).toHaveLength(1)
      expect(deniedRuns[0].status).toBe('failed')
      expect(deniedRuns[0].script).toContain('.submitJob(')
      expect(deniedRuns[0].text.stderr + deniedRuns[0].text.traceback).toMatch(
        /approval_denied|Approval denied|approval was denied/
      )
      expect(await client.computeJob.count()).toBe(0)
      expect(await client.computeJobOperation.count()).toBe(0)
      expect(transport.calls).toEqual([])
      expect(approvalBroadcast).not.toHaveBeenCalled()
      expect(approvalId).not.toHaveBeenCalled()
      expect(await grants.list()).toHaveLength(mode === 'no-grant' ? 0 : 1)
      expect(providerErrors).toEqual([])
      return
    }
    let privateId = ''
    await vi.waitFor(
      async () => {
        const current = await core!.get(handle.executionId)
        privateId = current.identity.sessionId ?? ''
        const rows = privateId ? await jobs.findByOwner({ projectId, sessionId: privateId }) : []
        expect(
          rows,
          JSON.stringify({
            phase: current.phase,
            error: current.error,
            stage,
            changes,
            transport: transport.calls
          })
        ).toHaveLength(1)
        expect(rows[0]).toMatchObject({ status: 'queued', producer_run_id: expect.any(String) })
      },
      { timeout: 20_000 }
    )
    await vi.waitFor(
      async () => {
        const current = await loadSessionMutationAuthority(sessions, projectId, privateId)
        expect(current.status === 'found' && !current.session.activeRun).toBe(true)
      },
      { timeout: 20_000 }
    )
    const initial = await core.get(handle.executionId)
    expect(initial.phase).toBe('running')
    expect(transport.calls).toEqual([])
    const [queued] = await jobs.findByOwner({ projectId, sessionId: privateId })
    expect(
      await service.getJobStatus(queued.job_id, {
        projectId,
        sessionId: privateId,
        providerId: 'ssh:fixture'
      })
    ).toMatchObject({
      status: 'queued',
      result_final: false,
      queue_blocked_reason: 'runtime_stopped'
    })
    await runtime.start()
    const record = await core.waitForTerminal(handle.executionId)
    expect(
      record,
      JSON.stringify({
        phase: record.phase,
        error: record.error,
        stage,
        changes,
        transport: transport.calls,
        providerErrors
      })
    ).toMatchObject({ phase: 'completed', cleanup: 'confirmed', identity: initial.identity })
    const final = await jobs.get(queued.job_id)
    expect(final).toMatchObject({
      status: 'success',
      exit_code: 0,
      harvested_at: expect.any(Number),
      notified_at: expect.any(Number),
      producer_run_id: queued.producer_run_id
    })
    expect(final?.harvest_error).toBeUndefined()
    const protectedRow = await client.computeJob.findUniqueOrThrow({ where: { id: queued.job_id } })
    expect(protectedRow.command).not.toContain('protocol-workload')
    expect(protectedRow.stdoutTail).not.toContain('protocol-fixture')
    expect(final?.file_evidence).toMatchObject({
      activityKind: 'compute-job',
      activityId: queued.job_id,
      parentActivityId: queued.producer_run_id,
      checksum: expect.any(String)
    })
    expect(changes.map((change) => change.status)).toEqual(
      expect.arrayContaining(['queued', 'submitted', 'running', 'success'])
    )
    expect(transport.calls.map((call) => call.kind)).toEqual(
      expect.arrayContaining(['dispatch', 'poll', 'enumerate', 'download', 'stat'])
    )
    expect(transport.commands).toEqual(['printf protocol-workload'])
    expect(transport.calls.some((call) => call.kind === 'acquire:job_cleanup')).toBe(false)
    expect(await client.computeJobOperation.count()).toBe(0)
    const delivery = await deliveries.findBySource({
      sourceKind: 'compute-job',
      sourceId: queued.job_id,
      projectId,
      sessionId: privateId
    })
    expect(delivery).toMatchObject({ state: 'consumed', continuationMessageId: expect.any(String) })
    const runs = await new NotebookRunRepository(root).readSessionRuns(projectId, privateId)
    expect(runs).toHaveLength(2)
    expect(runs.every((run) => run.status === 'completed' && run.kernelKind === 'repl')).toBe(true)
    expect(new Set(runs.map((run) => run.promptMessageId)).size).toBe(2)
    const exported = await owners.exportResult(record)
    expect(exported.files.map((file) => file.path)).toEqual(['report.json', 'derived.png'])
    const report = exported.files[0]
    if (!('content' in report)) throw new Error('Missing original text report')
    expect(JSON.parse(report.content)).toEqual({ count: 3, mean: 4 })
    expect(
      await readFile(
        (await owners.materializeArtifact!(record, exported.files[1].artifactRef)).assetPath
      )
    ).toEqual(png)
    expect(await owners.readReviews(record)).toHaveLength(1)
    expect(
      await owners.commitDeterministicReview!({
        target: record,
        checks: [{ kind: 'json-value', path: 'report.json', pointer: '/mean', expected: 4 }]
      })
    ).toMatchObject({ outcome: 'pass', reviewId: expect.any(String) })
    expect(journal.load().budgets[JSON.stringify([projectId, 'one'])]).toEqual({
      limit: 1,
      admitted: 1
    })
    expect(approvalBroadcast).not.toHaveBeenCalled()
    expect(approvalId).not.toHaveBeenCalled()
    expect(providerErrors).toEqual([])
    expect(modelRequests).toBeGreaterThan(0)
    await Promise.all(effects)
    expect(await owners.shutdown()).toEqual({ reaped: true })
  },
  90_000
)
