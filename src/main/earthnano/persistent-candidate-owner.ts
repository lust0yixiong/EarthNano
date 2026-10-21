import { readSemanticSourceVersions } from './semantic-source-evidence'
import { readOriginalExecutionUsage } from './execution-turn-usage'
import { createAcpNotebookBinding } from '../acp/notebook-binding'
import { ConversationPermissionGrantStore } from '../acp/permission-broker'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import type { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { NotebookRunRepository } from '../notebook/repository'
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
import type { ExecutionRecord, Ref } from '../../shared/earthnano/execution-port'
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
export interface PersistentCandidateOwnersOptions {
  dataRoot: string
  notebook?: PersistentCandidateNotebookOptions
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
    if (create) {
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
    record: Pick<ExecutionRecord, 'request' | 'evidence' | 'identity'>,
    scientific = record.evidence.references?.some((ref) =>
      ref.id.startsWith('notebook-scientific:')
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
      await pinnedTurn(target)
      const frozen = await snapshots.resolve(target.request)
      if (!notebookLanguageForTools(frozen.harness.tools))
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
    const scientificLanguage = notebookLanguageForTools(materialized.snapshots.harness.tools)
    const scientific = scientificLanguage !== undefined
    const science = scientific ? options.notebook : undefined
    const frozenInputs = scientific
      ? normalizeFrozenNotebookInputs(materialized.snapshots.task.managedInputs)
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
          settings: options.settings,
          versions,
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
        const text = scientific
          ? `${materialized.snapshots.task.prompt}\n\n${materialized.snapshots.invocation.mission}\n\nUse the bound ${frozenRuntime!.language === 'r' ? 'R Notebook (execute with explicit language:r)' : 'Python Notebook'} and the fixed Notebook input versions listed below. Publish bounded artifacts (data, figures or reports) with write_artifact_file and the real producerRunId. The host has pinned the runtime; do not bind or switch it, install packages, use Shell or start background work.`
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
    return owner
  }
  const verifyExportRecord = async (
    record: ExecutionRecord,
    signal?: AbortSignal
  ): Promise<{ frozen: OriginalTurnEvidence; replyText: string }> => {
    signal?.throwIfAborted()
    validateRecord(record)
    if (
      record.requestDigest !== requestDigest(record.request) ||
      record.identity.promptMessageId !== `candidate-prompt-${record.executionId}`
    )
      throw new Error('Candidate execution does not match its original turn identity')
    const frozen = await pinnedTurn(record)
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
    const replyText = turnReply(frozen)
    if (replyText !== record.evidence.text)
      throw new Error('Execution reply differs from original committed turn')
    return { frozen, replyText }
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
    readSemanticSourceEvidence,
    materializeArtifact,
    async exportResult(record: ExecutionRecord): Promise<PersistentCandidateResult> {
      const { frozen, replyText } = await verifyExportRecord(record)
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
