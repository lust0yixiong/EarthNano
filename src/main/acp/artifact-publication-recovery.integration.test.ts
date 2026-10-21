import { tmpdir } from 'node:os'
import { expect, it, onTestFinished, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: true } }))
import { getActiveConversationContext } from '../../shared/conversation-graph'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { applySessionConversationCommands } from '../../shared/session-conversation-command'
import { attachRuntimeSessionArtifacts } from '../../shared/runtime-session-projection'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { createArtifactHandlers } from '../artifacts/ipc'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { UploadRepository } from '../uploads/repository'
import { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { SessionRepository, loadSessionMutationAuthority } from '../session-persistence/repository'
import { RuntimeSessionOwner } from '../session-persistence/runtime-session-owner'
import { createFrameNotebookLane } from '../notebook/lane-identity'
import { initDataRoot } from '../storage-root'
import { ArtifactTurnOwner } from './artifact-turn-owner'

it.each([
  'before-runtime-flush',
  'after-exact-claim',
  'cold-process',
  'different-active-prompt',
  'partial-claim',
  'competing-claim'
] as const)(
  'keeps prepared Artifact recovery subordinate to the original runtime publication: %s',
  async (scenario) => {
    const f = await createProvenanceTestFixture()
    onTestFinished(() => f.dispose())
    initDataRoot(f.storageRoot)
    await f.client.project.create({
      data: { id: 'project-1', name: 'Original publication owners' }
    })
    let attached = true
    const sessions = new SessionRepository(f.storageRoot, { hasLiveRuntimeSession: () => attached })
    const load = async (): Promise<PersistedChatSession> => {
      const current = await loadSessionMutationAuthority(sessions, 'project-1', 'session-1')
      if (current.status !== 'found') throw new Error('Original Session is unavailable')
      return current.session
    }
    const provenance = new ArtifactProvenanceRepository({
      ...f.repositoryOptions,
      loadSession: load
    })
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      new ManagedFileIndexRepository(
        async () => f.client,
        f.storageRoot,
        new ManagedFileVersionService({
          storageRoot: f.storageRoot,
          getClient: async () => f.client
        }),
        new UploadRepository(f.storageRoot, { getClient: async () => f.client })
      ),
      undefined,
      undefined,
      undefined,
      provenance
    )
    const staged = materializeSessionConversationGraph({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Ordinary Send',
      cwd: f.storageRoot,
      status: 'running',
      activeRun: { promptMessageId: 'prompt', startedAt: 1 },
      agentFrameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: 'prompt',
          role: 'user',
          content: 'Analyze and publish',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'preface',
          role: 'agent',
          responseToMessageId: 'prompt',
          content: "I'll start by listing the runtimes.",
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ]
    })
    await coordinator.saveSession(staged)
    await coordinator.admitTaskTurn({ session: staged, contextReset: false })
    const context = getActiveConversationContext(staged.conversationGraph!, 'prompt')!
    const registry = new ArtifactRunRegistry()
    const handlers = createArtifactHandlers(f.compatibilityRepository, registry, { provenance })
    const scope = {
      ...context,
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'prompt',
      executionId: 'runtime-execution'
    }
    const runtime = new RuntimeSessionOwner({
      loadSession: load,
      mutateSession: (scope, mutate) => coordinator.mutateRuntimeSession(scope, mutate),
      scheduleFlush: () => () => undefined,
      finalizeArtifacts: async (request) => {
        if (scenario === 'after-exact-claim') await coordinator.loadAll()
        return handlers.finalizeRunArtifacts(request)
      }
    })
    await runtime.begin(scope)
    const turns = new ArtifactTurnOwner({
      dataRoot: f.storageRoot,
      repository: f.compatibilityRepository,
      runRegistry: registry,
      provenance
    })
    const handle = await turns.openRootExecution({
      executionId: scope.executionId,
      workspaceCwd: f.storageRoot,
      appSessionId: scope.sessionId,
      artifactStorageSessionId: 'artifact-session',
      projectId: scope.projectId,
      agentName: 'Original agent',
      provenanceContext: context
    })
    onTestFinished(() => turns.dispose(handle))
    const artifactRunId = turns.snapshot(handle).runId
    const lane = createFrameNotebookLane(scope.projectId, scope.sessionId, context.agentFrameId)
    await f.notebookRepository.loadOrCreate({
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      lane,
      workspaceCwd: f.storageRoot
    })
    await f.notebookRepository.appendRun({
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      lane,
      run: {
        runId: 'producer',
        executionInvocationId: 'original-notebook-invocation',
        cellId: 'cell',
        source: 'agent',
        kernelKind: 'python',
        status: 'completed',
        script: 'publish_report()',
        startedAt: 2,
        endedAt: 3,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        workingFiles: [],
        ...context
      }
    })
    const writeRequest = {
      projectId: scope.projectId,
      appSessionId: scope.sessionId,
      artifactStorageSessionId: 'artifact-session',
      artifactRunId,
      writeOperationId: 'original-write',
      ...context,
      notebookSessionId: scope.sessionId,
      producerRunId: 'producer',
      filename: 'research-results.json',
      contentType: 'application/json',
      source: {
        kind: 'inline',
        content: Buffer.from('{"count":3}').toString('base64'),
        encoding: 'base64'
      }
    } as const
    const version = await provenance.saveVersion(writeRequest, { allowedImportRoots: [] })
    const otherVersion =
      scenario === 'partial-claim' || scenario === 'competing-claim'
        ? await provenance.saveVersion(
            { ...writeRequest, writeOperationId: 'second-write', filename: 'other-results.json' },
            { allowedImportRoots: [] }
          )
        : undefined
    if (scenario !== 'different-active-prompt')
      runtime.accept({
        id: 'final-event',
        timestamp: 4,
        kind: 'message',
        level: 'info',
        sessionId: scope.sessionId,
        promptMessageId: scope.promptMessageId,
        messageId: 'final-reply',
        role: 'assistant',
        text: 'Research analysis complete.'
      })
    const publication = await turns.finalize(handle)
    expect(publication?.artifacts.map((file) => file.versionId).sort()).toEqual(
      [version.versionId, ...(otherVersion ? [otherVersion.versionId] : [])].sort()
    )
    const before = await f.compatibilityRepository.findRunFinalizationMarker(
      scope.projectId,
      artifactRunId
    )
    expect(before?.messageId).toBeUndefined()
    if (otherVersion) {
      await runtime.flush(scope.sessionId, scope.promptMessageId)
      const finalMessage = (await load()).messages.find(
        (message) => message.content === 'Research analysis complete.'
      )!
      await coordinator.mutateRuntimeSession(scope, (latest) => {
        const partial = attachRuntimeSessionArtifacts(latest, scope, {
          messageId: finalMessage.id,
          eventId: 'partial-claim',
          runId: artifactRunId,
          artifacts: publication!.artifacts.filter((file) => file.versionId === version.versionId),
          timestamp: 5
        }).session
        return scenario === 'competing-claim'
          ? attachRuntimeSessionArtifacts(partial, scope, {
              messageId: 'preface',
              eventId: 'competing-claim',
              runId: artifactRunId,
              artifacts: publication!.artifacts.filter(
                (file) => file.versionId === otherVersion.versionId
              ),
              timestamp: 5
            }).session
          : partial
      })
      await coordinator.loadAll()
      expect(
        await f.client.artifactVersion.findMany({
          where: { id: { in: [version.versionId, otherVersion.versionId] } }
        })
      ).toEqual([
        expect.objectContaining({ state: 'pending', messageId: null }),
        expect.objectContaining({ state: 'pending', messageId: null })
      ])
      return
    }
    if (scenario === 'cold-process') attached = false
    if (scenario === 'different-active-prompt') {
      await runtime.commitTerminal(
        {
          id: 'old-stop',
          timestamp: 4,
          kind: 'stop',
          level: 'info',
          sessionId: scope.sessionId,
          promptMessageId: scope.promptMessageId,
          title: 'Prompt stopped',
          text: 'end_turn'
        },
        () => {}
      )
      await coordinator.mutateRuntimeSession(scope, (latest) =>
        applySessionConversationCommands(latest, [
          {
            id: 'later-prompt',
            kind: 'append-user',
            timestamp: 5,
            branchId: context.messageBranchId,
            parentMessageId: 'preface',
            message: {
              id: 'next-prompt',
              role: 'user',
              content: 'Another task',
              status: 'complete',
              eventIds: [],
              createdAt: 5,
              updatedAt: 5
            }
          },
          {
            id: 'later-run',
            kind: 'start-run',
            timestamp: 5,
            run: { promptMessageId: 'next-prompt', startedAt: 5 }
          }
        ])
      )
    }
    if (scenario !== 'after-exact-claim') await coordinator.loadAll()
    if (scenario === 'cold-process' || scenario === 'different-active-prompt') {
      if (scenario === 'cold-process') expect((await load()).activeRun).toBeUndefined()
      else expect((await load()).activeRun?.promptMessageId).toBe('next-prompt')
      expect(
        await f.client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
      ).toMatchObject({ state: 'finalized', messageId: 'preface' })
      return
    }
    // The final provider reply is accepted but not yet flushed when the prepared marker becomes
    // visible to a concurrent hydration. A commentary-only durable prefix is not terminal authority.
    const beforePublication = await f.client.artifactVersion.findUniqueOrThrow({
      where: { id: version.versionId }
    })
    const receipt = await runtime.publish({ ...publication!, executionId: scope.executionId })
    expect(beforePublication).toMatchObject({ state: 'pending', messageId: null })
    expect(receipt.messageId).not.toBe('preface')
    expect(
      await f.client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).toMatchObject({ state: 'finalized', messageId: receipt.messageId })
    await runtime.commitTerminal(
      {
        id: 'final-stop',
        timestamp: 6,
        kind: 'stop',
        level: 'info',
        sessionId: scope.sessionId,
        promptMessageId: scope.promptMessageId,
        title: 'Prompt stopped',
        text: 'end_turn'
      },
      () => {}
    )
    const saved = await load()
    expect(saved.activeRun).toBeUndefined()
    expect(saved.status).toBe('idle')
    expect(saved.error).toBeUndefined()
    expect(saved.messages.find((message) => message.id === receipt.messageId)?.content).toBe(
      'Research analysis complete.'
    )
    expect(
      saved.messages.find((message) => message.id === 'preface')?.artifactIds ?? []
    ).not.toContain(version.versionId)
    expect(
      saved.messages.find((message) => message.id === receipt.messageId)?.artifactIds
    ).toContain(version.versionId)
    // Preserve the immutable proof: even a valid earlier Message in this same turn cannot take it.
    await expect(
      provenance.finalizeRun({
        projectId: scope.projectId,
        appSessionId: scope.sessionId,
        artifactRunId,
        artifactVersionIds: [version.versionId],
        ...context,
        messageId: 'preface'
      })
    ).rejects.toThrow('already finalized to a different message')
  }
)
