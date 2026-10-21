import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: true } }))
import {
  createLinearConversationGraph,
  getActiveConversationContext
} from '../../shared/conversation-graph'
import { applySessionConversationCommands } from '../../shared/session-conversation-command'
import type { ExecutionRecord } from '../../shared/earthnano/execution-port'
import { initDataRoot } from '../storage-root'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { SessionRepository, loadSessionMutationAuthority } from '../session-persistence/repository'
import { SessionProjectionRepository } from '../session-persistence/projection'
import { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { RuntimeSessionOwner } from '../session-persistence/runtime-session-owner'
import { AcpRuntimeCoordinator } from '../acp/runtime-coordinator'
import { AcpRuntime } from '../acp/runtime'
import { composeAcpRuntimeBaseOwners } from '../acp/runtime-base-composition'
import { composeAcpRuntimeSessionOwners } from '../acp/runtime-session-composition'
import { createAcpCreateSessionWorkflow } from '../acp/create-session-workflow'
import { claudeCodeFramework } from '../agent-framework/claude-code'
import { ArtifactRepository } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ArtifactTurnOwner } from '../acp/artifact-turn-owner'
import { SettingsRepository } from '../settings/repository'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { UploadRepository } from '../uploads/repository'
import { emptyExecutionState } from './execution-core'
import { requestDigest } from './execution-contract'
import { createAcpExecutionBoundary } from './acp-execution-boundary'
import { createSessionExecutionHost } from './session-execution-host'
import { readExecutionTurnUsage } from './original-turn-usage'
import {
  createOriginalTurnEvidenceReader,
  originalTurnReply,
  originalEvidenceDigest
} from './original-turn-evidence'
type Body = { model: string; system: unknown; messages: unknown[] }
const send = (
  response: ServerResponse,
  body: Body,
  content: { text: string } | { name: string; input: object },
  id: string
): void => {
  const tool = 'name' in content
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 11, output_tokens: 0 }
        }
      }
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: tool
          ? { type: 'tool_use', id: `call_${id}`, name: content.name, input: {} }
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

