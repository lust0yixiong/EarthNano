import { readSemanticSourceVersions } from './semantic-source-evidence'
import { readOriginalExecutionUsage } from './execution-turn-usage'
import { createAcpNotebookBinding } from '../acp/notebook-binding'
import { ConversationPermissionGrantStore } from '../acp/permission-broker'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import type { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { getNotebookDataRoot, NotebookRunRepository } from '../notebook/repository'
import { isComputeJobResultFinal, hasCleanupStopEvidence } from '@aipoch/compute/node'
import type { ApplicationEventSource } from '../application-events'
import type { ComputeHostRepository } from '../compute/repository'
import type { ComputeJobRepository } from '../compute/job-repository'
import type { ComputeJobOperationRepository } from '../compute/compute-job-operation-repository'
import type { ComputeService } from '../compute/compute-service'
import type { SessionEnabledComputeHostsOwner } from '../compute/session-enabled-hosts-owner'
import type { createComputeIpcModule } from '../compute/ipc'
import type { BackgroundResultDeliveryRepository } from '../background-result-delivery/repository'
import { BackgroundResultDeliveryUnavailableError } from '../background-result-delivery/owner'
import {
  buildAgentResultContinuationPrompt,
  hasSavedAgentResultContinuation
} from '../background-result-delivery/continuation'
import {
  isComputeToolsProfile,
  normalizeFrozenComputeContext
} from '../../shared/earthnano/compute-profile'
import { normalizeFrozenManagedInputs } from '../../shared/earthnano/notebook-profile'
import { assertFrozenComputeContext } from './compute-context'
import type { CandidateContinuationTarget, TrustedControlPolicy } from './compute-candidate-ports'
import type { AcpExecutionDispatch } from '../acp/execution-boundary-port'
import type { ComputeJob } from '../../shared/compute'
import type { NotebookRunRecord } from '../../shared/notebook'
import {
  isAgentResultDeliveryAttribution,
  resolveTurnOutcome
} from '../../shared/session-persistence'
import type { FileReference } from '../../shared/artifacts'
import type { NotebookRunInputFile } from '../../shared/notebook'
import {
  notebookLanguageForTools,
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
  originalTurnReply as turnReply,
  type OriginalTurnEvidence
} from './original-turn-evidence'
import { createHash } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  type FileHandle
} from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
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
import type { ManagedFileReadLease } from '../managed-file-versions/read-port'
import { LOCAL_RESOURCE_BUDGETS, assertWithinResourceBudget } from '../resource-budget'
import { assertDiskReserve, copyOpenFileWithinBudget } from '../bounded-file-io'
import { availableBytes } from '../storage/usage'
import type {
  CandidateArtifactFile,
  CandidateBinaryArtifactFile
} from '../../shared/earthnano/candidate-artifact'
import { normalizeCandidateArtifactFile } from '../../shared/earthnano/candidate-artifact'
import { resolveDataRoot } from '../storage-root'
import { ProjectRepository } from '../projects/repository'
import { ReviewRepository } from '../reviewer/repository'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import type { SettingsRepository } from '../settings/repository'
import { loadSessionMutationAuthority, SessionRepository } from '../session-persistence/repository'
import { RuntimeSessionOwner } from '../session-persistence/runtime-session-owner'
import type { ClaudeCandidateDriverOptions, ClaudeCandidateOwner } from './claude-candidate-driver'
import type { AcpPromptSettlement } from '../acp/earthnano-execution-driver'
import {
  parseSemanticAssessment,
  semanticCriteria,
  semanticDigest,
  semanticCanonical
} from './semantic-evaluation'
import { validateRecord, requestDigest } from './execution-contract'
import { normalizeOutputChecks } from '../../shared/earthnano/research-outcome'
import { checkOutputFiles, outputDigest } from './output-checks'

export interface PersistentCandidateNotebookOptions {
  service: NotebookRuntimeService
  rpc: NotebookLocalRpcServer
  mcpEntryPath: string
}
export interface PersistentCandidateComputeOptions {
  hosts: Pick<ComputeHostRepository, 'get'>
  hostAccess: Pick<SessionEnabledComputeHostsOwner, 'withReservation' | 'createSession'>
  jobs: Pick<ComputeJobRepository, 'findByOwner'>
  operations: Pick<ComputeJobOperationRepository, 'get'>
  service: Pick<ComputeService, 'cancelJob'>
  deliveries: Pick<BackgroundResultDeliveryRepository, 'findBySource' | 'listContinuation'>
  events: ApplicationEventSource
  cancelApprovals: ReturnType<typeof createComputeIpcModule>['handlers']['approvalCancelSession']
}
export interface PersistentCandidateOwnersOptions {
  dataRoot: string
  notebook?: PersistentCandidateNotebookOptions
  compute?: PersistentCandidateComputeOptions
  /** Host-owned, isolated temporary projections; never an authoritative artifact store. */
  artifactProjectionRoot?: string
  /** Share the application's original Session persistence and serialization authority. */
  sessionPersistence: {
    repository: SessionRepository
    coordinator: Pick<
      SessionPersistenceCommands,
      'mutateRuntimeSession' | 'assertSessionAvailable' | 'saveSession' | 'admitTaskTurn'
    >
  }
  /** Read the original Settings owner without creating another document repository. */
  settings: Pick<SettingsRepository, 'getSettings'>
  /** Database initialization/migration remains the host's responsibility. */
  configRoot: string
  getClient(): Promise<PrismaClient>
  /** Optional instrumentation of the existing runtime, never an alternative result authority. */
  runtimeFactory?(options: AcpRuntimeOptions): AcpRuntime
}
export type {
  PersistentCandidateFile,
  PersistentCandidateResult,
  PersistentCandidateOwners
} from './candidate-owner-contract'
import type {
  PersistentCandidateResult,
  PersistentCandidateOwners
} from './candidate-owner-contract'
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
/** Uses the same portable relative path constraints as candidate snapshot inputs. Old text
 * paths keep their existing projection; newly exposed binary paths must satisfy these rules. */
