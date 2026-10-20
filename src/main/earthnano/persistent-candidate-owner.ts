import { readSemanticSourceVersions, type SemanticSourceEvidence } from './semantic-source-evidence'
import type { CandidateSnapshotStore } from './candidate-snapshot'
import { createAcpNotebookBinding } from '../acp/notebook-binding'
import { ConversationPermissionGrantStore } from '../acp/permission-broker'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import type { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { NotebookRunRepository } from '../notebook/repository'
import type { FileReference } from '../../shared/artifacts'
import type { NotebookRunInputFile } from '../../shared/notebook'
import {
  normalizeFrozenNotebookInputs,
  normalizeFrozenNotebookRuntime,
  type FrozenNotebookInput
} from '../../shared/earthnano/notebook-profile'
import { createAcpExecutionBoundary } from './acp-execution-boundary'
import { createSessionExecutionHost } from './session-execution-host'
import {
  createOriginalTurnEvidenceReader,
  originalEvidenceCanonical as canonical,
  originalEvidenceDigest as digest,
  originalTurnReply as turnReply
} from './original-turn-evidence'
import { constants, realpathSync } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import type { ArtifactReference, ExecutionRecord, Ref } from '../../shared/earthnano/execution-port'
import type { NewCheck, ReviewWithChecks } from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  createLinearConversationGraph,
  getActiveConversationContext
} from '../../shared/conversation-graph'
import { applySessionConversationCommands } from '../../shared/session-conversation-command'
import { ArtifactTurnOwner } from '../acp/artifact-turn-owner'
import { createAcpCreateSessionWorkflow } from '../acp/create-session-workflow'
import { AcpRuntime } from '../acp/runtime'
import { AcpRuntimeCoordinator } from '../acp/runtime-coordinator'
import type { AcpRuntimeOptions } from '../acp/runtime-contract'
import { composeAcpRuntimeBaseOwners } from '../acp/runtime-base-composition'
import { composeAcpRuntimeSessionOwners } from '../acp/runtime-session-composition'
import { createAcpTaskAgentPort } from '../acp/task-agent-port'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ArtifactRepository } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { resolveDataRoot } from '../storage-root'
import { ProjectRepository } from '../projects/repository'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { ReviewRepository } from '../reviewer/repository'
import { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { SessionProjectionRepository } from '../session-persistence/projection'
import { loadSessionMutationAuthority, SessionRepository } from '../session-persistence/repository'
import { RuntimeSessionOwner } from '../session-persistence/runtime-session-owner'
import { UploadRepository } from '../uploads/repository'
import type { ClaudeCandidateDriverOptions, ClaudeCandidateOwner } from './claude-candidate-driver'
import {
  parseSemanticAssessment,
  semanticCriteria,
  semanticDigest,
  semanticCanonical,
  type SemanticAssessmentDocument
} from './semantic-evaluation'
import { validateRecord, requestDigest } from './execution-contract'
import {
  normalizeOutputChecks,
  type OutputCheckSpec
} from '../../shared/earthnano/research-outcome'
import { checkOutputFiles, outputDigest } from './output-checks'

export interface PersistentCandidateNotebookOptions {
  service: NotebookRuntimeService
  rpc: NotebookLocalRpcServer
  mcpEntryPath: string
}
export interface PersistentCandidateOwnersOptions {
  dataRoot: string
  notebook?: PersistentCandidateNotebookOptions
  /** Share the application's original Session persistence and serialization authority. */
  sessionPersistence?: {
    repository: SessionRepository
    coordinator: SessionPersistenceCoordinator
  }
  /** Database initialization/migration remains the host's responsibility. */
  configRoot: string
  getClient(): Promise<PrismaClient>
  /** Optional instrumentation of the existing runtime, never an alternative result authority. */
  runtimeFactory?(options: AcpRuntimeOptions): AcpRuntime
}
export interface PersistentCandidateFile {
  path: string
  content: string
  digest: string
  artifactRef: ArtifactReference
}
export interface PersistentCandidateResult {
  executionId: string
  artifacts: ArtifactReference[]
  replyText: string
  trajectoryText: string
  files: PersistentCandidateFile[]
}
export interface PersistentCandidateOwners {
  openOwner: ClaudeCandidateDriverOptions['openOwner']
  exportResult(record: ExecutionRecord): Promise<PersistentCandidateResult>
  readReviews(record: ExecutionRecord): Promise<ReviewWithChecks[]>
  readSemanticSourceEvidence(input: {
    target: ExecutionRecord
    snapshots: CandidateSnapshotStore
    signal?: AbortSignal
  }): Promise<SemanticSourceEvidence>
  commitDeterministicReview?(input: {
    target: ExecutionRecord
    checks: OutputCheckSpec[]
    signal?: AbortSignal
  }): Promise<{ reviewId: string; outcome: 'pass' | 'flagged' }>
  commitSemanticReview(input: {
    target: ExecutionRecord
    assessment: ExecutionRecord
    criteria: string
    criteriaDigest: string
    document: SemanticAssessmentDocument
    sourceEvidence?: SemanticSourceEvidence
    snapshots?: CandidateSnapshotStore
    signal?: AbortSignal
  }): Promise<{ reviewId: string; outcome: 'pass' | 'flagged' }>
  shutdown(): Promise<{ reaped: boolean }>
}
const filenamePrefix = 'candidate-output--'
const logicalPath = (path: string): string => {
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid candidate output path')
  return path
}
const encodeName = (path: string): string => {
  const name = filenamePrefix + encodeURIComponent(logicalPath(path))
  if (Buffer.byteLength(name) > 240)
    throw new Error('Candidate output path exceeds supported Artifact filename length')
  return name
}
const decodeName = (name: string): string => {
  if (!name.startsWith(filenamePrefix)) throw new Error('Artifact is not a candidate output')
  const path = logicalPath(decodeURIComponent(name.slice(filenamePrefix.length)))
  if (encodeName(path) !== name) throw new Error('Noncanonical candidate output path')
  return path
}
/** Import only bounded, ordinary UTF-8 outputs. Immutable ArtifactVersion bytes become the authority. */
const collectOutputs = async (root: string): Promise<Array<{ path: string; content: string }>> => {
  const files: Array<{ path: string; content: string }> = []
  let total = 0
  const walk = async (directory: string, prefix = ''): Promise<void> => {
    const dir = await lstat(directory)
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Invalid output directory')
    for (const name of (await readdir(directory)).sort()) {
      const path = logicalPath(prefix + name)
      const absolute = join(directory, name)
      const before = await lstat(absolute)
      if (before.isSymbolicLink()) throw new Error('Linked output is unsupported')
      if (before.isDirectory()) {
        await walk(absolute, path + '/')
        continue
      }
      if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024 || files.length >= 64)
        throw new Error('Unsupported candidate output')
      encodeName(path)
      const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const stat = await handle.stat()
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.ino !== before.ino ||
          stat.dev !== before.dev
        )
          throw new Error('Output changed while importing')
        const bytes = await handle.readFile()
        total += bytes.length
        const after = await handle.stat()
        if (
          bytes.length > 1024 * 1024 ||
          total > 4 * 1024 * 1024 ||
          stat.size !== after.size ||
          stat.mtimeMs !== after.mtimeMs ||
          stat.ctimeMs !== after.ctimeMs
        )
          throw new Error('Output changed or exceeded import budget')
        files.push({
          path,
          content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
        })
      } finally {
        await handle.close()
      }
    }
  }
  await walk(root)
  if (new Set(files.map((file) => file.path.normalize('NFC').toLowerCase())).size !== files.length)
    throw new Error('Colliding output paths')
  return files
}

