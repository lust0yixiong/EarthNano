/** Production-tool-chain seam: Agent dispatch/events and Reviewer decisions are scripted.
 * Scientific MCP tools, local RPC, Python, durable owners and version publication remain real. */
import { execFile } from 'node:child_process'
import { onTestFinished } from 'vitest'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ActiveSession } from '@agentclientprotocol/sdk'
import type { AcpRuntimeEvent } from '../../src/shared/acp'
import type { PersistedChatSession } from '../../src/shared/session-persistence'
import type { ReviewWithChecks } from '../../src/shared/reviewer'
import type { ExecutionRecord } from '../../src/shared/earthnano/execution-port'
import {
  createLinearConversationGraph,
  getActiveConversationContext
} from '../../src/shared/conversation-graph'
import { applySessionConversationCommands } from '../../src/shared/session-conversation-command'
import { createProvenanceTestFixture } from '../../src/main/artifacts/provenance-test-fixtures'
import { ArtifactProvenanceRepository } from '../../src/main/artifacts/provenance-repository'
import { createArtifactMcpServer } from '../../src/main/artifacts/mcp-server'
import { ArtifactTurnOwner } from '../../src/main/acp/artifact-turn-owner'
import { ArtifactRunRegistry } from '../../src/main/artifacts/run-registry'
import {
  SessionRepository,
  loadSessionMutationAuthority
} from '../../src/main/session-persistence/repository'
import { SessionProjectionRepository } from '../../src/main/session-persistence/projection'
import { SessionPersistenceCoordinator } from '../../src/main/session-persistence/coordinator'
import { RuntimeSessionOwner } from '../../src/main/session-persistence/runtime-session-owner'
import { ManagedFileVersionService } from '../../src/main/managed-file-versions/service'
import { ManagedFileIndexRepository } from '../../src/main/project-files/repository'
import { UploadRepository } from '../../src/main/uploads/repository'
import { ImmutableInputAuthority } from '../../src/main/immutable-input-authority'
import { NotebookInputRegistry } from '../../src/main/notebook/input-registry'
import { NotebookRuntimeService } from '../../src/main/notebook/runtime-service'
import { NotebookLocalRpcServer } from '../../src/main/notebook/local-rpc-server'
import { getNotebookSessionRoot, getNotebookDataRoot } from '../../src/main/notebook/repository'
import { createNotebookMcpServer } from '../../src/main/notebook/mcp-server'
import { SettingsRepository } from '../../src/main/settings/repository'
import { NotebookRuntimeSettingsModule } from '../../src/main/settings/notebook-runtime-settings'
import { ReviewRepository } from '../../src/main/reviewer/repository'
import { createReviewerCommandOwner } from '../../src/main/reviewer/ipc'
import { disconnectProjectDbClient } from '../../src/main/projects/prisma-client'
import type { ReviewerAcpRuntime } from '../../src/main/reviewer/acp-runtime'
import { createAcpExecutionBoundary } from '../../src/main/earthnano/acp-execution-boundary'
import { createSessionExecutionHost } from '../../src/main/earthnano/session-execution-host'
import { currentExecutionScope } from '../../src/main/earthnano/execution-scope'
import type { ExecutionState } from '../../src/main/earthnano/execution-core'