/** Actual ordinary Send, original native runtime and durable owners; no candidate driver or outer Core. */
const runOrdinary = async (live: boolean, stop = false, resume = false): Promise<void> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'earthnano-ordinary-send-')))
  const configRoot = join(root, 'config')
  const dataRoot = join(root, 'data')
  await Promise.all([mkdir(configRoot), mkdir(dataRoot)])
  initDataRoot(dataRoot)
  const client = createProjectDbClient(configRoot)
  const sessions = new SessionRepository(
    configRoot,
    {},
    new SessionProjectionRepository(async () => client)
  )
  const versions = new ManagedFileVersionService({
    storageRoot: dataRoot,
    getClient: async () => client
  })
  const repository = new ArtifactRepository(dataRoot)
  const coordinator = new SessionPersistenceCoordinator(
    sessions,
    new ManagedFileIndexRepository(
      async () => client,
      dataRoot,
      versions,
      new UploadRepository(dataRoot, { getClient: async () => client })
    )
  )
  const load = async (
    projectId: string,
    sessionId: string
  ): Promise<import('../../shared/session-persistence').PersistedChatSession> => {
    const result = await loadSessionMutationAuthority(sessions, projectId, sessionId)
    if (result.status !== 'found') throw new Error('Original ordinary Session unavailable')
    return result.session
  }
  const registry = new ArtifactRunRegistry()
  const provenance = new ArtifactProvenanceRepository({
    storageRoot: dataRoot,
    getClient: async () => client,
    compatibilityRepository: repository,
    loadSession: load
  })
  const artifacts = new ArtifactTurnOwner({
    dataRoot,
    repository,
    provenance,
    runRegistry: registry
  })
  const runtimeSessions = new RuntimeSessionOwner({
    loadSession: (scope) => load(scope.projectId, scope.sessionId),
    mutateSession: (scope, mutate) => coordinator.mutateRuntimeSession(scope, mutate),
    finalizeArtifacts: async ({ claimId, messageId }) => {
      const claim = registry.resolve(claimId)
      const finalization = {
        projectId: claim.projectId,
        appSessionId: claim.sessionId,
        artifactRunId: claim.runId,
        artifactVersionIds: claim.artifactVersionIds ?? [],
        rootFrameId: claim.rootFrameId!,
        agentFrameId: claim.agentFrameId!,
        messageBranchId: claim.messageBranchId!,
        runtimeSegmentId: claim.runtimeSegmentId!,
        promptMessageId: claim.promptMessageId!,
        messageId
      }
      return provenance.withSessionMutation(
        { projectId: claim.projectId, appSessionId: claim.sessionId },
        async () => {
          await provenance.finalizeRun(finalization)
          await repository.finalizeRunArtifacts({
            projectId: claim.projectId,
            sourceSessionId: claim.artifactSessionId,
            sessionId: claim.sessionId,
            runId: claim.runId,
            artifactVersionIds: finalization.artifactVersionIds,
            provenanceContext: {
              rootFrameId: claim.rootFrameId!,
              agentFrameId: claim.agentFrameId!,
              messageBranchId: claim.messageBranchId!,
              runtimeSegmentId: claim.runtimeSegmentId!,
              promptMessageId: claim.promptMessageId!
            },
            messageId
          })
          const result = await provenance.activateFinalizedRun(finalization)
          registry.markFinalized(claimId, messageId)
          return result
        }
      )
    }
  })
  const token = randomUUID()
  let apiKey: string | undefined
  if (live) {
    const keys = new Set(
      (await readFile(process.env.EARTHNANO_LIVE_DEEPSEEK_KEY_FILE!, 'utf8')).match(
        /\bsk-[A-Za-z0-9_-]+\b/g
      ) ?? []
    )
    if (keys.size !== 1) throw new Error('Expected one API token in explicitly supplied key file')
    apiKey = [...keys][0]
  }
  let requests = 0
  const controllers = new Set<AbortController>()
  let providerObserved!: () => void
  const providerRequest = new Promise<void>((resolve) => {
    providerObserved = resolve
  })
  const output = join(root, 'workspace', 'ordinary-result.json')
  const server = createServer(async (request, response) => {
    const reject = (): void => {
      response.writeHead(400)
      response.end('Bounded ordinary fixture request rejected')
    }
    if (
      request.method !== 'POST' ||
      !request.url?.startsWith('/v1/messages') ||
      request.headers.authorization !== `Bearer ${token}`
    )
      return reject()
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 512000) return reject()
      chunks.push(Buffer.from(chunk))
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body & {
      stream: boolean
      max_tokens: number
      thinking?: unknown
    }
    if (
      !JSON.stringify(body.system).includes('EARTHNANO_ORDINARY_SEND') ||
      body.model !== 'deepseek-flash' ||
      !body.stream
    )
      return reject()
    if (++requests > 4) return reject()
    providerObserved()
    if (stop) return // The real native request remains owned until ordinary Stop is accepted.
    if (live) {
      const controller = new AbortController()
      controllers.add(controller)
      response.on('close', () => {
        if (!response.writableEnded) controller.abort()
      })
      try {
        body.max_tokens = Math.min(body.max_tokens, 768)
        body.thinking = { type: 'disabled' }
        const upstream = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)])
        })
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel()
          return reject()
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        for await (const chunk of upstream.body) response.write(chunk)
        response.end()
      } catch {
        if (!response.headersSent) reject()
        else response.end()
      } finally {
        controllers.delete(controller)
      }
    } else if (!JSON.stringify(body.messages).includes('call_ordinary_output'))
      send(
        response,
        body,
        { name: 'Write', input: { file_path: output, content: '{"answer":42}' } },
        'ordinary_output'
      )
    else send(response, body, { text: 'ORDINARY_COMPLETE' }, 'ordinary_final')
  })
  let runtime: AcpRuntimeCoordinator | undefined = undefined
  onTestFinished(async () => {
    await runtime?.shutdownForQuit()
    for (const controller of controllers) controller.abort()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await client.$disconnect()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  await migrateApplicationDatabase(client)
  await client.project.create({ data: { id: 'ordinary-project', name: 'Ordinary Send proof' } })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const workspace = join(root, 'workspace')
  const home = join(root, 'private-home')
  await mkdir(workspace)
  await mkdir(home)
  const native = createRequire(import.meta.url).resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`
  )
  const config = claudeCodeFramework.prepareModelConfig(
    {
      type: 'custom',
      model: 'deepseek-flash',
      key: token,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      apiEndpoints: ['messages']
    },
    { storageRoot: home, executablePath: native }
  )
  const cleanEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmpdir(),
    LANG: process.env.LANG,
    ...config.env,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1'
  }
  let runtimeExecutionId: string | undefined
  runtime = new AcpRuntimeCoordinator(
    (callbacks) => {
      const options = {
        defaultCwd: workspace,
        appVersion: 'ordinary-execution-integration',
        runtimeSessions,
        resolveBackend: () => ({
          framework: {
            ...claudeCodeFramework,
            spawn: (input: import('../agent-framework/types').AgentSpawnInput) =>
              claudeCodeFramework.spawn({
                ...input,
                spawnProcess: (command, args, options) =>
                  spawn(command, args, { ...options, env: cleanEnv, shell: false })
              })
          },
          executablePath: native,
          env: config.env ?? {},
          providerId: 'local-native',
          backendId: 'ordinary-native',
          contextUsageModel: 'deepseek-flash',
          sessionOptions: {
            settingSources: [],
            strictMcpConfig: true,
            mcpServers: {},
            maxTurns: 4,
            thinking: { type: 'disabled' }
          },
          systemPromptAppends: ['EARTHNANO_ORDINARY_SEND. Complete the explicit file request.']
        }),
        callbacks: {
          ...callbacks,
          onEvent: (event: import('../../shared/acp').AcpRuntimeEvent) => {
            runtimeSessions.accept(event)
            callbacks.onEvent?.(event)
          }
        }
      }
      const base = composeAcpRuntimeBaseOwners(options)
      return new AcpRuntime(options, base, composeAcpRuntimeSessionOwners(options, base))
    },
    {
      onPromptStarted: (_id, executionId) => {
        runtimeExecutionId = executionId
      }
    }
  )
  let promptContext: import('../../shared/acp').AgentTurnProvenanceContext | undefined = undefined
  let exported = false
  const host = createSessionExecutionHost({
    settings: new SettingsRepository(configRoot),
    versions,
    dataRoot,
    configRoot,
    getClient: async () => client,
    flush: async (sessionId, promptId) => {
      await runtimeSessions.flush(sessionId, promptId)
      if (stop || exported) return
      // Exercise original app-generated Artifact import of the actual native Write bytes, then
      // publish through the same original Session/provenance owner before canonical host evidence.
      const session = await load('ordinary-project', sessionId)
      if (!promptContext) throw new Error('Original prompt context unavailable')
      const context = promptContext
      const handle = await artifacts.openExecution({
        executionId: runtimeExecutionId!,
        workspaceCwd: workspace,
        appSessionId: sessionId,
        artifactStorageSessionId: sessionId,
        projectId: session.projectId,
        agentName: 'ordinary-native-fixture',
        provenanceContext: context
      })
      try {
        await artifacts.write(handle, {
          filename: 'ordinary-result.json',
          content: await readFile(output, 'utf8'),
          encoding: 'utf8'
        })
        const publication = await artifacts.finalize(handle)
        if (publication)
          await runtimeSessions.publish({ ...publication, executionId: runtimeExecutionId! })
        exported = true
      } finally {
        await artifacts.dispose(handle)
      }
    }
  })
  const boundary = createAcpExecutionBoundary({ host })
  runtime.setExecutionBoundary(boundary)
  const created = await createAcpCreateSessionWorkflow(runtime).create({
    cwd: workspace,
    projectId: 'ordinary-project',
    memoryEnabled: false,
    permissionProfile: 'full'
  })
  const now = Date.now()
  const promptId = 'ordinary-user-prompt'
  const idle = await coordinator.saveSession({
    id: created.sessionId,
    projectId: 'ordinary-project',
    title: 'Ordinary',
    cwd: workspace,
    status: 'idle',
    providerSessionId: created.providerSessionId,
    agentFrameworkId: 'claude-code',
    permissionProfile: 'full',
    memoryEnabled: false,
    autoReviewEnabled: false,
    messages: [],
    conversationGraph: createLinearConversationGraph({
      sessionId: created.sessionId,
      messages: [],
      frameworkId: 'claude-code',
      createdAt: now,
      updatedAt: now
    }),
    createdAt: now,
    updatedAt: now
  })
  const text = `Write exactly {"answer":42} to ${output} with the Write tool. Then reply ORDINARY_COMPLETE. This is an ordinary Send request.`
  let staged = applySessionConversationCommands(idle, [
    {
      id: 'ordinary-append',
      kind: 'append-user',
      timestamp: now,
      branchId: idle.conversationGraph!.branches[0].id,
      message: {
        id: promptId,
        role: 'user',
        content: text,
        status: 'complete',
        eventIds: [],
        createdAt: now,
        updatedAt: now
      }
    },
    {
      id: 'ordinary-start',
      kind: 'start-run',
      timestamp: now,
      run: { promptMessageId: promptId, startedAt: now }
    }
  ])
  let historicalFile: string | undefined
  if (resume) {
    // Simulate a dead previous application owner while preserving the original recovery facts.
    // No provider is started for this historical attempt; only the explicit Resume below dispatches.
    const original = structuredClone(staged)
    delete original.activeRun
    original.status = 'error'
    original.runtimeTranscriptOwner = 'main'
    original.resumeRecovery = {
      kind: 'resume-required',
      promptMessageId: promptId,
      cause: 'app-restart'
    }
    original.runtimeTranscriptLastRun = { promptMessageId: promptId, startedAt: now }
    for (const message of [...original.messages, ...original.conversationGraph!.messages])
      if (message.id === promptId)
        message.turnOutcome = {
          kind: 'interrupted',
          cause: 'app-restart',
          recovery: 'resume',
          settledAt: now + 1
        }
    const oldContext = getActiveConversationContext(original.conversationGraph!, promptId)!
    original.runtimeSessionAdmissions = [
      {
        executionId: 'historical-token',
        promptMessageId: promptId,
        promptRuntimeSegmentId: oldContext.runtimeSegmentId!,
        rootFrameId: oldContext.rootFrameId!,
        agentFrameId: oldContext.agentFrameId!,
        messageBranchId: oldContext.messageBranchId!,
        runtimeSegmentId: oldContext.runtimeSegmentId!
      }
    ]
    const interrupted = await sessions.saveSession(original)
    const attemptId = 'historical-attempt'
    const prepared = await host.prepare({
      attemptId,
      request: { sessionId: created.sessionId, text, provenanceContext: oldContext },
      operation: 'sendPrompt',
      runtimeReviewOwner: 'renderer',
      dispatch: async () => {
        throw new Error('Historical recovery must not replay')
      },
      cancelOwned: async () => undefined
    })
    const oldState = emptyExecutionState()
    const time = new Date().toISOString()
    const record: ExecutionRecord = {
      executionId: 'historical-execution',
      requestKey: prepared.request.requestKey,
      request: prepared.request,
      requestDigest: requestDigest(prepared.request),
      phase: 'running',
      cleanup: 'pending',
      identity: {
        sessionId: created.sessionId,
        promptMessageId: promptId,
        turnToken: 'historical-token'
      },
      createdAt: time,
      updatedAt: time,
      cancellationRequested: false,
      evidence: {
        status: 'unavailable',
        scope: 'original',
        text: '',
        artifacts: [],
        references: [],
        limitations: []
      },
      usage: { status: 'unknown' },
      configuration: {
        status: 'unknown',
        requestedDigest: prepared.request.harnessRevisionRef.digest,
        instructions: [],
        skills: [],
        tools: [],
        confirmation: 'unknown'
      }
    }
    oldState.records[record.executionId] = record
    oldState.events[record.executionId] = [
      { executionId: record.executionId, sequence: 1, type: 'phase', phase: 'running', time }
    ]
    oldState.sequences[record.executionId] = 1
    oldState.budgets[JSON.stringify([record.request.projectId, record.request.budgetRef])] = {
      limit: 1,
      admitted: 1
    }
    prepared.store.commit(oldState)
    prepared.close()
    historicalFile = join(
      dataRoot,
      'executions',
      'session-attempts',
      prepared.request.requestKey.split(':')[1],
      originalEvidenceDigest(attemptId).slice(7) + '.json'
    )
    await writeFile(historicalFile + '.lock', '2147483647') // Kernel ESRCH, never a live owner takeover.
    staged = applySessionConversationCommands(interrupted, [
      {
        id: 'explicit-resume',
        kind: 'resume-run',
        timestamp: now + 2,
        run: { promptMessageId: promptId, startedAt: now + 2 }
      }
    ])
  }
  if (resume)
    await coordinator.saveSession(staged, {
      conversationCommands: [
        {
          id: 'explicit-resume',
          kind: 'resume-run',
          timestamp: now + 2,
          run: { promptMessageId: promptId, startedAt: now + 2 }
        }
      ]
    })
  else await coordinator.admitTaskTurn({ session: staged, contextReset: false })
  // This is the real entry used by ordinary Send; no TaskRunner, candidate driver or outer scope.
  promptContext = getActiveConversationContext(staged.conversationGraph!, promptId)!
  await runtime.startPrompt({
    sessionId: created.sessionId,
    text,
    provenanceContext: getActiveConversationContext(staged.conversationGraph!, promptId)!,
    memoryEnabled: false,
    parts: [{ type: 'text', text }],
    contextReset: true
  })
  await providerRequest
  if (stop) await runtime.cancelPrompt({ sessionId: created.sessionId })
  await expect
    .poll(
      async () => {
        const session = await load('ordinary-project', created.sessionId)
        return session.activeRun
      },
      { timeout: live ? 120000 : 20000 }
    )
    .toBeUndefined()
  const journals = async (): Promise<
    Array<{ file: string; state: import('./execution-core').ExecutionState }>
  > => {
    const base = join(dataRoot, 'executions', 'session-attempts')
    const files = (
      await Promise.all(
        (await readdir(base)).map(async (generation) =>
          (await readdir(join(base, generation)))
            .filter((file) => file.endsWith('.json'))
            .map((file) => join(base, generation, file))
        )
      )
    ).flat()
    return Promise.all(
      files.map(async (file) => ({ file, state: JSON.parse(await readFile(file, 'utf8')) }))
    )
  }
  await expect
    .poll(
      async () =>
        (await journals()).some(({ state }) =>
          Object.values(state.records).some(
            (record) =>
              record.executionId !== 'historical-execution' &&
              ['completed', 'failed', 'cancelled'].includes(record.phase)
          )
        ),
      { timeout: live ? 120000 : 20000 }
    )
    .toBe(true)
  const { state } = (await journals()).find(({ state }) =>
    Object.values(state.records).some((record) => record.executionId !== 'historical-execution')
  )!
  const record = Object.values(state.records)[0] as ExecutionRecord
  if (resume) {
    const old = JSON.parse(await readFile(historicalFile!, 'utf8'))
    expect(old.records['historical-execution']).toMatchObject({
      phase: 'interrupted',
      cleanup: 'confirmed',
      evidence: { status: 'partial' }
    })
    expect((Object.values(old.budgets)[0] as { admitted: number }).admitted).toBe(1)
    expect((await journals()).flatMap(({ state }) => Object.values(state.records))).toHaveLength(2)
  }
  expect(Object.keys(state.records)).toHaveLength(1)
  expect(Object.values(state.budgets)).toEqual([{ limit: 1, admitted: 1 }])
  expect(record, JSON.stringify(record)).toMatchObject({
    phase: stop ? 'cancelled' : 'completed',
    cleanup: 'confirmed',
    request: {
      role: 'task',
      timeoutMs: 0,
      origin: { kind: 'interactive' },
      interactionPolicy: 'interactive'
    },
    identity: { sessionId: created.sessionId, promptMessageId: promptId }
  })
  expect(
    state.events[record.executionId].filter(
      (event: { type: string }) => event.type === 'session-admitted'
    )
  ).toHaveLength(1)
  expect(
    state.events[record.executionId].filter(
      (event: { type: string }) => event.type === 'provider-accepted'
    )
  ).toHaveLength(1)
  const original = await load('ordinary-project', created.sessionId)
  expect(original.runtimeSessionAdmissions).toHaveLength(resume ? 2 : 1)
  expect(original.messages.find((message) => message.id === promptId)?.turnOutcome?.kind).toBe(
    stop ? 'cancelled' : 'completed'
  )
  expect(await client.review.count()).toBe(0)
  if (!stop) {
    // Exercise the actual coordinator's onPromptStarted observer, not a test-supplied Core
    // identity. Only the original live runtime token may authorize these logical turn totals.
    expect(record.usage.status).toBe('known')
    const originalUsage = readExecutionTurnUsage(original, record.identity)
    expect(originalUsage).toBeDefined()
    expect(record.usage).toEqual({
      status: 'known',
      inputTokens: originalUsage!.usage.inputTokens,
      cacheTokens: originalUsage!.usage.cacheTokens,
      outputTokens: originalUsage!.usage.outputTokens,
      ...(originalUsage!.usage.cachedReadTokens === undefined ||
      originalUsage!.usage.cachedWriteTokens === undefined
        ? {}
        : {
            cachedReadTokens: originalUsage!.usage.cachedReadTokens,
            cachedWriteTokens: originalUsage!.usage.cachedWriteTokens
          }),
      ...(originalUsage!.usage.turnCount === undefined
        ? {}
        : { modelTurns: originalUsage!.usage.turnCount }),
      source: {
        scope: 'logical-prompt',
        sessionId: original.id,
        promptMessageId: promptId,
        ownerMessageId: originalUsage!.ownerMessageId
      }
    })
    expect(record.usage.inputTokens).toBeGreaterThan(0)
    expect(record.usage.outputTokens).toBeGreaterThan(0)
    expect(record.usage.apiRequests).toBeUndefined()
    expect(record.usage.costMicrousd).toBeUndefined()
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ answer: 42 })
    expect(record.evidence.artifacts).toHaveLength(1)
    const reader = createOriginalTurnEvidenceReader({ dataRoot, versions, load })
    const pinned = await reader.pinnedTurn(record)
    expect(originalTurnReply(pinned)).toContain('ORDINARY_COMPLETE')
    const artifact = record.evidence.artifacts[0]
    const lease = await versions.openVersion(
      { source: 'artifact', projectId: 'ordinary-project', fileId: artifact.artifactId },
      artifact.versionId
    )
    try {
      expect(lease.version.checksum).toBe(artifact.checksum)
      expect(
        JSON.parse(Buffer.from(await lease.readRange(0, lease.size)).toString('utf8'))
      ).toEqual({ answer: 42 })
      await lease.verifyUnchanged()
    } finally {
      await lease.close()
    }
  }
  expect(record.identity.runtimeExecutionId).toBe(runtimeExecutionId)
  expect(record.identity.turnToken).toBe(runtimeExecutionId)
  expect(runtime.getSnapshot().sessionIds).toContain(created.sessionId)
  expect(await boundary.settle()).toBe(true)
  if (live && process.env.EARTHNANO_LIVE_ORDINARY_REPORT)
    await writeFile(
      process.env.EARTHNANO_LIVE_ORDINARY_REPORT,
      JSON.stringify(
        {
          source: 'AcpRuntimeCoordinator.startPrompt',
          requests,
          record,
          originalTurnOutcome: original.messages.find((message) => message.id === promptId)
            ?.turnOutcome,
          autoReviews: await client.review.count(),
          methodCalls: 0,
          artifactsImportedBy: 'original ArtifactTurnOwner fixture bridge'
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    )
}
it.skipIf(process.platform === 'win32')(
  'runs native ordinary Send through shared Core and original durable evidence',
  () => runOrdinary(false),
  60000
)
it.skipIf(process.platform === 'win32')(
  'cancels the exact native ordinary Send without retiring its shared runtime',
  () => runOrdinary(false, true),
  60000
)
it.skipIf(
  process.platform === 'win32' ||
    process.env.EARTHNANO_LIVE_DEEPSEEK !== '1' ||
    !process.env.EARTHNANO_LIVE_DEEPSEEK_KEY_FILE
)(
  'runs explicitly authorized ordinary Send against bounded DeepSeek',
  () => runOrdinary(true),
  180000
)

it.skipIf(process.platform === 'win32')(
  'reconciles original interrupted owner before one explicitly resumed native execution',
  () => runOrdinary(false, false, true),
  60000
)

it.each(['missing', 'corrupt'] as const)(
  'rejects %s original config-root Session JSON despite a valid data-root decoy',
  async (condition) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'earthnano-session-authority-')))
    const configRoot = join(root, 'config')
    const dataRoot = join(root, 'data')
    await Promise.all([mkdir(configRoot), mkdir(dataRoot)])
    initDataRoot(dataRoot)
    const client = createProjectDbClient(configRoot)
    onTestFinished(async () => {
      await client.$disconnect()
      await rm(root, { recursive: true, force: true })
    })
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project', name: 'Original authority' } })
    const original: import('../../shared/session-persistence').PersistedChatSession = {
      id: 'session',
      projectId: 'project',
      title: 'Original',
      cwd: dataRoot,
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      conversationGraph: createLinearConversationGraph({
        sessionId: 'session',
        messages: [],
        createdAt: 1,
        updatedAt: 1
      })
    }
    const repository = new SessionRepository(
      configRoot,
      {},
      new SessionProjectionRepository(async () => client)
    )
    await repository.saveSession(original)
    // Neither a stale catalog row nor a file under the scientific-data root may stand in for
    // the original production Session JSON authority.
    await new SessionRepository(dataRoot).saveSession(original)
    const filename = join(configRoot, 'sessions', 'project', 'session.json')
    if (condition === 'missing') await rm(filename)
    else await writeFile(filename, '{broken JSON')
    expect((await loadSessionMutationAuthority(repository, 'project', 'session')).status).toBe(
      condition === 'missing' ? 'missing' : 'unreadable'
    )
    const dispatch = vi.fn()
    const host = createSessionExecutionHost({
      dataRoot,
      configRoot,
      getClient: async () => client,
      settings: new SettingsRepository(configRoot),
      versions: new ManagedFileVersionService({
        storageRoot: dataRoot,
        getClient: async () => client
      })
    })
    await expect(
      host.prepare({
        attemptId: 'first-send',
        request: { sessionId: 'session', text: 'Original task' },
        operation: 'sendPrompt',
        runtimeReviewOwner: 'renderer',
        dispatch,
        cancelOwned: async () => undefined
      })
    ).rejects.toThrow('Original Session is unavailable')
    expect(dispatch).not.toHaveBeenCalled()
    await expect(readdir(join(dataRoot, 'executions'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
)
