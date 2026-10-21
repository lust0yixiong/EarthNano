import { createRequire } from 'node:module'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { vi } from 'vitest'
import { createComputeExecution } from '@aipoch/compute/node'
import type { PrismaClient } from '@prisma/client'
import type { ComputeJob } from '../../src/shared/compute'
import type { PersistedChatMessage } from '../../src/shared/session-persistence'
import { createLinearConversationGraph } from '../../src/shared/conversation-graph'
import { createCandidateOwnerTestPorts } from './candidate-owner-ports'
import { createComputeProtocolTransport } from './compute-transport'
import {
  createProjectDbClient,
  migrateApplicationDatabase
} from '../../src/main/projects/prisma-client'
import { initDataRoot } from '../../src/main/storage-root'
import { acquireDataRootWriter } from '../../src/main/storage/migration-state'
import {
  SessionRepository,
  loadSessionMutationAuthority
} from '../../src/main/session-persistence/repository'
import { ManagedFileVersionService } from '../../src/main/managed-file-versions/service'
import { ArtifactRepository } from '../../src/main/artifacts/repository'
import { ArtifactProvenanceRepository } from '../../src/main/artifacts/provenance-repository'
import { ImmutableInputAuthority } from '../../src/main/immutable-input-authority'
import { NotebookInputRegistry } from '../../src/main/notebook/input-registry'
import { NotebookLocalRpcServer } from '../../src/main/notebook/local-rpc-server'
import { NotebookRuntimeService } from '../../src/main/notebook/runtime-service'
import { ComputeHostRepository } from '../../src/main/compute/repository'
import { ComputeJobRepository } from '../../src/main/compute/job-repository'
import { ComputeJobOperationRepository } from '../../src/main/compute/compute-job-operation-repository'
import { ComputeService } from '../../src/main/compute/compute-service'
import { AgentComputeService } from '../../src/main/compute/agent-compute-service'
import { EnabledComputeHostsRegistry } from '../../src/main/compute/enabled-hosts-registry'
import { SessionEnabledComputeHostsOwner } from '../../src/main/compute/session-enabled-hosts-owner'
import { ApplicationEventHub } from '../../src/main/application-events'
import { BackgroundResultDeliveryRepository } from '../../src/main/background-result-delivery/repository'
import { BackgroundResultDeliveryOwner } from '../../src/main/background-result-delivery/owner'
import { ComputeJobResultDeliveryAdapter } from '../../src/main/background-result-delivery/compute-adapter'
import { resolveBackgroundResultSources } from '../../src/main/background-result-delivery/source-resolver'
import { routeCandidateContinuations } from '../../src/main/composition/background-results'
import { toJobSummary } from '../../src/main/compute/ipc'
import { freezeComputeContext } from '../../src/main/earthnano/compute-context'
import { ComputeApprovalBroker } from '../../src/main/compute/compute-approval-broker'
import { createComputePermissionGrantAdapter } from '../../src/main/compute/permission-grant-adapter'
import { createPermissionGrantRegistry } from '../../src/main/permission-grants/registry'
import { OptionalSecureStorageStringProtection } from '../../src/main/compute/credential-vault'
import { dispatchComputeJob } from '../../src/main/compute/dispatch-evidence'
import { createComputeJobRuntime } from '../../src/main/compute/job-runtime'
import {
  createDesktopCandidateOwnerRouting,
  readDesktopPrivateSessions
} from '../../src/main/earthnano/desktop-candidate-owner-routing'
import type { CandidateOwnersReady } from '../../src/main/earthnano/candidate-owner-contract'
import type {
  PersistentCandidateComputeOptions,
  PersistentCandidateNotebookOptions
} from '../../src/main/earthnano/persistent-candidate-owner'

export type ComputeWorkflowMode = 'authorized' | 'no-grant' | 'protection-unavailable'
export interface ComputeWorkflowFixture {
  root: string
  configRoot: string
  projectId: string
  sourceSessionId: string
  sourcePromptMessageId?: string
  client: PrismaClient
  getClient(): Promise<PrismaClient>
  sessions: SessionRepository
  ports: ReturnType<typeof createCandidateOwnerTestPorts>
  versions: ManagedFileVersionService
  notebook: PersistentCandidateNotebookOptions
  compute: PersistentCandidateComputeOptions
  onOwnersReady: CandidateOwnersReady
  transport: Awaited<ReturnType<typeof createComputeProtocolTransport>>
  jobs: ComputeJobRepository
  operations: ComputeJobOperationRepository
  deliveries: BackgroundResultDeliveryRepository
  events: ApplicationEventHub
  grants: Awaited<ReturnType<typeof createPermissionGrantRegistry>>
  approvalId: ReturnType<typeof vi.fn<() => string>>
  approvalBroadcast: ReturnType<typeof vi.fn>
  service: ComputeService
  runtime: ReturnType<typeof createComputeJobRuntime>
  execution: ReturnType<typeof createComputeExecution>
  changes: { status: ComputeJob['status']; jobId: string; harvested: boolean; notified: boolean }[]
  frozenCompute: Awaited<ReturnType<typeof freezeComputeContext>>
  start(): void | Promise<void>
  close(options?: { preserveEvidence?: boolean }): Promise<void>
}

