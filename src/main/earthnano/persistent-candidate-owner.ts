import { createHash } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import type { ArtifactReference, ExecutionRecord, Ref } from '../../shared/earthnano/execution-port'
import type {
  NewCheck,
  ReviewWithChecks,
  TurnScope,
  ReviewScopeSnapshotBlock
} from '../../shared/reviewer'
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
import { resolveTurnScopeWithArtifactDigests } from '../reviewer/artifact-digest'
import { ReviewRepository } from '../reviewer/repository'
import { buildReviewScopeSnapshot } from '../reviewer/scope-snapshot'
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

export interface PersistentCandidateOwnersOptions {
  dataRoot: string
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
  commitSemanticReview(input: {
    target: ExecutionRecord
    assessment: ExecutionRecord
    criteria: string
    criteriaDigest: string
    document: SemanticAssessmentDocument
    signal?: AbortSignal
  }): Promise<{ reviewId: string; outcome: 'pass' | 'flagged' }>
  shutdown(): Promise<{ reaped: boolean }>
}
type FrozenTurn = {
  session: PersistedChatSession
  scope: TurnScope
  blocks: ReviewScopeSnapshotBlock[]
  reference: Ref
}
const canonical = (value: unknown): string => {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort)
    if (entry && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, sort(v)])
      )
    return entry
  }
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value))))
}
const digest = (value: string | Uint8Array): string =>
  'sha256:' + createHash('sha256').update(value).digest('hex')
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
        files.push({ path, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) })
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
  const sessions = new SessionRepository(
    options.dataRoot,
    {},
    new SessionProjectionRepository(options.getClient)
  )
  const coordinator = new SessionPersistenceCoordinator(sessions, index)
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
  const runtimes = new Set<AcpRuntimeCoordinator>()
  const shutdowns = new Map<AcpRuntimeCoordinator, Promise<{ reaped: boolean }>>()
  let closing = false
  const stop = (runtime: AcpRuntimeCoordinator): Promise<{ reaped: boolean }> => {
    let pending = shutdowns.get(runtime)
    if (!pending) {
      pending = runtime
        .shutdownForQuit()
        .then(({ reaped }) => ({ reaped }))
        .catch(() => ({ reaped: false }))
      shutdowns.set(runtime, pending)
    }
    return pending
  }
  const scopeSnapshot = async (
    projectId: string,
    sessionId: string,
    promptId: string
  ): Promise<FrozenTurn> => {
    const session = await load(projectId, sessionId)
    const scope = await resolveTurnScopeWithArtifactDigests(
      session,
      promptId,
      options.dataRoot,
      async (request) => {
        if (!request.fileId) throw new Error('Artifact logical identity missing')
        const lease = await versions.openVersion(
          { source: 'artifact', projectId, fileId: request.fileId },
          request.versionId
        )
        return { ...lease, filename: lease.version.filename, checksum: lease.version.checksum }
      }
    )
    const blocks = buildReviewScopeSnapshot(session, scope)
    return {
      session,
      scope,
      blocks,
      reference: {
        id: `session-turn:${sessionId}:${promptId}`,
        version: promptId,
        digest: digest(canonical({ scope, blocks }))
      }
    }
  }
  const pinnedTurn = async (record: ExecutionRecord): Promise<FrozenTurn> => {
    const { sessionId, promptMessageId } = record.identity
    if (!sessionId || !promptMessageId) throw new Error('Execution has no durable turn identity')
    const result = await scopeSnapshot(record.request.projectId, sessionId, promptMessageId)
    if (!record.evidence.references.some((ref) => canonical(ref) === canonical(result.reference)))
      throw new Error('Durable Session turn changed or is not pinned by execution')
    const attached = new Map((result.session.artifacts ?? []).map((file) => [file.versionId, file]))
    if (
      result.scope.artifactVersionIds.length !== record.evidence.artifacts.length ||
      new Set(record.evidence.artifacts.map((ref) => ref.versionId)).size !==
        record.evidence.artifacts.length
    )
      throw new Error('Execution Artifact inventory differs from pinned turn')
    for (const ref of record.evidence.artifacts) {
      const file = attached.get(ref.versionId)
      if (
        !file ||
        file.artifactId !== ref.artifactId ||
        !result.scope.artifactVersionIds.includes(ref.versionId)
      )
        throw new Error('Artifact version does not belong to pinned turn')
    }
    return result
  }
  const readFiles = async (
    record: Pick<ExecutionRecord, 'request' | 'evidence'>
  ): Promise<PersistentCandidateFile[]> => {
    const files: PersistentCandidateFile[] = []
    for (const artifactRef of record.evidence.artifacts) {
      const lease = await versions.openVersion(
        { source: 'artifact', projectId: record.request.projectId, fileId: artifactRef.artifactId },
        artifactRef.versionId
      )
      try {
        if (lease.version.checksum !== artifactRef.checksum || lease.size > 1024 * 1024)
          throw new Error('Artifact version integrity mismatch')
        const bytes = await lease.readRange(0, lease.size)
        await lease.verifyUnchanged()
        if (digest(bytes) !== 'sha256:' + artifactRef.checksum)
          throw new Error('Artifact version bytes changed')
        files.push({
          path: decodeName(lease.version.filename),
          content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          digest: digest(bytes),
          artifactRef: structuredClone(artifactRef)
        })
      } finally {
        await lease.close()
      }
    }
    return files
  }
  const openOwner: ClaudeCandidateDriverOptions['openOwner'] = async ({
    prepared,
    materialized,
    request,
    context
  }) => {
    if (closing) throw new Error('Candidate owner factory is shutting down')
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
    runtimes.add(runtime)
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
        const created = await agent.createSession({
          cwd: materialized.cwd,
          projectId: request.projectId,
          memoryEnabled: false,
          permissionProfile: 'ask'
        })
        sessionId = created.sessionId
        const now = Date.now()
        const text = `${materialized.snapshots.task.prompt}\n\n${materialized.snapshots.invocation.mission}\n\nINPUT: ${materialized.inputDir}\nOUTPUT: ${materialized.outputDir}\nTask files are in INPUT. Inputs and embedded context are read-only reference material. Write deliverables under OUTPUT. For proposer/composer harness output, write OUTPUT/context/harness/instructions.md and optional OUTPUT/context/harness/skills/<name>/SKILL.md. Do not use the Python working directory.`
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
            if (!settlement.promptError && !settlement.cancellationRequested) {
              const outputs = await collectOutputs(materialized.outputDir)
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
            if (frozen.session.activeRun?.promptMessageId === promptMessageId)
              throw new Error('Original Session terminal commit is incomplete')
            const artifacts: ArtifactReference[] = []
            for (const id of frozen.scope.artifactVersionIds) {
              const file = frozen.session.artifacts?.find((entry) => entry.versionId === id)
              if (!file?.artifactId || !file.versionId)
                throw new Error('Finalized Artifact version identity unavailable')
              const lease = await versions.openVersion(
                { source: 'artifact', projectId: request.projectId, fileId: file.artifactId },
                id
              )
              try {
                await lease.verifyUnchanged()
                artifacts.push({
                  artifactId: file.artifactId,
                  versionId: id,
                  checksum: lease.version.checksum
                })
              } finally {
                await lease.close()
              }
            }
            const files = await readFiles({ request, evidence: { artifacts } } as Pick<
              ExecutionRecord,
              'request' | 'evidence'
            >)
            const checks: NewCheck[] = files.map((file, sortIndex) => {
              let valid = true
              if (file.path.endsWith('.json')) {
                try {
                  JSON.parse(file.content)
                } catch {
                  valid = false
                }
              }
              return {
                status: valid ? 'pass' : 'fail',
                claim:
                  'Deterministic file integrity / UTF-8 / JSON syntax only; no semantic assessment',
                evidence: `${file.path}: ${file.digest}; JSON syntax ${valid ? 'valid or not applicable' : 'invalid'}`,
                artifactVersionId: file.artifactRef.versionId,
                sortIndex
              }
            })
            if (!checks.length)
              checks.push({
                status: 'warn',
                claim: 'Deterministic output inventory only; no semantic assessment',
                evidence: 'No output ArtifactVersion was published.'
              })
            const review = await reviews.createReview({
              projectId: request.projectId,
              sessionId,
              turnMessageId: promptMessageId,
              scope: frozen.scope,
              scopeSnapshot: frozen.blocks,
              model: 'deterministic-file-integrity-v1',
              lifecycle: 'running'
            })
            const committed = await reviews.commitScopedSubmission({
              mode: 'initial',
              reviewId: review.id,
              checks,
              expectedSourceFindingIds: [],
              keepFlaggedReviewRunning: false
            })
            const reviewRef: Ref = {
              id: `review:${committed.id}`,
              version: String(committed.updatedAt),
              digest: digest(canonical(committed))
            }
            const replyText = frozen.blocks
              .filter((block) => block.kind === 'message' && block.payload.role === 'agent')
              .map((block) => String(block.payload.content ?? ''))
              .join('\n')
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
                references: [frozen.reference, reviewRef],
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
    async exportResult(record: ExecutionRecord): Promise<PersistentCandidateResult> {
      const frozen = await pinnedTurn(record)
      const replyText = frozen.blocks
        .filter((block) => block.kind === 'message' && block.payload.role === 'agent')
        .map((block) => String(block.payload.content ?? ''))
        .join('\n')
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
    async commitSemanticReview(input): Promise<{ reviewId: string; outcome: 'pass' | 'flagged' }> {
      const { target, assessment, criteria, criteriaDigest, document, signal } = input
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
      // Keep the domain's five-Finding limit: one aggregate Finding links the complete frozen
      // assessment artifact. All per-criterion paths/quotes/refs remain in that version and log.
      const finding: NewCheck = {
        status: checked.outcome === 'pass' ? 'pass' : 'fail',
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