const projectId = 'research-project'
const sessionId = 'research-session'
const promptMessageId = 'research-prompt'
const toolResult = (
  name: string,
  result: Awaited<ReturnType<Client['callTool']>>
): Record<string, unknown> => {
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`)
  const content = result.content as Array<{ type: string; text?: string }>
  const text = content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return { text }
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function createResearchWorkflowFixture() {
  const fixture = await createProvenanceTestFixture()
  const cleanups: Array<() => Promise<unknown>> = [() => fixture.dispose()]
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> =>
    (disposal ??= (async () => {
      const errors: unknown[] = []
      for (const cleanup of [...cleanups].reverse()) {
        try {
          await cleanup()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Research workflow cleanup failed')
    })())
  onTestFinished(dispose)
  const root = await realpath(fixture.storageRoot)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await fixture.client.project.create({
    data: { id: projectId, name: 'Offline research workflow' }
  })
  const settings = new SettingsRepository(root)
  const notebookSettings = new NotebookRuntimeSettingsModule(settings)
  const python = await realpath(
    process.env.EARTHNANO_RESEARCH_PYTHON ??
      process.env.OPEN_SCIENCE_TEST_PYTHON ??
      '/usr/bin/python3'
  )
  await promisify(execFile)(python, [
    '-c',
    'import csv,statistics; print(statistics.mean([2,4,6]))'
  ])
  await notebookSettings.addManualInterpreter('python', python)
  await notebookSettings.setEnvironmentEnabled('python', python, true)
  const versions = new ManagedFileVersionService({
    storageRoot: root,
    getClient: async () => fixture.client
  })
  const uploads = new UploadRepository(root, { getClient: async () => fixture.client })
  const sessions = new SessionRepository(
    root,
    {},
    new SessionProjectionRepository(async () => fixture.client)
  )
  const files = new ManagedFileIndexRepository(async () => fixture.client, root, versions, uploads)
  const coordinator = new SessionPersistenceCoordinator(sessions, files)
  const load = async (): Promise<PersistedChatSession> => {
    const loaded = await loadSessionMutationAuthority(sessions, projectId, sessionId)
    if (loaded.status !== 'found') throw new Error('Research Session unavailable')
    return loaded.session
  }
  const provenance = new ArtifactProvenanceRepository({
    ...fixture.repositoryOptions,
    loadSession: load
  })
  const inputs = new NotebookInputRegistry({
    storageRoot: root,
    inputAuthority: new ImmutableInputAuthority({
      storageRoot: root,
      managedFileVersions: versions
    })
  })
  const notebook = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId,
    repository: fixture.notebookRepository,
    notebookRuntimeSettings: notebookSettings,
    backgroundExecutionEnabled: false
  })
  cleanups.push(() => notebook.dispose())
  const rpc = new NotebookLocalRpcServer(notebook, {
    transport: 'tcp',
    artifactProvenance: provenance,
    inputRegistry: inputs
  })
  cleanups.push(() => rpc.close())
  const registry = new ArtifactRunRegistry()
  const artifactOwner = new ArtifactTurnOwner({
    dataRoot: root,
    repository: fixture.compatibilityRepository,
    provenance,
    runRegistry: registry,
    issueRpcCapability: (binding) => rpc.issueArtifactRunCapability(binding),
    revokeRpcCapability: (token) => rpc.revokeArtifactRunCapability(token),
    notebook: rpc,
    notebookArtifactSourceScope: () => ({
      notebookSessionId: sessionId,
      notebookDataDir: getNotebookDataRoot(root, projectId, sessionId),
      notebookSessionRoot: getNotebookSessionRoot(root, projectId, sessionId)
    })
  })
  const runtimeSessions = new RuntimeSessionOwner({
    loadSession: load,
    mutateSession: (scope, mutate) => coordinator.mutateRuntimeSession(scope, mutate),
    finalizeArtifacts: async ({ claimId, messageId }) => {
      const claim = registry.resolve(claimId)
      const request = {
        projectId,
        appSessionId: sessionId,
        artifactRunId: claim.runId,
        artifactVersionIds: claim.artifactVersionIds ?? [],
        rootFrameId: claim.rootFrameId!,
        agentFrameId: claim.agentFrameId!,
        messageBranchId: claim.messageBranchId!,
        runtimeSegmentId: claim.runtimeSegmentId!,
        promptMessageId: claim.promptMessageId!,
        messageId
      }
      return provenance.withSessionMutation({ projectId, appSessionId: sessionId }, async () => {
        await provenance.finalizeRun(request)
        await fixture.compatibilityRepository.finalizeRunArtifacts({
          projectId,
          sourceSessionId: claim.artifactSessionId,
          sessionId,
          runId: claim.runId,
          artifactVersionIds: request.artifactVersionIds,
          provenanceContext: {
            rootFrameId: request.rootFrameId,
            agentFrameId: request.agentFrameId,
            messageBranchId: request.messageBranchId,
            runtimeSegmentId: request.runtimeSegmentId,
            promptMessageId: request.promptMessageId
          },
          messageId
        })
        const files = await provenance.activateFinalizedRun(request)
        registry.markFinalized(claimId, messageId)
        return files
      })
    }
  })
  const source = join(workspace, 'measurements.csv')
  await writeFile(source, 'sample,value\na,2\nb,4\nc,6\n')
  const stagedUpload = await uploads.stageLocalFile({
    transferId: 'research-upload',
    sourcePath: source,
    name: 'measurements.csv',
    mimeType: 'text/csv',
    size: Buffer.byteLength(await readFile(source))
  })
  const attachments = await uploads.finalizePendingSessionUploads(
    sessionId,
    [stagedUpload],
    projectId
  )
  const research = (await import(
    pathToFileURL(resolve('e2e/fixtures/research-analysis.mjs')).href
  )) as {
    researchPrompt: string
    runResearchAnalysis(
      session: string,
      prompt: string,
      withClient: (
        session: string,
        name: string,
        callback: (client: Client) => Promise<unknown>
      ) => Promise<unknown>,
      result: typeof toolResult
    ): Promise<string>
  }
  const now = Date.now()
  const idle = await coordinator.saveSession({
    id: sessionId,
    projectId,
    title: 'Research workflow',
    cwd: workspace,
    status: 'idle',
    agentFrameworkId: 'opencode',
    messages: [],
    conversationGraph: createLinearConversationGraph({
      sessionId,
      messages: [],
      frameworkId: 'opencode',
      createdAt: now,
      updatedAt: now
    }),
    createdAt: now,
    updatedAt: now
  })
  const staged = applySessionConversationCommands(idle, [
    {
      id: 'research-user-command',
      kind: 'append-user',
      timestamp: now,
      branchId: idle.conversationGraph!.branches[0].id,
      message: {
        id: promptMessageId,
        role: 'user',
        content: research.researchPrompt,
        status: 'complete',
        eventIds: [],
        createdAt: now,
        updatedAt: now,
        uploads: attachments
      }
    },
    {
      id: 'research-start-command',
      kind: 'start-run',
      timestamp: now,
      run: { promptMessageId, startedAt: now }
    }
  ])
  await coordinator.admitTaskTurn({ session: staged, contextReset: false })
  const context = getActiveConversationContext(staged.conversationGraph!, promptMessageId)!
  const promptInputs = await rpc.registerNotebookTurnInputs({
    projectId,
    appSessionId: sessionId,
    promptMessageId,
    uploads: attachments,
    references: []
  })
  const connection = await rpc.issueSessionConnection(sessionId, projectId, context.agentFrameId!)
  const connectionInfo = await rpc.ensureStarted()
  const connect = async (server: ReturnType<typeof createNotebookMcpServer>): Promise<Client> => {
    const client = new Client({ name: 'offline-research-agent', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    cleanups.push(
      () => server.close(),
      () => client.close()
    )
    return client
  }
  const boundary = createAcpExecutionBoundary({
    host: createSessionExecutionHost({
      settings,
      versions,
      dataRoot: root,
      configRoot: root,
      getClient: async () => fixture.client,
      flush: async () => runtimeSessions.flush(sessionId, promptMessageId)
    })
  })
  let taskExecutionId: string | undefined
  let reply = ''
  const execute = async (): Promise<PersistedChatSession> => {
    await boundary.execute({
      attemptId: 'research-attempt',
      request: { sessionId, text: research.researchPrompt, provenanceContext: context },
      operation: 'sendPrompt',
      runtimeReviewOwner: 'renderer',
      cancelOwned: async () => {
        throw new Error('This bounded workflow does not request cancellation')
      },
      dispatch: async (observation) => {
        taskExecutionId = currentExecutionScope()!.context.executionId
        const runtimeToken = 'research-original-runtime-token'
        await runtimeSessions.begin(
          { ...context, projectId, sessionId, executionId: runtimeToken },
          { agentFrameworkId: 'opencode', providerSessionId: 'scripted-provider-decisions' }
        )
        observation?.admitted({ sessionId, promptMessageId, runtimeExecutionId: runtimeToken })
        const turn = await artifactOwner.openRootExecution({
          executionId: runtimeToken,
          workspaceCwd: workspace,
          appSessionId: sessionId,
          artifactStorageSessionId: sessionId,
          projectId,
          agentName: 'scripted-research-agent',
          provenanceContext: context
        })
        try {
          const notebookClient = await connect(
            createNotebookMcpServer({
              ...connection,
              projectId,
              sessionId,
              workspaceCwd: workspace
            })
          )
          const artifactClient = await connect(
            createArtifactMcpServer(fixture.compatibilityRepository, {
              storageRoot: root,
              projectId,
              sessionId,
              currentRunFile: artifactOwner.handoffFile(turn),
              allowedImportRoots: [workspace],
              rpcEndpoint: connectionInfo.endpoint
            })
          )
          observation?.providerAccepted()
          reply = await research.runResearchAnalysis(
            sessionId,
            `${research.researchPrompt}\n<open_science_notebook_inputs>${JSON.stringify(promptInputs)}</open_science_notebook_inputs>`,
            async (_session, name, callback) =>
              callback(name === 'open-science-notebook' ? notebookClient : artifactClient),
            toolResult
          )
          const event: AcpRuntimeEvent = {
            id: 'research-agent-message',
            timestamp: Date.now(),
            kind: 'message',
            level: 'info',
            sessionId,
            promptMessageId,
            role: 'assistant',
            text: reply
          }
          runtimeSessions.accept(event)
          await runtimeSessions.flush(sessionId, promptMessageId)
          const publication = await artifactOwner.finalize(turn)
          if (!publication) throw new Error('Research MCP produced no ArtifactVersion')
          await runtimeSessions.publish({ ...publication, executionId: runtimeToken })
          await runtimeSessions.commitTerminal(
            {
              id: 'research-stop',
              timestamp: Date.now(),
              kind: 'stop',
              level: 'info',
              sessionId,
              promptMessageId,
              title: 'Research complete',
              text: 'end_turn'
            },
            () => undefined
          )
          return { stopReason: 'end_turn' }
        } finally {
          await artifactOwner.dispose(turn)
        }
      }
    })
    if (!(await boundary.settle())) throw new Error('Research shared execution failed to settle')
    return load()
  }
  const review = async (): Promise<{
    result: { review: ReviewWithChecks }
    readContent: unknown
    readTrace: unknown
    readSource: unknown
  }> => {
    const current = await load()
    let reviewerClient: Client | undefined
    let decision: Promise<void> | undefined
    let readContent: unknown
    let readTrace: unknown
    let readSource: unknown
    const acpRuntime: ReviewerAcpRuntime = {
      sendPrompt: async () => {
        throw new Error('Unexpected main Agent correction')
      },
      sendApplicationPrompt: async () => {
        throw new Error('Unexpected main Agent correction')
      },
      buildReviewerSession: async (
        options: Parameters<ReviewerAcpRuntime['buildReviewerSession']>[0]
      ) => {
        const config = options.mcpServers[0]
        if (!('url' in config)) throw new Error('Research review fixture requires HTTP MCP')
        reviewerClient = new Client({ name: 'offline-review-decisions', version: '1' })
        const ownedClient = reviewerClient
        cleanups.push(() => ownedClient.close())
        await reviewerClient.connect(
          new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: {
              headers: Object.fromEntries(
                config.headers.map((header) => [header.name, header.value])
              )
            }
          })
        )
        return {
          role: 'reviewer',
          cwd: workspace,
          session: {
            sessionId: 'scripted-reviewer-provider',
            prompt: () => {
              decision = (async () => {
                toolResult(
                  'read_turn',
                  await reviewerClient!.callTool({ name: 'read_turn', arguments: {} })
                )
                const version = current.artifacts![0].versionId!
                readTrace = toolResult(
                  'read_artifact',
                  await reviewerClient!.callTool({
                    name: 'read_artifact',
                    arguments: { id: version, view: 'trace' }
                  })
                )
                const sourceRead = await reviewerClient!.callTool({
                  name: 'read_artifact',
                  arguments: { id: attachments[0].versionId!, view: 'content' }
                })
                readSource = { isError: sourceRead.isError === true, content: sourceRead.content }
                readContent = toolResult(
                  'read_artifact',
                  await reviewerClient!.callTool({
                    name: 'read_artifact',
                    arguments: { id: version, view: 'content' }
                  })
                )
                toolResult(
                  'submit_findings',
                  await reviewerClient!.callTool({
                    name: 'submit_findings',
                    arguments: {
                      checks: [
                        {
                          status: 'pass',
                          claim: 'The fixed report records 3 samples and mean 4.00.',
                          evidence: `Read fixed report Version ${version} and its captured Python producer trace. This scripted fixture does not claim an independent model judgment.`,
                          artifactVersionId: version
                        }
                      ]
                    }
                  })
                )
              })()
            },
            nextUpdate: async () => {
              await decision
              return { kind: 'stop', stopReason: 'end_turn', response: { stopReason: 'end_turn' } }
            }
          } as unknown as ActiveSession
        }
      },
      disposeReviewerSession: () => {
        void reviewerClient?.close()
        return { rejectedToolCalls: 0, reviewerBridgeScoped: true }
      }
    }
    // Exercise the original command owner, including its admission, awaited settlement,
    // Version resolver and Review repository. Native Electron invocation is outside this seam.
    cleanups.push(disconnectProjectDbClient)
    const owner = createReviewerCommandOwner({
      storageRoot: root,
      dataRoot: root,
      acpRuntime,
      modelRuntime: {
        admit: async () => ({
          model: 'deterministic-review-decisions',
          release: async () => undefined
        })
      },
      sessionReader: { loadSession: load, findSessionById: load },
      managedFileVersions: versions,
      artifactCatalog: files,
      artifactProvenanceRepository: provenance,
      withSessionMutation: (_project, _session, mutation) =>
        provenance.withSessionMutation({ projectId, appSessionId: sessionId }, mutation)
    })
    const started = await owner.run({
      projectId,
      sessionId,
      turnMessageId: promptMessageId,
      scopeTurnMessageId: promptMessageId,
      origin: 'manual',
      waitForCompletion: true,
      parentExecutionId: taskExecutionId
    })
    if (!started.started) throw new Error(`Research Review did not start: ${started.reason}`)
    const reviews = await new ReviewRepository(async () => fixture.client, {
      snapshotStorageRoot: root
    }).getReviewsForProjectSession(projectId, sessionId)
    const result = reviews[0]
    if (!result) throw new Error('Research Review was not persisted')
    return { result: { review: result }, readContent, readTrace, readSource }
  }
  const records = async (): Promise<ExecutionRecord[]> => {
    const files: string[] = []
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await walk(path)
        else if (entry.name.endsWith('.json')) files.push(path)
      }
    }
    await walk(join(root, 'executions'))
    await walk(join(root, 'earthnano', 'reviewer-executions'))
    const states = await Promise.all(
      files.map(async (file) => JSON.parse(await readFile(file, 'utf8')) as ExecutionState)
    )
    return states.flatMap((state) => Object.values(state.records))
  }
  return {
    root,
    workspace,
    projectId,
    sessionId,
    promptMessageId,
    python,
    versions,
    uploads,
    sessions,
    notebook,
    provenance,
    client: fixture.client,
    execute,
    review,
    load,
    records,
    reply: () => reply,
    inputVersionId: attachments[0].versionId!,
    reportPath: join(getNotebookDataRoot(root, projectId, sessionId), 'research-results.md'),
    dispose
  }
}