/** Original workflow assembly shared by owner and Desktop/Harness tests. No factory, Core or model
 * is created here. Transport/cipher are explicit fixtures, not SSH/process/OS-keychain evidence. */
export async function createComputeWorkflowFixture(options: {
  mode: ComputeWorkflowMode
  sourcePrompt?: string
}): Promise<ComputeWorkflowFixture> {
  const { mode, sourcePrompt } = options
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWOQAAAAASUVORK5CYII=',
    'base64'
  )
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
  const sourcePromptMessageId = sourcePrompt === undefined ? undefined : 'compute-source-prompt'
  const messages: PersistedChatMessage[] =
    sourcePrompt === undefined
      ? []
      : [
          {
            id: sourcePromptMessageId!,
            role: 'user',
            content: sourcePrompt,
            status: 'complete',
            createdAt: 1,
            updatedAt: 1,
            eventIds: []
          }
        ]
  const source = await ports.sessionPersistence.coordinator.saveSession({
    id: sourceSessionId,
    projectId,
    title: 'Source',
    cwd: root,
    status: 'idle',
    messages,
    ...(sourcePrompt === undefined
      ? {}
      : {
          conversationGraph: createLinearConversationGraph({
            sessionId: sourceSessionId,
            messages,
            frameworkId: 'claude-code',
            createdAt: 1,
            updatedAt: 1
          })
        }),
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
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
    }
  })
  const jobs = new ComputeJobRepository(async () => client, protection)
  const operations = new ComputeJobOperationRepository(async () => client, protection)
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
  const changes: ComputeWorkflowFixture['changes'] = []
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
  const routing = createDesktopCandidateOwnerRouting(async () => {
    const release = acquireDataRootWriter()
    try {
      return readDesktopPrivateSessions({ configRoot, dataRoot: root })
    } finally {
      release()
    }
  })
  notebook.setMcpRpcConnectionResolver(async (binding) =>
    rpc.issueControlConnection(
      binding.sessionId,
      binding.projectId,
      binding.agentFrameId,
      { role: 'main' },
      binding.executionCwd,
      await routing.resolveControlPolicy(binding)
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
    routing.resolveCandidateDelivery
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
  let closed = false
  let closing: Promise<void> | undefined
  const close = async (closeOptions?: { preserveEvidence?: boolean }): Promise<void> => {
    if (closed) return
    if (closing) return closing
    closing = (async () => {
      const failures: unknown[] = []
      const attempt = async (work: () => unknown): Promise<void> => {
        try {
          await work()
        } catch (error) {
          failures.push(error)
        }
      }
      deliveryOwner.dispose()
      await attempt(async () => {
        if (!(await routing.shutdown()).reaped)
          throw new Error('Original candidate owners have unconfirmed resources')
      })
      await attempt(() => runtime.stop())
      await attempt(() =>
        execution.waitForDispatch([...new Set(changes.map((change) => change.jobId))])
      )
      await attempt(() => Promise.all([...effects, ...deliveryDrains]))
      await attempt(() => rpc.close())
      await attempt(() => notebook.dispose())
      await attempt(() => client.$disconnect())
      // Closing local ports never upgrades unknown cleanup. Preserve every owned file on failure.
      if (failures.length)
        throw new AggregateError(failures, `Compute workflow evidence retained at ${root}`)
      // Opt-in acceptance reports may need original native/Session files after all real owners
      // close. Keeping their directory is not a resource reaping or remote cleanup attestation.
      if (closeOptions?.preserveEvidence) {
        closed = true
        return
      }
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
      closed = true
    })()
    try {
      await closing
    } finally {
      closing = undefined
    }
  }
  return {
    root,
    configRoot,
    projectId,
    sourceSessionId,
    ...(sourcePromptMessageId ? { sourcePromptMessageId } : {}),
    client,
    getClient: async () => client,
    sessions,
    ports,
    versions,
    notebook: { service: notebook, rpc, mcpEntryPath },
    compute: {
      hosts,
      hostAccess,
      jobs,
      operations,
      service,
      deliveries,
      events,
      cancelApprovals: (id) => approval.cancelSession(id)
    },
    onOwnersReady: routing.onOwnersReady,
    transport,
    jobs,
    operations,
    deliveries,
    events,
    grants,
    approvalId,
    approvalBroadcast,
    service,
    runtime,
    execution,
    changes,
    frozenCompute,
    start: () => runtime.start(),
    close
  }
}