const binaryPath = (path: string): string => {
  if (
    !path.trim() ||
    isAbsolute(path) ||
    /[\\:*?"<>|]/.test(path) ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  )
    throw new Error('Candidate binary path is not a portable relative path')
  return path
}
const projectionDirectory = async (
  path: string,
  create = false
): Promise<{ path: string; assert(): Promise<void> }> => {
  if (!isAbsolute(path)) throw new Error('Artifact projection root must be absolute')
  const absolute = resolve(path)
  const parents: string[] = []
  let parent = absolute
  for (;;) {
    parents.unshift(parent)
    const next = dirname(parent)
    if (next === parent) break
    parent = next
  }
  // Check each existing ancestor before creating its child; recursive mkdir could otherwise
  // follow a linked ancestor before the post-creation identity check.
  for (const current of parents) {
    // A filesystem root already exists; Windows can reject mkdir(root) with EPERM rather than
    // EEXIST. It still receives the same lstat directory/symlink check before any child is created.
    if (create && current !== dirname(current)) {
      try {
        await mkdir(current, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const observed = await lstat(current)
    if (!observed.isDirectory() || observed.isSymbolicLink())
      throw new Error('Artifact projection contains a linked directory')
  }
  const observed = await lstat(absolute)
  if (process.platform !== 'win32' && (observed.mode & 0o077) !== 0)
    throw new Error('Artifact projection directory must be private')
  const resolved = await realpath(absolute)
  const assert = async (): Promise<void> => {
    const current = await lstat(absolute)
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== observed.dev ||
      current.ino !== observed.ino ||
      (await realpath(absolute)) !== resolved
    )
      throw new Error('Artifact projection directory identity changed')
  }
  return { path: resolved, assert }
}
const verifyProjectedArtifact = async (
  assetPath: string,
  file: CandidateBinaryArtifactFile,
  assertDirectory: () => Promise<void>,
  signal?: AbortSignal
): Promise<void> => {
  signal?.throwIfAborted()
  await assertDirectory()
  const before = await lstat(assetPath)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new Error('Artifact projection is not an ordinary file')
  const handle = await open(assetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size !== file.sizeBytes
    )
      throw new Error('Artifact projection identity or size changed')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (position < stat.size) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - position),
        position
      )
      if (bytesRead <= 0) throw new Error('Artifact projection read was incomplete')
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat()
    if (
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs ||
      'sha256:' + hash.digest('hex') !== file.digest
    )
      throw new Error('Artifact projection bytes changed')
    const current = await lstat(assetPath)
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino
    )
      throw new Error('Artifact projection path changed')
    await assertDirectory()
    signal?.throwIfAborted()
  } finally {
    await handle.close()
  }
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
  const sessions = options.sessionPersistence.repository
  const coordinator = options.sessionPersistence.coordinator
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
  const knownPrivateSessions = new Map<string, AcpRuntimeCoordinator>()
  const computeResources = new Map<
    AcpRuntimeCoordinator,
    {
      cancel(): Promise<void>
      settled(): Promise<boolean>
      release(): void
    }
  >()
  const privateCompute = new Map<
    string,
    {
      target: CandidateContinuationTarget
      available(): boolean
      policy(
        binding: Parameters<NonNullable<PersistentCandidateOwners['resolveControlPolicy']>>[0]
      ): Promise<TrustedControlPolicy>
    }
  >()
  const shutdowns = new Map<AcpRuntimeCoordinator, Promise<{ reaped: boolean }>>()
  let closing = false
  const stop = (runtime: AcpRuntimeCoordinator): Promise<{ reaped: boolean }> => {
    let pending = shutdowns.get(runtime)
    if (!pending) {
      const notebookScope = notebookSessions.get(runtime)?.()
      const computeResource = computeResources.get(runtime)
      pending = Promise.allSettled([
        ...(computeResource ? [computeResource.cancel()] : []),
        runtime.shutdownForQuit(),
        ...(notebookScope && options.notebook
          ? [options.notebook.service.shutdown(notebookScope)]
          : [])
      ]).then(async (results) => {
        const reaped =
          results.every((result) => result.status === 'fulfilled') &&
          results[computeResource ? 1 : 0].status === 'fulfilled' &&
          (results[computeResource ? 1 : 0] as PromiseFulfilledResult<{ reaped: boolean }>).value
            .reaped &&
          (!computeResource || (await computeResource.settled()))
        if (reaped) {
          runtimeLivenessReleases.get(runtime)?.()
          runtimeLivenessReleases.delete(runtime)
          notebookPolicyReleases.get(runtime)?.()
          notebookPolicyReleases.delete(runtime)
          computeResource?.release()
        }
        if (!reaped && computeResource) shutdowns.delete(runtime)
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
  // Reconstruct original ownership, including earlier producers used by later application Turns.
  // The only mutable state here is the original Session/Run/Job/delivery data owned elsewhere.
  const computeFacts = async (
    projectId: string,
    sessionId: string,
    initialPrompt: string
  ): Promise<{
    session: PersistedChatSession
    turnIds: string[]
    runs: NotebookRunRecord[]
    jobs: ComputeJob[]
    foreignJobs: ComputeJob[]
  }> => {
    if (!options.compute) throw new Error('Original Compute owners unavailable')
    const session = await load(projectId, sessionId)
    const admissions = session.runtimeSessionAdmissions ?? []
    const initial = admissions.find((value) => value.promptMessageId === initialPrompt)
    if (!initial || !session.conversationGraph)
      throw new Error('Compute execution has no original initial admission')
    const runs = await notebookRuns.readSessionRuns(projectId, sessionId)
    const allJobs = await options.compute.jobs.findByOwner({ projectId, sessionId })
    const turnIds = [initialPrompt]
    const ownsRun = (run: NotebookRunRecord): boolean => {
      const admission = admissions.find((value) => value.promptMessageId === run.promptMessageId)
      return Boolean(
        admission &&
        turnIds.includes(admission.promptMessageId) &&
        run.kernelKind === 'repl' &&
        run.executionInvocationId &&
        run.rootFrameId === initial.rootFrameId &&
        run.agentFrameId === initial.agentFrameId &&
        run.rootFrameId === admission.rootFrameId &&
        run.agentFrameId === admission.agentFrameId &&
        run.messageBranchId === admission.messageBranchId &&
        run.runtimeSegmentId === admission.runtimeSegmentId
      )
    }
    const ownsJob = (job: ComputeJob): boolean =>
      job.project_id === projectId &&
      job.session_id === sessionId &&
      Boolean(
        job.producer_run_id && runs.some((run) => run.runId === job.producer_run_id && ownsRun(run))
      )
    for (const admission of admissions) {
      if (admission.promptMessageId === initialPrompt) continue
      const message = session.conversationGraph.messages.find(
        (value) => value.id === admission.promptMessageId
      )
      if (
        !message ||
        message.role !== 'user' ||
        !isAgentResultDeliveryAttribution(message.attribution) ||
        message.attribution.deliveryKey !== `agent-result-delivery:${message.id}` ||
        admission.rootFrameId !== initial.rootFrameId ||
        admission.agentFrameId !== initial.agentFrameId
      )
        throw new Error('Compute Session contains an unowned application Turn')
      const rows = await options.compute.deliveries.listContinuation(sessionId, message.id)
      const attribution = message.attribution
      if (
        rows.length !== message.attribution.deliveryIds.length ||
        !rows.length ||
        rows.some(
          (row) =>
            row.projectId !== projectId ||
            row.sessionId !== sessionId ||
            row.sourceKind !== 'compute-job' ||
            !attribution.deliveryIds.includes(row.id) ||
            !allJobs.some((job) => job.job_id === row.sourceId && ownsJob(job))
        )
      )
        throw new Error('Compute application Turn has no exact original Job delivery')
      turnIds.push(message.id)
    }
    return {
      session,
      turnIds,
      runs: runs.filter(ownsRun),
      jobs: allJobs.filter(ownsJob),
      foreignJobs: allJobs.filter((job) => !ownsJob(job))
    }
  }
  const computeJobStopped = async (job: ComputeJob): Promise<boolean> => {
    if (!options.compute || job.needs_attention || job.integrity_issues?.length) return false
    const operation = await options.compute.operations.get(job.job_id, 'cancel')
    if (operation?.phase === 'active' || job.cancellation_status === 'cancelling') return false
    // The original reaper owns fulfilled cancellation; a superseded request alone proves nothing.
    if (
      operation?.phase === 'settled' &&
      operation.outcome === 'fulfilled' &&
      job.cancellation_status === 'cancelled'
    )
      return true
    if (hasCleanupStopEvidence(job)) return true
    return ['success', 'failed', 'timeout'].includes(job.status) && isComputeJobResultFinal(job)
  }
  const computeEvidence = async (
    projectId: string,
    sessionId: string,
    initialPrompt: string
  ): Promise<{
    turns: OriginalTurnEvidence[]
    artifacts: ArtifactReference[]
    reference: Ref
  }> => {
    const facts = await computeFacts(projectId, sessionId, initialPrompt)
    if (facts.foreignJobs.length) throw new Error('Compute Session contains foreign producer Jobs')
    if (
      !facts.runs.some((run) => run.status === 'completed') ||
      facts.jobs.some(
        (job) =>
          !facts.runs.some((run) => run.runId === job.producer_run_id && run.status === 'completed')
      )
    )
      throw new Error('Compute control Run has no completed original result')
    if (facts.jobs.some((job) => !isComputeJobResultFinal(job)))
      throw new Error('Compute Job result is not final')
    const turns: OriginalTurnEvidence[] = []
    const artifacts: ArtifactReference[] = []
    for (const prompt of facts.turnIds) {
      if (
        facts.session.activeRun?.promptMessageId === prompt ||
        facts.session.promptPreparation?.promptMessageId === prompt ||
        !resolveTurnOutcome(facts.session, prompt)
      )
        throw new Error('Compute original Turn terminal commit is incomplete')
      const turn = await scopeSnapshot(projectId, sessionId, prompt)
      turns.push(turn)
      for (const artifact of await turnArtifacts(turn)) {
        if (artifacts.some((value) => value.versionId === artifact.versionId))
          throw new Error('Compute artifact is attributed to multiple Turns')
        const { execution } = await provenance.getVersionExecution({
          projectId,
          appSessionId: sessionId,
          artifactId: artifact.artifactId,
          versionId: artifact.versionId
        })
        if (
          !execution ||
          execution.terminalPromptMessageId !== prompt ||
          !facts.runs.some(
            (run) => run.runId === execution.producerRunId && run.status === 'completed'
          )
        )
          throw new Error('Compute Version has no admitted original control producer')
        artifacts.push(artifact)
      }
    }
    const jobs = await Promise.all(
      facts.jobs.map(async (job) => {
        const delivery = await options.compute!.deliveries.findBySource({
          sourceKind: 'compute-job',
          sourceId: job.job_id,
          projectId,
          sessionId
        })
        if (!delivery || delivery.state !== 'consumed')
          throw new Error('Compute original result delivery is unsettled')
        return {
          jobId: job.job_id,
          providerId: job.provider_id,
          producerRunId: job.producer_run_id,
          shape: job.shape,
          executionMode: job.execution_mode,
          status: job.status,
          commandHash: job.command_hash,
          stdoutTail: job.stdout_tail,
          stderrTail: job.stderr_tail,
          harvestError: job.harvest_error,
          leftOnRemote: job.left_on_remote,
          exitCode: job.exit_code,
          harvestedAt: job.harvested_at,
          fileEvidence: job.file_evidence,
          deliveryId: delivery.id,
          continuationMessageId: delivery.continuationMessageId
        }
      })
    )
    return {
      turns,
      artifacts,
      reference: {
        id: `compute-candidate:${sessionId}:${initialPrompt}`,
        version: initialPrompt,
        digest: digest(canonical({ turns: turns.map((turn) => turn.reference), jobs, artifacts }))
      }
    }
  }
  const readFiles = async (
    record: Pick<ExecutionRecord, 'request' | 'evidence' | 'identity'>,
    scientific = record.evidence.references?.some(
      (ref) => ref.id.startsWith('notebook-scientific:') || ref.id.startsWith('compute-candidate:')
    ) ?? false,
    signal?: AbortSignal
  ): Promise<CandidateArtifactFile[]> => {
    signal?.throwIfAborted()
    const files: CandidateArtifactFile[] = []
    if (record.evidence.artifacts.length > 64)
      throw new Error('Candidate artifact inventory exceeds export profile')
    let total = 0
    let textTotal = 0
    for (const artifactRef of record.evidence.artifacts) {
      signal?.throwIfAborted()
      const lease = await versions.openVersion(
        { source: 'artifact', projectId: record.request.projectId, fileId: artifactRef.artifactId },
        artifactRef.versionId
      )
      try {
        if (
          lease.version.checksum !== artifactRef.checksum ||
          lease.version.id !== artifactRef.versionId ||
          lease.version.fileId !== artifactRef.artifactId ||
          lease.logicalFile.source !== 'artifact' ||
          lease.logicalFile.id !== artifactRef.artifactId ||
          lease.logicalFile.projectId !== record.request.projectId ||
          lease.logicalFile.sessionId !== record.identity.sessionId ||
          BigInt(lease.size) !== lease.version.sizeBytes
        )
          throw new Error('Artifact version integrity or ownership mismatch')
        assertWithinResourceBudget('file', lease.size, LOCAL_RESOURCE_BUDGETS.artifactFileBytes)
        total += lease.size
        assertWithinResourceBudget('turn', total, LOCAL_RESOURCE_BUDGETS.artifactTurnBytes)
        const path = scientific
          ? logicalPath(lease.version.filename)
          : decodeName(lease.version.filename)
        const mime = lease.version.contentType?.split(';', 1)[0]?.trim().toLowerCase()
        // Declared rich/binary formats remain descriptors even when their header happens to be
        // ASCII. Missing MIME retains the original strict UTF-8 projection when lossless.
        let textual =
          !mime ||
          mime === 'application/octet-stream' ||
          mime.startsWith('text/') ||
          /^application\/(?:json|[^/]+\+json|xml|[^/]+\+xml|javascript|x-javascript|yaml|x-yaml|toml|x-ndjson)$/.test(
            mime
          )
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        const chunks: string[] = []
        const hash = createHash('sha256')
        for (let offset = 0; offset < lease.size; offset += 64 * 1024) {
          signal?.throwIfAborted()
          const end = Math.min(lease.size, offset + 64 * 1024)
          const bytes = await lease.readRange(offset, end)
          if (bytes.byteLength !== end - offset)
            throw new Error('Artifact version read was incomplete')
          hash.update(bytes)
          if (textual) {
            try {
              const text = decoder.decode(bytes, { stream: true })
              if (lease.size <= 1024 * 1024) chunks.push(text)
            } catch {
              textual = false
              chunks.length = 0
            }
          }
        }
        if (textual) {
          try {
            const tail = decoder.decode()
            if (lease.size <= 1024 * 1024) chunks.push(tail)
          } catch {
            textual = false
            chunks.length = 0
          }
        }
        await lease.verifyUnchanged()
        signal?.throwIfAborted()
        const checksum = 'sha256:' + hash.digest('hex')
        if (checksum !== 'sha256:' + artifactRef.checksum)
          throw new Error('Artifact version bytes changed')
        if (textual) {
          textTotal += lease.size
          if (lease.size > 1024 * 1024 || textTotal > 4 * 1024 * 1024)
            throw new Error('Candidate artifacts exceed text export profile')
          files.push({
            path,
            content: chunks.join(''),
            digest: checksum,
            artifactRef: structuredClone(artifactRef)
          })
        } else {
          files.push(
            normalizeCandidateArtifactFile({
              path: binaryPath(path),
              representation: 'binary',
              sizeBytes: lease.size,
              ...(lease.version.contentType ? { contentType: lease.version.contentType } : {}),
              digest: checksum,
              artifactRef: structuredClone(artifactRef)
            })
          )
        }
      } finally {
        await lease.close()
      }
    }
    if (
      new Set(files.map((file) => file.path.normalize('NFC').toLowerCase())).size !== files.length
    )
      throw new Error('Colliding output paths')
    if (files.some((file) => 'representation' in file)) {
      const paths = files.map((file) => file.path.normalize('NFC').toLowerCase()).sort()
      if (
        paths.some((path) =>
          paths.some((parent) => path !== parent && path.startsWith(parent + '/'))
        )
      )
        throw new Error('Overlapping binary output paths')
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
      const compute = target.evidence.references.some((ref) =>
        ref.id.startsWith('compute-candidate:')
      )
      if (compute) await verifyExportRecord(target, signal)
      else await pinnedTurn(target)
      const frozen = await snapshots.resolve(target.request)
      if (isComputeToolsProfile(frozen.harness.tools) !== compute)
        throw new Error('Compute source has no complete original execution binding')
      if (!notebookLanguageForTools(frozen.harness.tools) && !compute)
        throw new Error('Target has no host-frozen scientific profile')
      return readSemanticSourceVersions({
        versions,
        projectId: target.request.projectId,
        inputs: compute
          ? normalizeFrozenManagedInputs(frozen.task.managedInputs ?? [])
          : normalizeFrozenNotebookInputs(frozen.task.managedInputs),
        ...(compute ? { allowEmpty: true } : {}),
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
    const scientificLanguage = notebookLanguageForTools(materialized.snapshots.harness.tools)
    const scientific = scientificLanguage !== undefined
    const compute = isComputeToolsProfile(materialized.snapshots.harness.tools)
      ? options.compute
      : undefined
    const frozenCompute = isComputeToolsProfile(materialized.snapshots.harness.tools)
      ? normalizeFrozenComputeContext(materialized.snapshots.environment.compute)
      : undefined
    if (
      frozenCompute &&
      (!compute ||
        !options.notebook ||
        scientific ||
        !['baseline', 'candidate'].includes(request.role))
    )
      throw new Error('Compute candidate original owners unavailable')
    if (
      frozenCompute &&
      (frozenCompute.sourceProjectId !== request.projectId ||
        frozenCompute.sourceSessionId !== request.origin.sessionId)
    )
      throw new Error('Compute frozen source differs from its original execution')
    const science = scientific || compute ? options.notebook : undefined
    const frozenInputs = scientific
      ? normalizeFrozenNotebookInputs(materialized.snapshots.task.managedInputs)
      : compute
        ? normalizeFrozenManagedInputs(materialized.snapshots.task.managedInputs ?? [])
        : []
    const frozenRuntime = scientific
      ? normalizeFrozenNotebookRuntime(materialized.snapshots.environment.notebook?.runtime)
      : undefined
    if (frozenRuntime && frozenRuntime.language !== scientificLanguage)
      throw new Error('Frozen Notebook runtime and profile language mismatch')
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
    let computeClosing = false
    let applicationDispatch:
      Pick<AcpExecutionDispatch, 'operation' | 'request' | 'attribution'> | undefined
    let applicationPrompt: { messageId: string; token?: string } | undefined
    let revision = 0
    const waiters = new Set<() => void>()
    const wake = (): void => {
      revision += 1
      for (const waiter of waiters) waiter()
    }
    const waitForChange = (since: number): Promise<void> =>
      revision !== since
        ? Promise.resolve()
        : new Promise((resolve) => {
            const done = (): void => {
              waiters.delete(done)
              resolve()
            }
            waiters.add(done)
          })
    const assertComputeSource = async (providerId?: string): Promise<void> => {
      if (!compute || !frozenCompute || computeClosing || closing)
        throw new BackgroundResultDeliveryUnavailableError()
      context.signal.throwIfAborted()
      await assertFrozenComputeContext({
        frozen: frozenCompute,
        source: await load(frozenCompute.sourceProjectId, frozenCompute.sourceSessionId),
        hosts: compute.hosts,
        ...(providerId ? { providerId } : {})
      })
    }
    const inspectOwnedJobs = async (): Promise<Awaited<ReturnType<typeof computeFacts>>> => {
      if (!sessionId) throw new Error('Private Compute Session unavailable')
      const facts = await computeFacts(request.projectId, sessionId, promptMessageId)
      const expected = (job: ComputeJob): boolean =>
        Boolean(
          frozenCompute?.hosts.some(
            (host) =>
              host.providerId === job.provider_id &&
              host.shape === job.shape &&
              host.executionMode === job.execution_mode
          )
        )
      return {
        ...facts,
        jobs: facts.jobs.filter(expected),
        foreignJobs: [...facts.foreignJobs, ...facts.jobs.filter((job) => !expected(job))]
      }
    }
    const cancelCompute = async (): Promise<void> => {
      computeClosing = true
      wake()
      if (!compute || !sessionId) return
      compute.cancelApprovals(sessionId)
      options.notebook!.rpc.releaseSessionCapabilities(sessionId)
      const current = await load(request.projectId, sessionId)
      const continuation = applicationPrompt
      const token = activeToken
      const promptCancellation =
        continuation &&
        token &&
        continuation.token === token &&
        current.activeRun?.promptMessageId === continuation.messageId
          ? runtime.cancelPrompt({ sessionId })
          : Promise.resolve()
      // The original Notebook epoch owns the persistent control token and in-flight host calls.
      // Retire it before enumerating Jobs, so a submit crossing Stop cannot escape the inventory.
      const notebookCancellation = options.notebook!.service.shutdown({
        projectId: request.projectId,
        sessionId,
        workspaceCwd: materialized.cwd
      })
      const jobsCancellation = (async () => {
        await notebookCancellation.catch(() => undefined)
        const facts = admitted ? await inspectOwnedJobs() : undefined
        const results = await Promise.allSettled(
          (facts?.jobs ?? []).map(async (job) => {
            if (!(await computeJobStopped(job)))
              await compute.service.cancelJob(job.job_id, {
                projectId: request.projectId,
                sessionId: sessionId!,
                providerId: job.provider_id
              })
          })
        )
        const failures = results
          .filter((value) => value.status === 'rejected')
          .map((value) => value.reason)
        if (facts?.foreignJobs.length)
          failures.push(new Error('Private Compute Session has foreign producer Jobs'))
        if (failures.length)
          throw new AggregateError(failures, 'Owned Compute Job cancellation unavailable')
      })()
      const results = await Promise.allSettled([
        promptCancellation,
        notebookCancellation,
        jobsCancellation
      ])
      const failures = results
        .filter((value) => value.status === 'rejected')
        .map((value) => value.reason)
      if (failures.length)
        throw new AggregateError(failures, 'Owned Compute cancellation unavailable')
      // Do not wait for readResult or context.signal here: Core abort follows this acknowledgment.
      // Remote reaper settlement is independently checked by the original resource owner at shutdown.
    }
    const computeSettled = async (): Promise<boolean> => {
      if (!compute || !sessionId) return true
      try {
        if (!admitted)
          return (
            (await compute.jobs.findByOwner({ projectId: request.projectId, sessionId })).length ===
            0
          )
        const facts = await inspectOwnedJobs()
        return (
          !facts.foreignJobs.length &&
          (await Promise.all(facts.jobs.map(computeJobStopped))).every(Boolean)
        )
      } catch {
        return false
      }
    }
    const validateDelivery = async (
      delivery: Pick<
        Parameters<CandidateContinuationTarget['sendContinuation']>[0],
        'sessionId' | 'deliveryIds' | 'continuationMessageId'
      >
    ): Promise<void> => {
      if (
        !compute ||
        delivery.sessionId !== sessionId ||
        !delivery.deliveryIds.length ||
        new Set(delivery.deliveryIds).size !== delivery.deliveryIds.length
      )
        throw new Error('Private Compute delivery identity mismatch')
      await assertComputeSource()
      const facts = await inspectOwnedJobs()
      if (facts.foreignJobs.length)
        throw new Error('Private Compute producer ownership unavailable')
      const rows = await compute.deliveries.listContinuation(
        delivery.sessionId,
        delivery.continuationMessageId
      )
      if (
        rows.length !== delivery.deliveryIds.length ||
        rows.some(
          (row) =>
            row.projectId !== request.projectId ||
            row.sessionId !== sessionId ||
            row.sourceKind !== 'compute-job' ||
            !delivery.deliveryIds.includes(row.id) ||
            !facts.jobs.some((job) => job.job_id === row.sourceId && isComputeJobResultFinal(job))
        )
      )
        throw new Error('Private Compute delivery has no exact original final Job')
      if (computeClosing || closing || context.signal.aborted)
        throw new BackgroundResultDeliveryUnavailableError()
    }
    const continuationTarget: CandidateContinuationTarget = {
      sendContinuation(delivery) {
        let acknowledge!: () => void
        let reject!: (error: unknown) => void
        const admitted = new Promise<void>((yes, no) => {
          acknowledge = yes
          reject = no
        })
        const result = (async () => {
          try {
            await validateDelivery(delivery)
            const current = await load(request.projectId, delivery.sessionId)
            const prompt = {
              ...buildAgentResultContinuationPrompt(current, delivery),
              permissionPrompts: 'none' as const
            }
            const attribution = {
              kind: 'application' as const,
              feature: 'background-results' as const,
              purpose: 'agent-result-delivery' as const,
              deliveryKey: `agent-result-delivery:${delivery.continuationMessageId}`,
              deliveryIds: [...delivery.deliveryIds]
            }
            applicationPrompt = { messageId: delivery.continuationMessageId }
            applicationDispatch = {
              operation: 'sendApplicationPrompt',
              request: prompt,
              attribution
            }
            const response = await runtime.sendApplicationPrompt(
              prompt,
              attribution,
              undefined,
              (pending) => {
                void pending.then(acknowledge, reject)
                setImmediate(acknowledge)
              }
            )
            await runtimeSessions.flush(delivery.sessionId, delivery.continuationMessageId)
            acknowledge()
            return {
              stopReason: response.stopReason,
              continuationMessageId: delivery.continuationMessageId
            }
          } catch (error) {
            reject(error)
            throw error
          } finally {
            applicationDispatch = undefined
            applicationPrompt = undefined
            wake()
          }
        })()
        return { admitted, result }
      },
      async isContinuationSaved(delivery) {
        await validateDelivery(delivery)
        const current = await load(request.projectId, delivery.sessionId)
        return hasSavedAgentResultContinuation(
          [...(current.conversationGraph?.messages ?? []), ...current.messages],
          delivery
        )
      },
      async canStartSessionTurn(id) {
        if (
          id !== sessionId ||
          computeClosing ||
          closing ||
          context.signal.aborted ||
          applicationPrompt
        )
          return false
        const current = await load(request.projectId, id)
        return (
          !current.activeRun &&
          !current.promptPreparation &&
          !runtime.getState().promptInFlightSessionIds.includes(id)
        )
      }
    }
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
              if (compute) wake()
            },
            onPromptStarted: (id, token, attempt) => {
              if (!compute || !runtimeExecutionId) promptAttemptId = attempt
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
          if (!compute || !runtimeExecutionId) runtimeExecutionId = token
          activeToken = token
          if (applicationPrompt) applicationPrompt.token = token
        },
        onPromptEnded: (_sessionId, token) => {
          if (activeToken === token) activeToken = undefined
          if (compute) wake()
        },
        onEvent: () => undefined
      }
    )
    runtime.setExecutionBoundary(
      createAcpExecutionBoundary({
        ...(compute
          ? {
              applicationOwner: {
                projectId: request.projectId,
                sourceSessionId: frozenCompute!.sourceSessionId,
                ownsExecution: (id: string) => id === context.executionId,
                ownsSession: (id: string) => id === sessionId,
                ownsTurn: (
                  value: import('../../shared/acp').AgentTurnProvenanceContext | undefined
                ) =>
                  Boolean(
                    applicationDispatch &&
                    canonical(value) === canonical(applicationDispatch.request.provenanceContext)
                  ),
                ownsApplicationDispatch: (input: AcpExecutionDispatch) =>
                  Boolean(
                    !computeClosing &&
                    applicationDispatch &&
                    input.operation === applicationDispatch.operation &&
                    input.attribution === applicationDispatch.attribution &&
                    input.request.sessionId === applicationDispatch.request.sessionId &&
                    canonical(input.request.provenanceContext) ===
                      canonical(applicationDispatch.request.provenanceContext)
                  )
              }
            }
          : {}),
        host: createSessionExecutionHost({
          dataRoot: options.dataRoot,
          configRoot: options.configRoot,
          getClient: options.getClient,
          settings: options.settings,
          versions,
          flush: (sessionId, promptId) => runtimeSessions.flush(sessionId, promptId)
        })
      })
    )
    runtimes.add(runtime)
    if (compute) {
      const unsubscribe = compute.events.subscribe((event) => {
        if (
          (event.channel === 'compute:job-updated' &&
            event.payload.project_id === request.projectId &&
            event.payload.session_id === sessionId) ||
          (event.channel === 'background-result-delivery:changed' &&
            event.payload.projectId === request.projectId) ||
          event.channel === 'notebook:changed'
        )
          wake()
      })
      context.signal.addEventListener('abort', wake)
      computeResources.set(runtime, {
        cancel: cancelCompute,
        settled: computeSettled,
        release: () => {
          unsubscribe()
          context.signal.removeEventListener('abort', wake)
          wake()
        }
      })
    }
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
    const readComputeResult = async (
      settlement: AcpPromptSettlement
    ): Promise<import('../acp/earthnano-execution-driver').AcpExecutionOwnerResult> => {
      if (!compute || !admitted || !sessionId || !runtimeExecutionId)
        throw new Error('Compute execution has no original native admission')
      await runtimeSessions.flush(sessionId, promptMessageId)
      if (settlement.promptError) await cancelCompute()
      for (;;) {
        if (computeClosing || settlement.signal.aborted)
          return {
            phase: settlement.promptError ? 'failed' : 'cancelled',
            usage: { status: 'unknown' },
            evidence: {
              status: 'partial',
              scope: 'Original Compute cancellation pending resource-owner settlement',
              text: '',
              artifacts: [],
              references: [],
              limitations: ['Cancellation acknowledgment is not remote cleanup evidence.']
            }
          }
        const observed = revision
        const facts = await inspectOwnedJobs()
        if (facts.foreignJobs.length)
          throw new Error('Compute Session contains foreign producer Jobs')
        const deliveries = await Promise.all(
          facts.jobs.map((job) =>
            compute.deliveries.findBySource({
              sourceKind: 'compute-job',
              sourceId: job.job_id,
              projectId: request.projectId,
              sessionId: sessionId!
            })
          )
        )
        if (deliveries.some((delivery) => delivery?.state === 'needs-attention'))
          throw new Error('Original Compute delivery requires attention')
        if (
          !facts.session.activeRun &&
          !facts.session.promptPreparation &&
          !applicationPrompt &&
          facts.turnIds.every((id) => resolveTurnOutcome(facts.session, id)) &&
          facts.jobs.every(isComputeJobResultFinal) &&
          deliveries.every((delivery) => delivery?.state === 'consumed')
        )
          break
        await waitForChange(observed)
      }
      settlement.signal.throwIfAborted()
      const evidence = await computeEvidence(request.projectId, sessionId, promptMessageId)
      if (!evidence.artifacts.length)
        throw new Error('Compute candidate published no original report')
      const files = await readFiles(
        { request, identity: { sessionId }, evidence: { artifacts: evidence.artifacts } } as Pick<
          ExecutionRecord,
          'request' | 'identity' | 'evidence'
        >,
        true,
        settlement.signal
      )
      const reviewRefs: Ref[] = []
      for (const turn of evidence.turns) {
        const versions = new Set(turn.scope.artifactVersionIds)
        const turnFiles = files.filter((file) => versions.has(file.artifactRef.versionId))
        if (!turnFiles.length) continue
        const manifest = {
          schemaVersion: 1,
          files: turnFiles.map((file) => {
            let jsonSyntax: 'valid' | 'invalid' | 'not-applicable' = 'not-applicable'
            if ('content' in file && /\.json$/i.test(file.path)) {
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
        }
        const invalidJsonCount = manifest.files.filter(
          (file) => file.jsonSyntax === 'invalid'
        ).length
        let reviewId: string | undefined
        try {
          settlement.signal.throwIfAborted()
          const review = await reviews.createReview({
            projectId: request.projectId,
            sessionId,
            turnMessageId: turn.scope.turnMessageId,
            scope: turn.scope,
            scopeSnapshot: turn.blocks,
            model: 'deterministic-file-integrity-v1',
            lifecycle: 'running'
          })
          reviewId = review.id
          const committed = await reviews.commitScopedSubmission({
            mode: 'initial',
            reviewId,
            expectedSourceFindingIds: [],
            keepFlaggedReviewRunning: false,
            checks: [
              {
                status: invalidJsonCount ? 'fail' : 'pass',
                claim:
                  'Deterministic fixed-version file integrity and JSON syntax only; no Compute or binary semantic assessment',
                evidence: canonical({
                  fileCount: turnFiles.length,
                  invalidJsonCount,
                  manifestDigest: digest(canonical(manifest))
                }),
                artifactVersionId: turnFiles[0].artifactRef.versionId,
                sortIndex: 0
              }
            ],
            reviewerLog: [
              {
                kind: 'tool',
                toolName: 'earthnano.file-integrity-manifest',
                title: 'Original Compute Turn fixed-version output inventory',
                rawInput: canonical(manifest),
                rawOutput: canonical({ invalidJsonCount }),
                status: invalidJsonCount ? 'error' : 'ok'
              }
            ]
          })
          settlement.signal.throwIfAborted()
          reviewRefs.push({
            id: `review:${committed.id}`,
            version: String(committed.updatedAt),
            digest: digest(canonical(committed))
          })
        } catch (error) {
          if (reviewId)
            await reviews.updateReview(reviewId, {
              lifecycle: 'error',
              outcome: null,
              errorMessage: 'Compute Turn integrity review could not be completed.'
            })
          throw error
        }
      }
      return {
        phase: settlement.promptError ? 'failed' : 'completed',
        usage: { status: 'unknown' },
        identity: {
          sessionId,
          promptMessageId,
          runtimeExecutionId,
          turnToken: runtimeExecutionId,
          promptAttemptId
        },
        evidence: {
          status: 'complete',
          scope:
            'Original admitted Compute Turns, Jobs, producers, fixed Versions and per-Turn integrity Reviews',
          text: evidence.turns.map(turnReply).join('\n'),
          artifacts: evidence.artifacts,
          references: [
            ...evidence.turns.map((turn) => turn.reference),
            evidence.reference,
            ...reviewRefs
          ],
          limitations: [
            'Per-Turn usage remains in the original Session; no authoritative all-Turn usage aggregate is claimed.',
            'Integrity Reviews do not establish scientific correctness or binary semantics.'
          ]
        },
        configuration: prepared.configuration
      }
    }
    const owner: ClaudeCandidateOwner = {
      agent,
      preparePlan: async () => {
        context.signal.throwIfAborted()
        if (closing || shutdowns.has(runtime)) throw new Error('Candidate owner is shutting down')
        await assertProject(request.projectId)
        await verifyFrozenInputs()
        if (compute) await assertComputeSource()
        const create = (): ReturnType<typeof agent.createSession> =>
          agent.createSession({
            cwd: materialized.cwd,
            projectId: request.projectId,
            memoryEnabled: false,
            permissionProfile: 'ask'
          })
        const created = await create()
        sessionId = created.sessionId
        knownPrivateSessions.set(sessionId, runtime)
        const privateSessionId = sessionId
        if (!runtime.hasLiveSession(request.projectId, privateSessionId))
          throw new Error('Candidate runtime has no live Session')
        if (compute)
          privateCompute.set(privateSessionId, {
            target: continuationTarget,
            available: () =>
              !computeClosing &&
              !closing &&
              !context.signal.aborted &&
              runtime.hasLiveSession(request.projectId, privateSessionId),
            policy: async (binding) => {
              await assertComputeSource()
              const current = await load(request.projectId, privateSessionId)
              if (
                binding.projectId !== request.projectId ||
                binding.sessionId !== privateSessionId ||
                binding.agentFrameId !== current.conversationGraph?.rootFrameId ||
                binding.attemptId ||
                binding.executionCwd !==
                  getNotebookDataRoot(options.dataRoot, request.projectId, privateSessionId)
              )
                throw new Error('Private Compute control binding identity mismatch')
              return {
                allowedMethods: new Set(['computeCall', 'capabilitiesCall', 'hostSdkHelp']),
                interactionPolicy: request.interactionPolicy,
                assertComputeHostCurrent: (providerId) => assertComputeSource(providerId)
              }
            }
          })
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
          const scope = {
            projectId: request.projectId,
            sessionId,
            workspaceCwd: materialized.cwd
          }
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
              { ...scope, language: frozenRuntime.language, runtimeId: frozenRuntime.runtimeId },
              context.signal
            )
            if (!('bound' in result) || !same(result.bound))
              throw new Error('Frozen Notebook binding did not commit')
          } finally {
            releasePermit()
          }
          for (const category of [
            `mcp:open-science-notebook/notebook_execute:${frozenRuntime.language}`,
            'mcp:open-science-notebook/notebook_state',
            'mcp:open-science-notebook/list_notebook_runtimes',
            'mcp:open-science-artifacts/write_artifact_file'
          ])
            grants.remember(sessionId, category)
        }
        const now = Date.now()
        const text = compute
          ? `${materialized.snapshots.task.prompt}\n\n${materialized.snapshots.invocation.mission}\n\nUse the original Node control REPL (repl_execute) and the frozen Compute hosts. A Job submission receipt is not completion. Use the original complete Job result and publish bounded artifacts with write_artifact_file and its real producerRunId. Fixed input versions are staged by the host. Do not use Shell, Python/R execution, runtime or environment changes, connectors or nested agents.`
          : scientific
            ? `${materialized.snapshots.task.prompt}\n\n${materialized.snapshots.invocation.mission}\n\nUse the bound ${frozenRuntime!.language === 'r' ? 'R Notebook (execute with explicit language:r)' : 'Python Notebook'} and the fixed Notebook input versions listed below. Publish bounded artifacts (data, figures or reports) with write_artifact_file and the real producerRunId. The host has pinned the runtime; do not bind or switch it, install packages, use Shell or start background work.`
            : `${materialized.snapshots.task.prompt}\n\n${materialized.snapshots.invocation.mission}\n\nINPUT: ${materialized.inputDir}\nOUTPUT: ${materialized.outputDir}\nTask files are in INPUT. Inputs and embedded context are read-only reference material. Write deliverables under OUTPUT. For proposer/composer harness output, write OUTPUT/context/harness/instructions.md and optional OUTPUT/context/harness/skills/<name>/SKILL.md. Do not use the Python working directory.`
        const idleSession: PersistedChatSession = {
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
        }
        const idle = compute
          ? await compute.hostAccess.createSession(
              {
                ...idleSession,
                enabledComputeHosts: [...frozenCompute!.access.enabledProviderIds],
                selectedComputeHosts: [...frozenCompute!.access.selectedProviderIds]
              },
              (value) => coordinator.saveSession(value)
            )
          : await coordinator.saveSession(idleSession)
        if (compute) {
          // Persisted private Sessions must remain identifiable even if later preparation fails.
          context.identity({ sessionId, promptMessageId })
          notebookPolicyReleases.set(
            runtime,
            science!.service.registerHostPermissionPolicy({
              projectId: request.projectId,
              sessionId,
              permissionPrompts: 'none'
            })
          )
          for (const category of [
            'mcp:open-science-notebook/repl_execute',
            'mcp:open-science-artifacts/write_artifact_file'
          ])
            grants.remember(sessionId, category)
        }
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
            if (compute) await assertComputeSource()
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
          ...(compute ? { cancelOwnedBackground: cancelCompute } : {}),
          readResult: async (settlement) => {
            if (compute) return readComputeResult(settlement)
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
                  await runtimeSessions.publish({
                    ...publication,
                    executionId: runtimeExecutionId
                  })
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
              { request, identity: { sessionId }, evidence: { artifacts } } as Pick<
                ExecutionRecord,
                'request' | 'identity' | 'evidence'
              >,
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
                  run.kernelKind === frozenRuntime!.language &&
                  run.executionInvocationId &&
                  (run.runtimeId ?? run.frozenRuntimeTarget?.runtimeId) ===
                    frozenRuntime!.runtimeId &&
                  run.frozenRuntimeTarget?.source === frozenRuntime!.source &&
                  run.frozenRuntimeTarget?.interpreterPath === frozenRuntime!.interpreterPath &&
                  canonical((run.inputFiles ?? []).map(tuple)) === canonical(frozenInputs)
              )
              if (!validRuns.length)
                throw new Error(
                  `Scientific candidate has no original completed fixed-input ${frozenRuntime!.language} Run`
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
              if ('content' in file && /\.json$/i.test(file.path)) {
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
                claim: files.some((file) => 'representation' in file)
                  ? 'Deterministic file integrity / text encoding / JSON syntax only; binary content and semantics are not assessed'
                  : 'Deterministic file integrity / UTF-8 / JSON syntax only; no semantic assessment',
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
              usage: readOriginalExecutionUsage(frozen.session, {
                sessionId,
                promptMessageId,
                runtimeExecutionId
              }),
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
    if (compute) {
      const prepare = owner.preparePlan
      owner.preparePlan = () =>
        compute.hostAccess.withReservation(frozenCompute!.access.enabledProviderIds, prepare)
    }
    return owner
  }
  const verifyExportRecord = async (
    record: ExecutionRecord,
    signal?: AbortSignal
  ): Promise<{
    frozen: OriginalTurnEvidence
    replyText: string
    turns?: OriginalTurnEvidence[]
  }> => {
    signal?.throwIfAborted()
    validateRecord(record)
    if (
      record.requestDigest !== requestDigest(record.request) ||
      record.identity.promptMessageId !== `candidate-prompt-${record.executionId}`
    )
      throw new Error('Candidate execution does not match its original turn identity')
    const computeRef = record.evidence.references.find((ref) =>
      ref.id.startsWith('compute-candidate:')
    )
    const computed = computeRef
      ? await computeEvidence(
          record.request.projectId,
          record.identity.sessionId!,
          record.identity.promptMessageId!
        )
      : undefined
    if (
      computed &&
      (canonical(computeRef) !== canonical(computed.reference) ||
        canonical(computed.artifacts) !== canonical(record.evidence.artifacts) ||
        canonical(
          record.evidence.references.filter((ref) => ref.id.startsWith('session-turn:'))
        ) !== canonical(computed.turns.map((turn) => turn.reference)))
    )
      throw new Error('Original Compute Turn/Job/Version evidence changed')
    const frozen = computed ? computed.turns[0] : await pinnedTurn(record)
    if (
      !record.identity.runtimeExecutionId ||
      !frozen.session.runtimeSessionAdmissions?.some(
        (admission) =>
          admission.promptMessageId === record.identity.promptMessageId &&
          admission.executionId === record.identity.runtimeExecutionId
      )
    )
      throw new Error('Candidate execution has no exact original runtime admission')
    const scientificRef = record.evidence.references.find((ref) =>
      ref.id.startsWith('notebook-scientific:')
    )
    if (scientificRef) {
      const runs = (
        await notebookRuns.readSessionRuns(record.request.projectId, record.identity.sessionId!)
      ).filter((run) => run.promptMessageId === record.identity.promptMessageId)
      if (digest(canonical(runs)) !== scientificRef.digest)
        throw new Error('Original scientific Notebook Runs changed')
      for (const artifact of record.evidence.artifacts) {
        const { execution } = await provenance.getVersionExecution({
          projectId: record.request.projectId,
          appSessionId: record.identity.sessionId!,
          artifactId: artifact.artifactId,
          versionId: artifact.versionId
        })
        if (
          !execution ||
          execution.terminalPromptMessageId !== record.identity.promptMessageId ||
          !runs.some(
            (run) =>
              run.runId === execution.producerRunId &&
              run.status === 'completed' &&
              run.promptMessageId === record.identity.promptMessageId
          )
        )
          throw new Error('Scientific ArtifactVersion has no original Notebook producer')
      }
    }
    signal?.throwIfAborted()
    const replyText = computed ? computed.turns.map(turnReply).join('\n') : turnReply(frozen)
    if (replyText !== record.evidence.text)
      throw new Error('Execution reply differs from original committed turn')
    return { frozen, replyText, ...(computed ? { turns: computed.turns } : {}) }
  }
  const commitComputeTurnReviews = async (input: {
    target: ExecutionRecord
    turns: OriginalTurnEvidence[]
    model: string
    toolName: string
    metadata: unknown
    findings: Map<string, NewCheck[]>
    outcome: 'pass' | 'flagged'
    signal?: AbortSignal
  }): Promise<
    import('../../shared/earthnano/research-outcome').CommittedReviewReferences & {
      outcome: 'pass' | 'flagged'
    }
  > => {
    const existing = await reviews.getReviewsForProjectSession(
      input.target.request.projectId,
      input.target.identity.sessionId!
    )
    const reviewIds: string[] = []
    for (const turn of input.turns) {
      const checks = input.findings.get(turn.scope.turnMessageId)
      if (!checks?.length) continue
      const status = checks.some((check) => check.status !== 'pass') ? 'flagged' : 'pass'
      const metadata = {
        binding: input.metadata,
        turn: turn.reference,
        targetExecutionId: input.target.executionId
      }
      const prior = existing.find(
        (review) =>
          review.lifecycle === 'complete' &&
          review.outcome === status &&
          review.turnMessageId === turn.scope.turnMessageId &&
          canonical(review.scope) === canonical(turn.scope) &&
          review.reviewerLog.some(
            (entry) =>
              entry.kind === 'tool' &&
              entry.toolName === input.toolName &&
              entry.rawInput === canonical(metadata)
          )
      )
      if (prior) {
        reviewIds.push(prior.id)
        continue
      }
      let reviewId: string | undefined
      try {
        input.signal?.throwIfAborted()
        const review = await reviews.createReview({
          projectId: input.target.request.projectId,
          sessionId: input.target.identity.sessionId!,
          turnMessageId: turn.scope.turnMessageId,
          scope: turn.scope,
          scopeSnapshot: turn.blocks,
          model: input.model,
          lifecycle: 'running'
        })
        reviewId = review.id
        input.signal?.throwIfAborted()
        const committed = await reviews.commitScopedSubmission({
          mode: 'initial',
          reviewId,
          expectedSourceFindingIds: [],
          keepFlaggedReviewRunning: false,
          checks,
          reviewerLog: [
            {
              kind: 'tool',
              toolName: input.toolName,
              title: 'Original per-Turn fixed-version assessment binding',
              rawInput: canonical(metadata),
              rawOutput: canonical({ checks }),
              status: status === 'pass' ? 'ok' : 'error'
            }
          ]
        })
        input.signal?.throwIfAborted()
        if (committed.lifecycle !== 'complete' || committed.outcome !== status)
          throw new Error('Original Compute Turn Review outcome did not commit')
        reviewIds.push(committed.id)
      } catch (error) {
        if (reviewId)
          await reviews.updateReview(reviewId, {
            lifecycle: 'error',
            outcome: null,
            errorMessage: 'Compute Turn assessment could not be completed.'
          })
        throw error
      }
    }
    if (!reviewIds.length) throw new Error('Compute assessment has no real Turn finding')
    return { reviewId: reviewIds[0], reviewIds, outcome: input.outcome }
  }
  type Projection = {
    file: CandidateBinaryArtifactFile
    assetPath: string
    cleanup(): Promise<void>
    assert(): Promise<void>
  }
  const projections = new Map<string, Promise<Projection>>()
  let projectedBytes = 0
  const projectionCleanups = new Set<() => Promise<void>>()
  const projectionStop = new AbortController()
  let projectionRoot: ReturnType<typeof projectionDirectory> | undefined
  const activeMaterializations = new Set<Promise<unknown>>()
  const materializeArtifactOwned: NonNullable<
    PersistentCandidateOwners['materializeArtifact']
  > = async (suppliedRecord, suppliedRef, suppliedSignal) => {
    const signal = suppliedSignal
      ? AbortSignal.any([suppliedSignal, projectionStop.signal])
      : projectionStop.signal
    signal.throwIfAborted()
    if (closing) throw new Error('Candidate owner factory is shutting down')
    if (!options.artifactProjectionRoot)
      throw new Error('Artifact projection root is not configured')
    const record = structuredClone(suppliedRecord)
    const artifactRef = structuredClone(suppliedRef)
    validateRecord(record)
    if (
      !['baseline', 'candidate'].includes(record.request.role) ||
      record.phase !== 'completed' ||
      record.cleanup !== 'confirmed' ||
      record.requestDigest !== requestDigest(record.request)
    )
      throw new Error('Artifact projection requires a completed original task execution')
    if (!record.evidence.artifacts.some((ref) => canonical(ref) === canonical(artifactRef)))
      throw new Error('Artifact projection reference is not in the completed execution')
    await verifyExportRecord(record, signal)
    const files = await readFiles(record, undefined, signal)
    signal.throwIfAborted()
    const file = files.find((entry) => canonical(entry.artifactRef) === canonical(artifactRef))
    if (!file || !('representation' in file))
      throw new Error('Artifact projection requires an original binary descriptor')
    const key = canonical({
      executionId: record.executionId,
      requestDigest: record.requestDigest,
      artifactRef
    })
    let pending = projections.get(key)
    if (!pending) {
      if (closing) throw new Error('Candidate owner factory is shutting down')
      if (projections.size >= 64 || projectionCleanups.size >= 64)
        throw new Error('Artifact projection inventory exceeds export profile')
      assertWithinResourceBudget(
        'turn',
        projectedBytes + file.sizeBytes,
        LOCAL_RESOURCE_BUDGETS.artifactTurnBytes
      )
      projectedBytes += file.sizeBytes
      pending = (async (): Promise<Projection> => {
        let reservationReleased = false
        const releaseReservation = (): void => {
          if (!reservationReleased) {
            reservationReleased = true
            projectedBytes -= file.sizeBytes
          }
        }
        let cleanup: (() => Promise<void>) | undefined
        try {
          projectionRoot ??= projectionDirectory(options.artifactProjectionRoot!, true)
          const root = await projectionRoot
          await root.assert()
          if (closing) throw new Error('Candidate owner factory is shutting down')
          const directory = await projectionDirectory(await mkdtemp(join(root.path, 'artifact-')))
          const alias =
            'artifact-' + digest(canonical(artifactRef)).slice(7) + extname(binaryPath(file.path))
          const assetPath = join(directory.path, alias)
          const assert = async (): Promise<void> => {
            await root.assert()
            await directory.assert()
          }
          const sourceLease: { current?: ManagedFileReadLease } = {}
          let leaseClosed = false
          let directoryRemoved = false
          const closeLease = async (): Promise<void> => {
            if (sourceLease.current && !leaseClosed) {
              await sourceLease.current.close()
              leaseClosed = true
            }
          }
          cleanup = async () => {
            // Preserve both pending source-lease release and the exact owned target on failure.
            // A later shutdown can retry; a failed close never confirms physical cleanup.
            const results = await Promise.allSettled([
              closeLease(),
              (async () => {
                if (directoryRemoved) return
                await assert()
                await chmod(directory.path, 0o700)
                // Windows's read-only file attribute must be cleared before unlinking. The
                // integrity boundary is the Version/digest checks, not POSIX permission bits.
                if (process.platform === 'win32') {
                  try {
                    await chmod(assetPath, 0o600)
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
                  }
                }
                await rm(assetPath, { force: true })
                await rmdir(directory.path)
                directoryRemoved = true
              })()
            ])
            const failures = results.flatMap((result) =>
              result.status === 'rejected' ? [result.reason] : []
            )
            if (failures.length)
              throw new AggregateError(failures, 'Artifact projection cleanup is unconfirmed')
            projectionCleanups.delete(cleanup!)
            releaseReservation()
          }
          projectionCleanups.add(cleanup)
          if (Buffer.byteLength(alias) > 240)
            throw new Error('Artifact asset alias exceeds filename budget')
          await assert()
          const lease = await versions.openVersion(
            {
              source: 'artifact',
              projectId: record.request.projectId,
              fileId: artifactRef.artifactId
            },
            artifactRef.versionId
          )
          sourceLease.current = lease
          if (
            lease.logicalFile.source !== 'artifact' ||
            lease.logicalFile.id !== artifactRef.artifactId ||
            lease.logicalFile.projectId !== record.request.projectId ||
            lease.logicalFile.sessionId !== record.identity.sessionId ||
            lease.version.fileId !== artifactRef.artifactId ||
            lease.version.id !== artifactRef.versionId ||
            lease.version.checksum !== artifactRef.checksum ||
            lease.size !== file.sizeBytes ||
            BigInt(lease.size) !== lease.version.sizeBytes
          )
            throw new Error('Artifact projection source differs from the verified Version')
          await lease.verifyUnchanged()
          await lease.assertCanCopyTo?.(assetPath)
          await assert()
          signal.throwIfAborted()
          assertDiskReserve(
            await availableBytes(directory.path),
            file.sizeBytes,
            LOCAL_RESOURCE_BUDGETS.diskReserveBytes
          )
          // The existing original lease supplies positional reads to the original bounded copier.
          // No source path is reopened or exposed to a provider; cancellation is checked per chunk.
          const source = {
            read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
              signal.throwIfAborted()
              const result = await lease!.read(buffer, offset, length, position)
              signal.throwIfAborted()
              return { ...result, buffer }
            }
          } as Pick<FileHandle, 'read'>
          const copied = await copyOpenFileWithinBudget(
            source,
            assetPath,
            LOCAL_RESOURCE_BUDGETS.artifactFileBytes,
            signal
          )
          if (copied.sizeBytes !== file.sizeBytes || 'sha256:' + copied.checksum !== file.digest)
            throw new Error('Artifact projection copy differs from its verified Version')
          await lease.verifyUnchanged()
          await verifyProjectedArtifact(assetPath, file, assert, signal)
          if (process.platform !== 'win32') {
            await chmod(assetPath, 0o400)
            await chmod(directory.path, 0o500)
          }
          await assert()
          await closeLease()
          signal.throwIfAborted()
          if (closing) throw new Error('Candidate owner factory is shutting down')
          return { file, assetPath, assert, cleanup }
        } catch (error) {
          await cleanup?.().catch(() => undefined)
          if (!cleanup) releaseReservation()
          throw error
        }
      })()

      projections.set(key, pending)
      pending.catch(() => {
        if (projections.get(key) === pending) {
          projections.delete(key)
        }
      })
    }
    let detach = (): void => undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      const abort = (): void => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      detach = () => {
        signal.removeEventListener('abort', abort)
      }
    })
    const projected = await Promise.race([pending, aborted]).finally(detach)
    await verifyProjectedArtifact(projected.assetPath, file, projected.assert, signal)
    if (closing) throw new Error('Candidate owner factory is shutting down')
    return { file: structuredClone(file), assetPath: projected.assetPath }
  }
  const materializeArtifact: NonNullable<PersistentCandidateOwners['materializeArtifact']> = (
    ...args
  ) => {
    const operation = materializeArtifactOwned(...args)
    activeMaterializations.add(operation)
    void operation.then(
      () => activeMaterializations.delete(operation),
      () => activeMaterializations.delete(operation)
    )
    return operation
  }
  return {
    openOwner,
    resolveCandidateDelivery: async (sessionId: string) => {
      const owned = privateCompute.get(sessionId)
      return !owned
        ? knownPrivateSessions.has(sessionId)
          ? { kind: 'private-unavailable' as const }
          : { kind: 'ordinary' as const }
        : !owned.available()
          ? { kind: 'private-unavailable' as const }
          : { kind: 'private' as const, target: owned.target }
    },
    resolveControlPolicy: async (
      binding: Parameters<NonNullable<PersistentCandidateOwners['resolveControlPolicy']>>[0]
    ) => {
      const owned = privateCompute.get(binding.sessionId)
      if (!owned) {
        const runtime = knownPrivateSessions.get(binding.sessionId)
        if (
          !runtime ||
          (!closing &&
            !shutdowns.has(runtime) &&
            runtime.hasLiveSession(binding.projectId, binding.sessionId))
        )
          return undefined
        throw new Error('Private control owner is unavailable')
      }
      if (!owned.available()) throw new Error('Private Compute control owner is unavailable')
      return owned.policy(binding)
    },
    readSemanticSourceEvidence,
    materializeArtifact,
    async exportResult(record: ExecutionRecord): Promise<PersistentCandidateResult> {
      const { frozen, replyText, turns } = await verifyExportRecord(record)
      return {
        executionId: record.executionId,
        artifacts: structuredClone(record.evidence.artifacts),
        replyText,
        trajectoryText: JSON.stringify(
          turns ? turns.flatMap((turn) => turn.blocks) : frozen.blocks
        ),
        files: await readFiles(record)
      }
    },
    async readReviews(record: ExecutionRecord): Promise<ReviewWithChecks[]> {
      if (record.evidence.references.some((ref) => ref.id.startsWith('compute-candidate:')))
        await verifyExportRecord(record)
      else await pinnedTurn(record)
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
      const computed = target.evidence.references.some((ref) =>
        ref.id.startsWith('compute-candidate:')
      )
        ? await verifyExportRecord(target, signal)
        : undefined
      const frozen = computed?.frozen ?? (await pinnedTurn(target))
      const results = checkOutputFiles(await readFiles(target), frozenChecks)
      if (!results.length) throw new Error('Output checks require frozen expectations')
      if (computed?.turns) {
        const findings = new Map<string, NewCheck[]>()
        for (const turn of computed.turns) {
          const matching = results.filter((result) =>
            result.artifactRef
              ? turn.scope.artifactVersionIds.includes(result.artifactRef.versionId)
              : turn === computed.turns!.at(-1)
          )
          if (!matching.length) continue
          const anchor = [...turn.blocks]
            .reverse()
            .find((block) => block.kind === 'message' && block.payload.role === 'agent')
          if (!anchor) throw new Error('Compute output check has no original Turn anchor')
          const evidence = matching.find((result) => result.artifactRef)?.artifactRef
          findings.set(turn.scope.turnMessageId, [
            {
              status: matching.every((result) => result.status === 'pass') ? 'pass' : 'fail',
              claim:
                'Frozen deterministic output checks for this original Turn; global expectations and all fixed Versions remain in the assessment binding',
              evidence: canonical({
                expectationsDigest: outputDigest(frozenChecks),
                results: matching
              }),
              ...(evidence ? { artifactVersionId: evidence.versionId } : {}),
              locator: {
                blockRef: { messageId: anchor.sourceId, blockIndex: anchor.blockIndex },
                contentHash: anchor.contentHash
              },
              sortIndex: 0
            }
          ])
        }
        return commitComputeTurnReviews({
          target,
          turns: computed.turns,
          model: 'deterministic-json-value-v1',
          toolName: 'earthnano.output-checks',
          metadata: { checks: frozenChecks, results, targetArtifacts: target.evidence.artifacts },
          findings,
          outcome: results.every((result) => result.status === 'pass') ? 'pass' : 'flagged',
          signal
        })
      }
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
    async commitSemanticReview(
      input
    ): ReturnType<PersistentCandidateOwners['commitSemanticReview']> {
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
      const computed = target.evidence.references.some((ref) =>
        ref.id.startsWith('compute-candidate:')
      )
        ? await verifyExportRecord(target, signal)
        : undefined
      const frozen = computed?.frozen ?? (await pinnedTurn(target))
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
      const scientific = target.evidence.references.some(
        (ref) =>
          ref.id.startsWith('notebook-scientific:') || ref.id.startsWith('compute-candidate:')
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
      const assessmentFile = assessmentFiles[0]
      if (
        assessmentFiles.length !== 1 ||
        !assessmentFile ||
        assessmentFile.path !== 'assessment.json' ||
        !('content' in assessmentFile)
      )
        throw new Error('Semantic assessor must publish only the fixed assessment document')
      const checked = parseSemanticAssessment(assessmentFile.content, files, criteria)
      if (semanticCanonical(checked) !== semanticCanonical(document))
        throw new Error('Semantic document differs from its committed ArtifactVersion')
      if (computed?.turns) {
        const findings = new Map<string, NewCheck[]>()
        for (const turn of computed.turns) {
          const checks = checked.checks
            .map((check) => ({
              ...check,
              evidence: check.evidence.filter((item) =>
                turn.scope.artifactVersionIds.includes(item.artifactRef.versionId)
              )
            }))
            .filter((check) => check.evidence.length)
          if (!checks.length) continue
          const anchor = [...turn.blocks]
            .reverse()
            .find((block) => block.kind === 'message' && block.payload.role === 'agent')
          if (!anchor) throw new Error('Compute semantic finding has no original Turn anchor')
          findings.set(turn.scope.turnMessageId, [
            {
              status: checks.some((check) => check.status === 'fail')
                ? 'fail'
                : checks.some((check) => check.status === 'warn')
                  ? 'warn'
                  : 'pass',
              claim:
                'Independent criterion assessment citing this original Turn; complete cross-Turn document remains bound to its original independent assessment Version',
              evidence: canonical({
                criteriaDigest,
                assessmentExecutionId: assessment.executionId,
                assessmentArtifacts: assessment.evidence.artifacts,
                checks
              }),
              artifactVersionId: checks[0].evidence[0].artifactRef.versionId,
              locator: {
                blockRef: { messageId: anchor.sourceId, blockIndex: anchor.blockIndex },
                contentHash: anchor.contentHash
              },
              sortIndex: 0
            }
          ])
        }
        return commitComputeTurnReviews({
          target,
          turns: computed.turns,
          model: assessment.configuration.model,
          toolName: 'earthnano.semantic-assessment-binding',
          metadata: {
            criteria,
            criteriaDigest,
            sourceEvidence,
            document: checked,
            assessmentExecutionId: assessment.executionId,
            assessmentArtifacts: assessment.evidence.artifacts,
            assessmentDocumentDigest: semanticDigest(assessmentFile.content),
            targetArtifacts: target.evidence.artifacts
          },
          findings,
          outcome: checked.outcome,
          signal
        })
      }
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
        assessmentDocumentDigest: semanticDigest(assessmentFile.content),
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
      projectionStop.abort(new Error('Candidate owner factory is shutting down'))
      // Verification can still own an original Version lease before a projection is allocated.
      await Promise.allSettled([...activeMaterializations])
      const pendingProjections = [...projections.values()]
      const results = await Promise.all([...runtimes].map(stop))
      await Promise.allSettled(pendingProjections)
      const projectionResults = await Promise.allSettled(
        [...projectionCleanups].map((cleanup) => cleanup())
      )
      projections.clear()
      return {
        reaped:
          results.every((result) => result.reaped) &&
          projectionResults.every((result) => result.status === 'fulfilled') &&
          projectionCleanups.size === 0
      }
    }
  }
}