/** Explicit internal production binding; no default desktop/bootstrap or provider settings change. */
export function createPersistentCandidateOwners(
  options: PersistentCandidateOwnersOptions
): PersistentCandidateOwners {
  if (realpathSync(options.dataRoot) !== realpathSync(resolveDataRoot()))
    throw new Error('Persistent candidate host data root differs from repository root')
  const projects = new ProjectRepository(options.getClient, options.configRoot)
  const assertProject = async (id: string): Promise<void> => {
    const project = await projects.get(id)
    if (!project || project.archivedAt) throw new Error('Candidate Project is unavailable')
  }
  const versions = new ManagedFileVersionService({
    storageRoot: options.dataRoot,
    getClient: options.getClient
  })
  const compatibility = new ArtifactRepository(options.dataRoot)
  const uploads = new UploadRepository(options.dataRoot, { getClient: options.getClient })
  const index = new ManagedFileIndexRepository(
    options.getClient,
    options.dataRoot,
    versions,
    uploads
  )
  const sessions =
    options.sessionPersistence?.repository ??
    new SessionRepository(
      options.configRoot,
      {},
      new SessionProjectionRepository(options.getClient)
    )
  const coordinator =
    options.sessionPersistence?.coordinator ?? new SessionPersistenceCoordinator(sessions, index)
  const reviews = new ReviewRepository(options.getClient, { snapshotStorageRoot: options.dataRoot })
  const load = async (projectId: string, sessionId: string): Promise<PersistedChatSession> => {
    const result = await loadSessionMutationAuthority(sessions, projectId, sessionId)
    if (result.status !== 'found') throw new Error('Durable candidate Session is unavailable')
    return result.session
  }
  const provenance = new ArtifactProvenanceRepository({
    storageRoot: options.dataRoot,
    getClient: options.getClient,
    compatibilityRepository: compatibility,
    loadSession: (projectId, appSessionId) => load(projectId, appSessionId)
  })
  const notebookRuns = new NotebookRunRepository(options.dataRoot)
  const notebookSessions = new Map<
    AcpRuntimeCoordinator,
    () => { projectId: string; sessionId: string; workspaceCwd: string } | undefined
  >()
  const notebookPolicyReleases = new Map<AcpRuntimeCoordinator, () => void>()
  const runtimeLivenessReleases = new Map<AcpRuntimeCoordinator, () => void>()
  const runtimes = new Set<AcpRuntimeCoordinator>()
  const shutdowns = new Map<AcpRuntimeCoordinator, Promise<{ reaped: boolean }>>()
  let closing = false
  const stop = (runtime: AcpRuntimeCoordinator): Promise<{ reaped: boolean }> => {
    let pending = shutdowns.get(runtime)
    if (!pending) {
      const notebookScope = notebookSessions.get(runtime)?.()
      pending = Promise.allSettled([
        runtime.shutdownForQuit(),
        ...(notebookScope && options.notebook
          ? [options.notebook.service.shutdown(notebookScope)]
          : [])
      ]).then((results) => {
        const reaped =
          results.every((result) => result.status === 'fulfilled') &&
          results[0].status === 'fulfilled' &&
          (results[0].value as { reaped: boolean }).reaped
        if (reaped) {
          runtimeLivenessReleases.get(runtime)?.()
          runtimeLivenessReleases.delete(runtime)
          notebookPolicyReleases.get(runtime)?.()
          notebookPolicyReleases.delete(runtime)
        }
        return { reaped }
      })
      shutdowns.set(runtime, pending)
    }
    return pending
  }
  const {
    scopeSnapshot,
    pinnedTurn,
    artifacts: turnArtifacts
  } = createOriginalTurnEvidenceReader({
    dataRoot: options.dataRoot,
    load,
    versions
  })
  const readFiles = async (
    record: Pick<ExecutionRecord, 'request' | 'evidence'>,
    scientific = record.evidence.references?.some((ref) =>
      ref.id.startsWith('notebook-scientific:')
    ) ?? false
  ): Promise<PersistentCandidateFile[]> => {
    const files: PersistentCandidateFile[] = []
    if (record.evidence.artifacts.length > 64)
      throw new Error('Candidate artifact inventory exceeds text export profile')
    let total = 0
    for (const artifactRef of record.evidence.artifacts) {
      const lease = await versions.openVersion(
        { source: 'artifact', projectId: record.request.projectId, fileId: artifactRef.artifactId },
        artifactRef.versionId
      )
      try {
        if (lease.version.checksum !== artifactRef.checksum || lease.size > 1024 * 1024)
          throw new Error('Artifact version integrity mismatch')
        total += lease.size
        if (total > 4 * 1024 * 1024)
          throw new Error('Candidate artifacts exceed text export profile')
        // The original immutable lease forbids empty ranges. A zero-byte Version has exact
        // empty content; still verify its original lease and checksum before exporting it.
        const bytes = lease.size === 0 ? Buffer.alloc(0) : await lease.readRange(0, lease.size)
        await lease.verifyUnchanged()
        if (digest(bytes) !== 'sha256:' + artifactRef.checksum)
          throw new Error('Artifact version bytes changed')
        files.push({
          path: scientific
            ? logicalPath(lease.version.filename)
            : decodeName(lease.version.filename),
          content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
          digest: digest(bytes),
          artifactRef: structuredClone(artifactRef)
        })
      } finally {
        await lease.close()
      }
    }
    return files
  }
  const readSemanticSourceEvidence: PersistentCandidateOwners['readSemanticSourceEvidence'] =
    async (input) => {
      const target = structuredClone(input.target)
      const { snapshots, signal } = input
      signal?.throwIfAborted()
      validateRecord(target)
      if (
        !['baseline', 'candidate'].includes(target.request.role) ||
        target.phase !== 'completed' ||
        target.cleanup !== 'confirmed' ||
        target.requestDigest !== requestDigest(target.request)
      )
        throw new Error('Semantic sources require a completed original scientific target')
      await pinnedTurn(target)
      const frozen = await snapshots.resolve(target.request)
      if (frozen.harness.tools !== 'notebook-python')
        throw new Error('Target has no host-frozen scientific profile')
      return readSemanticSourceVersions({
        versions,
        projectId: target.request.projectId,
        inputs: normalizeFrozenNotebookInputs(frozen.task.managedInputs),
        signal
      })
    }
  const openOwner: ClaudeCandidateDriverOptions['openOwner'] = async ({
    prepared,
    materialized,
    request,
    context
  }) => {
    if (closing) throw new Error('Candidate owner factory is shutting down')
    const scientific = materialized.snapshots.harness.tools === 'notebook-python'
    const science = scientific ? options.notebook : undefined
    const frozenInputs = scientific
      ? normalizeFrozenNotebookInputs(materialized.snapshots.task.managedInputs)
      : []
    const frozenRuntime = scientific
      ? normalizeFrozenNotebookRuntime(materialized.snapshots.environment.notebook?.runtime)
      : undefined
    if (scientific && (!science || !['baseline', 'candidate'].includes(request.role)))
      throw new Error('Scientific candidate original Notebook owners unavailable')
    const grants = new ConversationPermissionGrantStore()
    const frozenReferences: FileReference[] = frozenInputs.map((input) => ({
      id: input.inputFileVersionId,
      source: input.sourceKind === 'upload-version' ? 'upload' : 'artifact',
      sourceFileId: input.sourceFileId,
      versionId: input.inputFileVersionId,
      name: input.filename,
      path: '',
      checksum: input.checksum
    }))
    const verifyFrozenInputs = async (): Promise<void> => {
      for (const input of frozenInputs) {
        if (input.sourceProjectId !== request.projectId)
          throw new Error('Foreign scientific input Project')
        const lease = await versions.openVersion(
          {
            source: input.sourceKind === 'upload-version' ? 'upload' : 'artifact',
            projectId: request.projectId,
            fileId: input.sourceFileId
          },
          input.inputFileVersionId
        )
        try {
          if (
            lease.logicalFile.sessionId !== input.sourceSessionId ||
            lease.logicalFile.projectId !== input.sourceProjectId ||
            lease.logicalFile.id !== input.sourceFileId ||
            lease.version.id !== input.inputFileVersionId ||
            lease.version.filename !== input.filename ||
            lease.size !== input.sizeBytes ||
            lease.version.checksum !== input.checksum
          )
            throw new Error('Scientific input differs from frozen Version')
          await lease.verifyUnchanged()
        } finally {
          await lease.close()
        }
      }
    }
    const registry = new ArtifactRunRegistry()
    const artifactOwner = new ArtifactTurnOwner({
      dataRoot: options.dataRoot,
      repository: compatibility,
      provenance,
      runRegistry: registry
    })
    let runtimeExecutionId: string | undefined
    let promptAttemptId: string | undefined
    let admitted = false
    let activeToken: string | undefined
    let sessionId: string | undefined
    const promptMessageId = `candidate-prompt-${context.executionId}`
    const runtimeSessions = new RuntimeSessionOwner({
      loadSession: (scope) => load(scope.projectId, scope.sessionId),
      mutateSession: (scope, mutate) => coordinator.mutateRuntimeSession(scope, mutate),
      finalizeArtifacts: async ({ claimId, messageId }) => {
        const claim = registry.resolve(claimId)
        const finalize = {
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
            await provenance.finalizeRun(finalize)
            await compatibility.finalizeRunArtifacts({
              projectId: claim.projectId,
              sourceSessionId: claim.artifactSessionId,
              sessionId: claim.sessionId,
              runId: claim.runId,
              artifactVersionIds: finalize.artifactVersionIds,
              provenanceContext: {
                rootFrameId: claim.rootFrameId!,
                agentFrameId: claim.agentFrameId!,
                messageBranchId: claim.messageBranchId!,
                runtimeSegmentId: claim.runtimeSegmentId!,
                promptMessageId: claim.promptMessageId!
              },
              messageId
            })
            const artifacts = await provenance.activateFinalizedRun(finalize)
            registry.markFinalized(claimId, messageId)
            return artifacts
          }
        )
      }
    })
    const runtime = new AcpRuntimeCoordinator(
      (callbacks) => {
        const runtimeOptions: AcpRuntimeOptions = {
          ...prepared.runtimeOptions,
          runtimeSessions,
          ...(science
            ? {
                permissionGrantStore: grants,
                artifacts: {
                  configRoot: options.configRoot,
                  dataRoot: options.dataRoot,
                  projectId: request.projectId,
                  mcpEntryPath: science.mcpEntryPath,
                  repository: compatibility,
                  runRegistry: registry,
                  provenance,
                  managedFileVersions: versions,
                  getRpcConnection: () => science.rpc.ensureStarted(),
                  issueRpcCapability: (binding) => science.rpc.issueArtifactRunCapability(binding),
                  revokeRpcCapability: (token) => science.rpc.revokeArtifactRunCapability(token)
                },
                notebook: (() => {
                  const binding = createAcpNotebookBinding({
                    rpc: science.rpc,
                    projectId: request.projectId,
                    mcpEntryPath: science.mcpEntryPath,
                    memoryTools: false,
                    isMemoryEnabled: async () => false,
                    canOwnRuntimeBindingDecision: (input) =>
                      science.service.canOwnRuntimeBindingDecision(input),
                    peekHandoffContext: (id) => science.service.peekHandoffContext(id)
                  })
                  return {
                    ...binding,
                    hasFrozenTurnInputs: true,
                    prepareTurnInputs: async (input) => {
                      await verifyFrozenInputs()
                      return science.rpc.prepareNotebookTurnInputs({
                        ...input,
                        uploads: [],
                        references: structuredClone(frozenReferences)
                      })
                    },
                    registerTurnInputs: async (input) => {
                      await verifyFrozenInputs()
                      return science.rpc.registerNotebookTurnInputs({
                        ...input,
                        uploads: [],
                        references: structuredClone(frozenReferences)
                      })
                    }
                  }
                })()
              }
            : {}),
          appVersion: 'earthnano-persistent-candidate',
          callbacks: {
            ...callbacks,
            onEvent: (event) => {
              runtimeSessions.accept(event)
              callbacks.onEvent?.(event)
            },
            onPromptStarted: (id, token, attempt) => {
              promptAttemptId = attempt
              callbacks.onPromptStarted?.(id, token, attempt)
            }
          }
        }
        if (options.runtimeFactory) return options.runtimeFactory(runtimeOptions)
        const base = composeAcpRuntimeBaseOwners(runtimeOptions)
        return new AcpRuntime(
          runtimeOptions,
          base,
          composeAcpRuntimeSessionOwners(runtimeOptions, base)
        )
      },
      {
        onPromptStarted: (_sessionId, token) => {
          runtimeExecutionId = token
          activeToken = token
        },
        onPromptEnded: (_sessionId, token) => {
          if (activeToken === token) activeToken = undefined
        },
        onEvent: () => undefined
      }
    )
    runtime.setExecutionBoundary(
      createAcpExecutionBoundary({
        host: createSessionExecutionHost({
          dataRoot: options.dataRoot,
          configRoot: options.configRoot,
          getClient: options.getClient,
          flush: (sessionId, promptId) => runtimeSessions.flush(sessionId, promptId)
        })
      })
    )
    runtimes.add(runtime)
    if (science)
      notebookSessions.set(runtime, () =>
        sessionId
          ? { projectId: request.projectId, sessionId, workspaceCwd: materialized.cwd }
          : undefined
      )
    const agent = createAcpTaskAgentPort(
      runtime,
      createAcpCreateSessionWorkflow(runtime),
      undefined,
      {
        withSessionAvailable: async (projectId, id, operation) => {
          await assertProject(projectId)
          await coordinator.assertSessionAvailable(projectId, id)
          return operation()
        }
      }
    )
    const owner: ClaudeCandidateOwner = {
      agent,
      preparePlan: async () => {
        context.signal.throwIfAborted()
        if (closing || shutdowns.has(runtime)) throw new Error('Candidate owner is shutting down')
        await assertProject(request.projectId)
        await verifyFrozenInputs()
        const created = await agent.createSession({
          cwd: materialized.cwd,
          projectId: request.projectId,
          memoryEnabled: false,
          permissionProfile: 'ask'
        })
        sessionId = created.sessionId
        const privateSessionId = sessionId
        if (!runtime.hasLiveSession(request.projectId, privateSessionId))
          throw new Error('Candidate runtime has no live Session')
        runtimeLivenessReleases.set(
          runtime,
          sessions.registerRuntimeSessionLiveness({
            projectId: request.projectId,
            sessionId: privateSessionId,
            isLive: () => runtime.hasLiveSession(request.projectId, privateSessionId)
          })
        )
        if (science && frozenRuntime) {
          notebookPolicyReleases.set(
            runtime,
            science.service.registerHostPermissionPolicy({
              projectId: request.projectId,
              sessionId,
              permissionPrompts: 'none'
            })
          )
          const scope = { projectId: request.projectId, sessionId, workspaceCwd: materialized.cwd }
          const { runtimes: available } = await science.service.listRuntimes(scope)
          const same = (
            value: import('../../shared/notebook-runtime').NotebookRuntimeBinding
          ): boolean =>
            (
              [
                'language',
                'runtimeId',
                'source',
                'provenance',
                'interpreterPath',
                'version'
              ] as const
            ).every((key) => value[key] === frozenRuntime[key])
          if (
            !available.some(
              (entry) => entry.runnable && (entry.status ?? 'active') === 'active' && same(entry)
            )
          )
            throw new Error('Frozen Notebook runtime unavailable or changed')
          const releasePermit = science.service.registerHostBindingPermit({
            projectId: request.projectId,
            sessionId,
            runtime: frozenRuntime
          })
          try {
            const result = await science.service.bindRuntime(
              { ...scope, language: 'python', runtimeId: frozenRuntime.runtimeId },
              context.signal
            )
            if (!('bound' in result) || !same(result.bound))
              throw new Error('Frozen Notebook binding did not commit')
          } finally {
            releasePermit()
          }
          for (const category of [
            'mcp:open-science-notebook/notebook_execute:python',
            'mcp:open-science-notebook/notebook_state',
            'mcp:open-science-notebook/list_notebook_runtimes',
            'mcp:open-science-artifacts/write_artifact_file'
          ])
            grants.remember(sessionId, category)
        }
        const now = Date.now()
        const text = scientific
          ? `${materialized.snapshots.task.prompt}\n\n${materialized.snapshots.invocation.mission}\n\nUse the bound Python Notebook and the fixed Notebook input versions listed below. Publish bounded textual reports with write_artifact_file and the real producerRunId. The host has pinned the runtime; do not bind or switch it, install packages, use Shell or start background work.`
          : `${materialized.snapshots.task.prompt}\n\n${materialized.snapshots.invocation.mission}\n\nINPUT: ${materialized.inputDir}\nOUTPUT: ${materialized.outputDir}\nTask files are in INPUT. Inputs and embedded context are read-only reference material. Write deliverables under OUTPUT. For proposer/composer harness output, write OUTPUT/context/harness/instructions.md and optional OUTPUT/context/harness/skills/<name>/SKILL.md. Do not use the Python working directory.`
        const idle = await coordinator.saveSession({
          id: sessionId,
          projectId: request.projectId,
          title: `Candidate ${context.executionId}`,
          cwd: materialized.cwd,
          status: 'idle',
          providerSessionId: created.providerSessionId,
          messages: [],
          conversationGraph: createLinearConversationGraph({
            sessionId,
            messages: [],
            frameworkId: 'claude-code',
            createdAt: now,
            updatedAt: now
          }),
          createdAt: now,
          updatedAt: now
        })
        const branchId = idle.conversationGraph!.frames.find(
          (frame) => frame.id === idle.conversationGraph!.activeFrameId
        )!.activeBranchId
        const staged = applySessionConversationCommands(idle, [
          {
            id: `append-${context.executionId}`,
            kind: 'append-user',
            timestamp: now,
            branchId,
            message: {
              id: promptMessageId,
              role: 'user',
              content: text,
              status: 'complete',
              createdAt: now,
              updatedAt: now,
              eventIds: []
            }
          },
          {
            id: `start-${context.executionId}`,
            kind: 'start-run',
            timestamp: now,
            run: { promptMessageId, startedAt: now }
          }
        ])
        const provenanceContext = getActiveConversationContext(
          staged.conversationGraph!,
          promptMessageId
        )
        if (!provenanceContext) throw new Error('Candidate turn graph is incomplete')
        return {
          kind: 'prepared',
          projectId: request.projectId,
          prompt: { sessionId, promptMessageId, text, provenanceContext },
          identity: { sessionId, providerSessionId: created.providerSessionId, promptMessageId },
          supportedInteractionPolicies: ['deny-unresolved'],
          admit: async () => {
            await coordinator.admitTaskTurn({ session: staged, contextReset: false })
            admitted = true
            return provenanceContext
          },
          cancelOwnedPrompt: async (dispatch) => {
            if (!admitted || !sessionId || !runtimeExecutionId) return
            const current = await load(request.projectId, sessionId)
            if (
              current.activeRun?.promptMessageId === promptMessageId &&
              activeToken === runtimeExecutionId
            )
              await dispatch()
          },
          readResult: async (settlement) => {
            if (!admitted || !runtimeExecutionId || !sessionId)
              throw new Error('No original runtime admission evidence')
            await runtimeSessions.flush(sessionId, promptMessageId)
            let artifactRunId: string | undefined
            let methodReply: string | undefined
            if (!scientific && !settlement.promptError && !settlement.cancellationRequested) {
              const outputs = await collectOutputs(materialized.outputDir)
              if (['proposer', 'composer', 'selector', 'reflection'].includes(request.role)) {
                // The original method consumes the committed reply, not a second model
                // transcription. Preserve that same review-safe projection via the original
                // artifact owner without overwriting any model-written output.
                const replyPath = `${request.role}-reply.md`
                if (
                  outputs.some((file) => {
                    const path = file.path.normalize('NFC').toLowerCase()
                    return path === replyPath || path.startsWith(replyPath + '/')
                  })
                )
                  throw new Error('Reserved method reply artifact collision')
                methodReply = turnReply(
                  await scopeSnapshot(request.projectId, sessionId, promptMessageId)
                )
                if (
                  (!methodReply.trim() && ['selector', 'reflection'].includes(request.role)) ||
                  Buffer.byteLength(methodReply) > 1024 * 1024
                )
                  throw new Error('Method reply is empty or exceeds the output profile')
                // A proposer/composer's accepted harness can be entirely file-based. Preserve
                // an actual reply when present; never manufacture narrative or a proposal.
                // When neither a narrative nor a harvested file exists, an exact zero-byte
                // reply is still evidence of what was committed. Original publication must
                // independently bind it to a real durable agent Message; no Message is invented.
                if (methodReply.trim() || !outputs.length) {
                  if (
                    outputs.length >= 64 ||
                    outputs.reduce((total, file) => total + Buffer.byteLength(file.content), 0) +
                      Buffer.byteLength(methodReply) >
                      4 * 1024 * 1024
                  )
                    throw new Error('Method reply exceeds the output profile')
                  outputs.push({ path: replyPath, content: methodReply })
                }
              }
              const handle = await artifactOwner.openExecution({
                executionId: runtimeExecutionId,
                workspaceCwd: materialized.cwd,
                appSessionId: sessionId,
                artifactStorageSessionId: sessionId,
                projectId: request.projectId,
                agentName: 'Claude candidate output importer',
                provenanceContext
              })
              try {
                for (const file of outputs)
                  await artifactOwner.write(handle, {
                    filename: encodeName(file.path),
                    content: file.content,
                    encoding: 'utf8'
                  })
                const publication = await artifactOwner.finalize(handle)
                if (publication) {
                  artifactRunId = publication.runId
                  await runtimeSessions.publish({ ...publication, executionId: runtimeExecutionId })
                }
              } finally {
                await artifactOwner.dispose(handle)
              }
            }
            const frozen = await scopeSnapshot(request.projectId, sessionId, promptMessageId)
            if (methodReply !== undefined && turnReply(frozen) !== methodReply)
              throw new Error('Method reply changed during artifact publication')
            if (frozen.session.activeRun?.promptMessageId === promptMessageId)
              throw new Error('Original Session terminal commit is incomplete')
            const artifacts = await turnArtifacts(frozen)
            const files = await readFiles(
              { request, evidence: { artifacts } } as Pick<ExecutionRecord, 'request' | 'evidence'>,
              scientific
            )
            const scientificReferences: Ref[] = []
            if (scientific && !settlement.promptError && !settlement.cancellationRequested) {
              if (!artifacts.length)
                throw new Error('Scientific candidate published no Notebook report')
              const runs = (
                await notebookRuns.readSessionRuns(request.projectId, sessionId)
              ).filter((run) => run.promptMessageId === promptMessageId)
              const tuple = (
                input: NotebookRunInputFile | FrozenNotebookInput
              ): FrozenNotebookInput => ({
                sourceKind: input.sourceKind,
                sourceProjectId: input.sourceProjectId,
                sourceSessionId: input.sourceSessionId,
                sourceFileId: input.sourceFileId,
                inputFileVersionId: input.inputFileVersionId,
                filename: input.filename,
                sizeBytes: input.sizeBytes,
                checksum: input.checksum
              })
              const validRuns = runs.filter(
                (run) =>
                  run.status === 'completed' &&
                  run.kernelKind === 'python' &&
                  run.executionInvocationId &&
                  (run.runtimeId ?? run.frozenRuntimeTarget?.runtimeId) ===
                    frozenRuntime!.runtimeId &&
                  run.frozenRuntimeTarget?.source === frozenRuntime!.source &&
                  run.frozenRuntimeTarget?.interpreterPath === frozenRuntime!.interpreterPath &&
                  canonical((run.inputFiles ?? []).map(tuple)) === canonical(frozenInputs)
              )
              if (!validRuns.length)
                throw new Error(
                  'Scientific candidate has no original completed fixed-input Python Run'
                )
              for (const artifact of artifacts) {
                const { execution } = await provenance.getVersionExecution({
                  projectId: request.projectId,
                  appSessionId: sessionId,
                  artifactId: artifact.artifactId,
                  versionId: artifact.versionId
                })
                if (!execution || !validRuns.some((run) => run.runId === execution.producerRunId))
                  throw new Error('Scientific ArtifactVersion has no original Notebook producer')
              }
              scientificReferences.push({
                id: `notebook-scientific:${sessionId}:${promptMessageId}`,
                version: promptMessageId,
                digest: digest(canonical(runs))
              })
            }
            const integrity = files.map((file) => {
              let jsonSyntax: 'valid' | 'invalid' | 'not-applicable' = 'not-applicable'
              if (/\.json$/i.test(file.path)) {
                try {
                  JSON.parse(file.content)
                  jsonSyntax = 'valid'
                } catch {
                  jsonSyntax = 'invalid'
                }
              }
              return {
                path: file.path,
                digest: file.digest,
                artifactRef: file.artifactRef,
                jsonSyntax
              }
            })
            // Review has a five-Finding domain limit. Aggregate the complete output inventory
            // into one Finding; retain every exact version/digest and syntax result in its log.
            const manifest = { schemaVersion: 1, files: integrity }
            const summary = {
              fileCount: integrity.length,
              invalidJsonCount: integrity.filter((file) => file.jsonSyntax === 'invalid').length,
              manifestDigest: digest(canonical(manifest))
            }
            const checks: NewCheck[] = [
              {
                status: !integrity.length ? 'warn' : summary.invalidJsonCount ? 'fail' : 'pass',
                claim:
                  'Deterministic file integrity / UTF-8 / JSON syntax only; no semantic assessment',
                evidence: JSON.stringify(summary),
                ...(files[0] ? { artifactVersionId: files[0].artifactRef.versionId } : {}),
                sortIndex: 0
              }
            ]
            let reviewId: string | undefined
            let committed: ReviewWithChecks
            try {
              // Already-cancelled prompt settlement retains its existing cancellation projection.
              // A new Stop during result persistence must never leave a late passing Review.
              if (!settlement.cancellationRequested) settlement.signal.throwIfAborted()
              const review = await reviews.createReview({
                projectId: request.projectId,
                sessionId,
                turnMessageId: promptMessageId,
                scope: frozen.scope,
                scopeSnapshot: frozen.blocks,
                model: 'deterministic-file-integrity-v1',
                lifecycle: 'running'
              })
              reviewId = review.id
              if (!settlement.cancellationRequested) settlement.signal.throwIfAborted()
              committed = await reviews.commitScopedSubmission({
                mode: 'initial',
                reviewId,
                checks,
                expectedSourceFindingIds: [],
                keepFlaggedReviewRunning: false,
                reviewerLog: [
                  {
                    kind: 'tool',
                    toolName: 'earthnano.file-integrity-manifest',
                    title: 'Fixed-version candidate output integrity inventory',
                    rawInput: canonical(manifest),
                    rawOutput: JSON.stringify(summary),
                    status: summary.invalidJsonCount ? 'error' : 'ok'
                  }
                ]
              })
              if (!settlement.cancellationRequested) settlement.signal.throwIfAborted()
            } catch (error) {
              if (reviewId)
                await reviews.updateReview(reviewId, {
                  lifecycle: 'error',
                  outcome: null,
                  errorMessage: 'Candidate integrity review could not be completed.'
                })
              throw error
            }
            const reviewRef: Ref = {
              id: `review:${committed.id}`,
              version: String(committed.updatedAt),
              digest: digest(canonical(committed))
            }
            const replyText = turnReply(frozen)
            return {
              phase: settlement.cancellationRequested
                ? 'cancelled'
                : settlement.promptError
                  ? 'failed'
                  : 'completed',
              identity: {
                sessionId,
                promptMessageId,
                runtimeExecutionId,
                turnToken: runtimeExecutionId,
                promptAttemptId,
                ...(artifactRunId ? { runId: artifactRunId } : {})
              },
              evidence: {
                status: 'complete',
                scope:
                  'Original durable Session review-safe turn projection and fixed ArtifactVersion bytes; deterministic file-integrity Review only',
                text: replyText,
                artifacts,
                references: [frozen.reference, reviewRef, ...scientificReferences],
                limitations: [
                  'No semantic Reviewer claim; scope snapshot applies original redaction and clipping.',
                  'Configuration loading remains unknown without independent runtime observation.'
                ]
              },
              configuration: prepared.configuration
            }
          }
        }
      },
      shutdown: () => stop(runtime)
    }
    return owner
  }
  return {
    openOwner,
    readSemanticSourceEvidence,
    async exportResult(record: ExecutionRecord): Promise<PersistentCandidateResult> {
      const frozen = await pinnedTurn(record)
      const scientificRef = record.evidence.references.find((ref) =>
        ref.id.startsWith('notebook-scientific:')
      )
      if (scientificRef) {
        const runs = (
          await notebookRuns.readSessionRuns(record.request.projectId, record.identity.sessionId!)
        ).filter((run) => run.promptMessageId === record.identity.promptMessageId)
        if (digest(canonical(runs)) !== scientificRef.digest)
          throw new Error('Original scientific Notebook Runs changed')
      }
      const replyText = turnReply(frozen)
      if (replyText !== record.evidence.text)
        throw new Error('Execution reply differs from original committed turn')
      return {
        executionId: record.executionId,
        artifacts: structuredClone(record.evidence.artifacts),
        replyText,
        trajectoryText: JSON.stringify(frozen.blocks),
        files: await readFiles(record)
      }
    },
    async readReviews(record: ExecutionRecord): Promise<ReviewWithChecks[]> {
      await pinnedTurn(record)
      const rows = await reviews.getReviewsForProjectSession(
        record.request.projectId,
        record.identity.sessionId!
      )
      return record.evidence.references
        .filter((ref) => ref.id.startsWith('review:'))
        .map((ref) => {
          const row = rows.find((review) => `review:${review.id}` === ref.id)
          if (
            !row ||
            String(row.updatedAt) !== ref.version ||
            digest(canonical(row)) !== ref.digest
          )
            throw new Error('Pinned Review is unavailable or changed')
          return row
        })
    },
    async commitDeterministicReview(input) {
      const { signal } = input
      const target = structuredClone(input.target)
      const frozenChecks = normalizeOutputChecks(input.checks)!
      signal?.throwIfAborted()
      validateRecord(target)
      if (
        target.phase !== 'completed' ||
        target.cleanup !== 'confirmed' ||
        target.requestDigest !== requestDigest(target.request) ||
        !['baseline', 'candidate'].includes(target.request.role)
      )
        throw new Error('Output checks require a completed pinned execution')
      const frozen = await pinnedTurn(target)
      const results = checkOutputFiles(await readFiles(target), frozenChecks)
      if (!results.length) throw new Error('Output checks require frozen expectations')
      const anchor = [...frozen.blocks]
        .reverse()
        .find((block) => block.kind === 'message' && block.payload.role === 'agent')
      if (!anchor) throw new Error('Output check target has no turn evidence anchor')
      const metadata = {
        schemaVersion: 1,
        kind: 'earthnano-output-checks',
        targetExecutionId: target.executionId,
        targetArtifacts: target.evidence.artifacts,
        expectationsDigest: outputDigest(frozenChecks),
        checks: frozenChecks,
        results
      }
      const expectedOutcome = results.every((result) => result.status === 'pass')
        ? 'pass'
        : 'flagged'
      const existing = await reviews.getReviewsForProjectSession(
        target.request.projectId,
        target.identity.sessionId!
      )
      for (const review of existing) {
        if (
          review.lifecycle !== 'complete' ||
          review.outcome !== expectedOutcome ||
          review.turnMessageId !== target.identity.promptMessageId ||
          canonical(review.scope) !== canonical(frozen.scope)
        )
          continue
        if (
          review.reviewerLog.some((entry) => {
            if (entry.kind !== 'tool' || entry.toolName !== 'earthnano.output-checks') return false
            try {
              return canonical(JSON.parse(entry.rawInput ?? '')) === canonical(metadata)
            } catch {
              return false
            }
          })
        )
          return { reviewId: review.id, outcome: expectedOutcome }
      }
      let reviewId: string | undefined
      try {
        signal?.throwIfAborted()
        const review = await reviews.createReview({
          projectId: target.request.projectId,
          sessionId: target.identity.sessionId!,
          turnMessageId: target.identity.promptMessageId!,
          scope: frozen.scope,
          scopeSnapshot: frozen.blocks,
          model: 'deterministic-json-value-v1',
          lifecycle: 'running'
        })
        reviewId = review.id
        signal?.throwIfAborted()
        const evidence = results.find((result) => result.artifactRef)?.artifactRef
        const committed = await reviews.commitScopedSubmission({
          mode: 'initial',
          reviewId,
          expectedSourceFindingIds: [],
          keepFlaggedReviewRunning: false,
          checks: [
            {
              status: results.every((result) => result.status === 'pass') ? 'pass' : 'fail',
              claim:
                'Deterministic JSON value checks against frozen expectations and exact artifact versions.',
              evidence: JSON.stringify({
                expectationsDigest: metadata.expectationsDigest,
                results
              }),
              ...(evidence ? { artifactVersionId: evidence.versionId } : {}),
              locator: {
                blockRef: { messageId: anchor.sourceId, blockIndex: anchor.blockIndex },
                contentHash: anchor.contentHash
              },
              sortIndex: 0
            }
          ],
          reviewerLog: [
            {
              kind: 'tool',
              toolName: 'earthnano.output-checks',
              title: 'Frozen deterministic output checks',
              rawInput: JSON.stringify(metadata),
              rawOutput: JSON.stringify(results),
              status: 'ok'
            }
          ]
        })
        signal?.throwIfAborted()
        const outcome = results.every((result) => result.status === 'pass') ? 'pass' : 'flagged'
        if (committed.lifecycle !== 'complete' || committed.outcome !== outcome)
          throw new Error('Output check Review did not persist its outcome')
        return { reviewId: committed.id, outcome }
      } catch (error) {
        if (reviewId)
          await reviews
            .updateReview(reviewId, {
              lifecycle: 'error',
              outcome: null,
              errorMessage: 'Output checks could not be completed.'
            })
            .catch(() => undefined)
        throw error
      }
    },
    async commitSemanticReview(input): Promise<{ reviewId: string; outcome: 'pass' | 'flagged' }> {
      const { target, assessment, criteria, criteriaDigest, document, sourceEvidence } =
        structuredClone({
          target: input.target,
          assessment: input.assessment,
          criteria: input.criteria,
          criteriaDigest: input.criteriaDigest,
          document: input.document,
          sourceEvidence: input.sourceEvidence
        })
      const { signal, snapshots } = input
      signal?.throwIfAborted()
      for (const record of [target, assessment]) {
        validateRecord(record)
        if (
          record.phase !== 'completed' ||
          record.cleanup !== 'confirmed' ||
          record.requestDigest !== requestDigest(record.request)
        )
          throw new Error('Semantic Review requires completed pinned executions')
      }
      if (
        !['baseline', 'candidate'].includes(target.request.role) ||
        assessment.request.role !== 'reviewer' ||
        target.executionId === assessment.executionId ||
        target.request.projectId !== assessment.request.projectId ||
        target.request.origin.optimizationId !== assessment.request.origin.optimizationId ||
        target.request.budgetRef !== assessment.request.budgetRef ||
        !assessment.configuration.model ||
        semanticDigest(criteria) !== criteriaDigest
      )
        throw new Error('Semantic Review provenance does not match the optimization')
      const frozen = await pinnedTurn(target)
      const assessor = await pinnedTurn(assessment)
      if (
        !assessor.blocks.some(
          (block) =>
            block.kind === 'message' &&
            block.payload.role === 'user' &&
            String(block.payload.content).includes(criteriaDigest)
        )
      )
        throw new Error('Criteria digest is not frozen in the assessment turn')
      const scientific = target.evidence.references.some((ref) =>
        ref.id.startsWith('notebook-scientific:')
      )
      if (scientific && (!sourceEvidence || !snapshots))
        throw new Error('Scientific semantic Review requires frozen source evidence')
      if (sourceEvidence) {
        if (!snapshots) throw new Error('Source evidence TaskSnapshot authority unavailable')
        const verified = await readSemanticSourceEvidence({
          target,
          snapshots: snapshots,
          signal
        })
        if (
          canonical(verified) !== canonical(sourceEvidence) ||
          !assessor.blocks.some(
            (block) =>
              block.kind === 'message' &&
              block.payload.role === 'user' &&
              String(block.payload.content).includes(verified.digest)
          )
        )
          throw new Error('Semantic source evidence differs from the frozen assessment turn')
      }
      const files = await readFiles(target)
      const assessmentFiles = await readFiles(assessment)
      if (assessmentFiles.length !== 1 || assessmentFiles[0]!.path !== 'assessment.json')
        throw new Error('Semantic assessor must publish only the fixed assessment document')
      const checked = parseSemanticAssessment(assessmentFiles[0]!.content, files, criteria)
      if (semanticCanonical(checked) !== semanticCanonical(document))
        throw new Error('Semantic document differs from its committed ArtifactVersion')
      const criteriaItems = semanticCriteria(criteria)
      const firstEvidence = checked.checks[0]!.evidence[0]!
      const anchor =
        frozen.blocks.find(
          (block) =>
            block.kind === 'message' &&
            Array.isArray(block.payload.artifactIds) &&
            block.payload.artifactIds.includes(firstEvidence.artifactRef.versionId)
        ) ??
        [...frozen.blocks]
          .reverse()
          .find((block) => block.kind === 'message' && block.payload.role === 'agent')
      if (!anchor) throw new Error('Semantic Review target has no turn evidence anchor')
      const metadata = {
        kind: 'earthnano-semantic-assessment-provenance',
        schemaVersion: 1,
        criteriaText: criteria,
        criteriaDigest,
        criteria: criteriaItems,
        ...(sourceEvidence ? { sourceEvidence: sourceEvidence } : {}),
        targetExecutionId: target.executionId,
        targetArtifacts: target.evidence.artifacts,
        assessmentExecutionId: assessment.executionId,
        assessmentArtifacts: assessment.evidence.artifacts,
        assessmentTaskSnapshotRef: assessment.request.taskSnapshotRef,
        assessmentInvocationRef: assessment.request.invocationRef,
        model: assessment.configuration.model,
        assessmentDocumentDigest: semanticDigest(assessmentFiles[0]!.content),
        document: checked,
        limitation:
          'Model semantic judgment grounded in supplied quotes; not deterministic factual proof.'
      }
      const existing = await reviews.getReviewsForProjectSession(
        target.request.projectId,
        target.identity.sessionId!
      )
      for (const review of existing) {
        if (
          review.lifecycle !== 'complete' ||
          review.outcome !== checked.outcome ||
          review.turnMessageId !== target.identity.promptMessageId ||
          canonical(review.scope) !== canonical(frozen.scope)
        )
          continue
        if (
          review.reviewerLog?.some((entry) => {
            if (entry.kind !== 'tool' || entry.toolName !== 'earthnano.semantic-assessment-binding')
              return false
            try {
              return canonical(JSON.parse(entry.rawInput ?? '')) === canonical(metadata)
            } catch {
              return false
            }
          })
        )
          return { reviewId: review.id, outcome: checked.outcome }
      }
      // Keep the domain's five-Finding limit: one aggregate Finding links the complete frozen
      // assessment artifact. All per-criterion paths/quotes/refs remain in that version and log.
      const finding: NewCheck = {
        status: checked.checks.some((check) => check.status === 'fail')
          ? 'fail'
          : checked.checks.some((check) => check.status === 'warn')
            ? 'warn'
            : 'pass',
        claim:
          'Independent semantic assessment of every frozen criterion; model judgment, not factual proof.',
        evidence: JSON.stringify({
          criteriaDigest,
          score: checked.score,
          rationale: checked.rationale,
          assessmentExecutionId: assessment.executionId,
          assessmentArtifacts: assessment.evidence.artifacts,
          checks: checked.checks.map((check) => ({
            criterionId: check.criterionId,
            status: check.status
          }))
        }),
        artifactVersionId: firstEvidence.artifactRef.versionId,
        locator: {
          blockRef: { messageId: anchor.sourceId, blockIndex: anchor.blockIndex },
          contentHash: anchor.contentHash
        },
        sortIndex: 0
      }
      let reviewId: string | undefined
      try {
        signal?.throwIfAborted()
        const review = await reviews.createReview({
          projectId: target.request.projectId,
          sessionId: target.identity.sessionId!,
          turnMessageId: target.identity.promptMessageId!,
          scope: frozen.scope,
          scopeSnapshot: frozen.blocks,
          model: assessment.configuration.model,
          lifecycle: 'running'
        })
        reviewId = review.id
        signal?.throwIfAborted()
        const committed = await reviews.commitScopedSubmission({
          mode: 'initial',
          reviewId,
          checks: [finding],
          expectedSourceFindingIds: [],
          keepFlaggedReviewRunning: false,
          reviewerLog: [
            ...assessor.blocks
              .filter((block) => block.kind === 'message' && block.payload.role === 'agent')
              .map((block) => ({
                kind: 'message' as const,
                text: String(block.payload.content ?? '')
              })),
            {
              kind: 'tool',
              toolName: 'earthnano.semantic-assessment-binding',
              title: 'Host-validated fixed-version semantic assessment provenance',
              rawInput: JSON.stringify(metadata),
              rawOutput: JSON.stringify({ outcome: checked.outcome }),
              status: 'ok'
            }
          ]
        })
        signal?.throwIfAborted()
        if (committed.lifecycle !== 'complete' || committed.outcome !== checked.outcome)
          throw new Error('Semantic Review submission did not persist its outcome')
        return { reviewId: committed.id, outcome: checked.outcome }
      } catch (error) {
        if (reviewId)
          await reviews
            .updateReview(reviewId, {
              lifecycle: 'error',
              outcome: null,
              errorMessage: 'Semantic assessment could not be completed.'
            })
            .catch(() => undefined)
        throw error
      }
    },
    async shutdown(): Promise<{ reaped: boolean }> {
      closing = true
      const results = await Promise.all([...runtimes].map(stop))
      return { reaped: results.every((result) => result.reaped) }
    }
  }
}
