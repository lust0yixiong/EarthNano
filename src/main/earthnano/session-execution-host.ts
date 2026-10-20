import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import type { ExecutionRequest, Ref } from '../../shared/earthnano/execution-port'
import { resolveTurnOutcome, type PersistedChatSession } from '../../shared/session-persistence'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ProjectRepository } from '../projects/repository'
import { SessionProjectionRepository } from '../session-persistence/projection'
import { loadSessionMutationAuthority, SessionRepository } from '../session-persistence/repository'
import { SettingsRepository } from '../settings/repository'
import { FileExecutionStore, recoverExecutionJournals } from './execution-store'
import {
  createOriginalTurnEvidenceReader,
  originalEvidenceCanonical,
  originalEvidenceDigest,
  originalTurnReply
} from './original-turn-evidence'
import type { SessionExecutionHost } from './session-execution-host-port'

export interface SessionExecutionHostOptions {
  dataRoot: string
  configRoot: string
  getClient(): Promise<PrismaClient>
  /** Flushes the existing original RuntimeSession owner; never creates or shuts down a runtime. */
  flush?(sessionId: string, promptMessageId: string): Promise<unknown>
}
const ref = (id: string, version: string, value: unknown): Ref => ({
  id,
  version,
  digest: originalEvidenceDigest(originalEvidenceCanonical(value))
})

/** Original-owner evidence adapter. Admission, cancellation, deadlines and scheduling belong to Core. */
export function createSessionExecutionHost(
  options: SessionExecutionHostOptions
): SessionExecutionHost {
  const generation = randomUUID()
  const projection = new SessionProjectionRepository(options.getClient)
  const sessions = new SessionRepository(options.dataRoot, {}, projection)
  const projects = new ProjectRepository(options.getClient, options.configRoot)
  const settings = new SettingsRepository(options.configRoot)
  const versions = new ManagedFileVersionService({
    storageRoot: options.dataRoot,
    getClient: options.getClient
  })
  const load = async (projectId: string, sessionId: string): Promise<PersistedChatSession> => {
    const loaded = await loadSessionMutationAuthority(sessions, projectId, sessionId)
    if (loaded.status !== 'found') throw new Error('Original Session is unavailable')
    if (loaded.session.packageOrigin)
      throw new Error('Imported Session has no local execution authority')
    return loaded.session
  }
  const reader = createOriginalTurnEvidenceReader({ dataRoot: options.dataRoot, load, versions })
  const reconcile = async (projectId: string, sessionId: string): Promise<void> => {
    await recoverExecutionJournals({
      directory: join(options.dataRoot, 'executions', 'session-attempts'),
      targetEnvironmentId: `session-environment:${sessionId}`,
      matches: (record) =>
        record.request.projectId === projectId && record.request.origin.sessionId === sessionId,
      readOriginal: async (record, { recoveredOwnerPid }) => {
        const promptId = record.identity.promptMessageId
        const token =
          record.identity.runtimeExecutionId ??
          record.identity.turnToken ??
          record.identity.promptExecutionId
        if (record.identity.sessionId !== sessionId || !promptId || !token)
          throw new Error(
            'Original execution recovery identity unavailable; Session remains fenced'
          )
        const frozen = await reader.scopeSnapshot(projectId, sessionId, promptId)
        const admission = frozen.session.runtimeSessionAdmissions
          ?.filter((entry) => entry.promptMessageId === promptId)
          .at(-1)
        if (!admission || admission.executionId !== token)
          throw new Error(
            'Original execution admission is unconfirmed or superseded; Session remains fenced'
          )
        const outcome = resolveTurnOutcome(frozen.session, promptId)
        const activeRun = frozen.session.activeRun
        const lastRun = frozen.session.runtimeTranscriptLastRun
        // The original explicit Resume command prepares its newer run before ACP dispatch,
        // but preserves recovery and the old last-run/admission witnesses until native admission.
        // It proves old lease release only for interruption; it never completes the old attempt.
        const preparedResume =
          outcome?.kind === 'interrupted' &&
          Boolean(recoveredOwnerPid) &&
          frozen.session.resumeRecovery?.promptMessageId === promptId &&
          lastRun?.promptMessageId === promptId &&
          activeRun?.promptMessageId === promptId &&
          activeRun.startedAt > lastRun.startedAt &&
          !frozen.session.promptPreparation
        const released =
          (activeRun?.promptMessageId !== promptId || preparedResume) &&
          frozen.session.promptPreparation?.promptMessageId !== promptId
        if (!outcome || !released || (outcome.kind === 'interrupted' && !recoveredOwnerPid))
          throw new Error(
            'Original terminal or released-resource witness unavailable; Session remains fenced'
          )
        const artifacts = await reader.artifacts(frozen)
        const witness = {
          outcome,
          admission,
          lastRun,
          ...(preparedResume
            ? { preparedResume: activeRun, recovery: frozen.session.resumeRecovery }
            : {}),
          released,
          ...(recoveredOwnerPid ? { deadOwnerPid: recoveredOwnerPid } : {})
        }
        return {
          phase: outcome.kind,
          cleanup: 'confirmed',
          evidence: {
            status: outcome.kind === 'interrupted' ? 'partial' : 'complete',
            scope:
              'Original durable Session exact-turn recovery witness and fixed ArtifactVersions; no provider replay',
            text: originalTurnReply(frozen),
            artifacts,
            references: [
              frozen.reference,
              ref(`session-recovery:${sessionId}:${promptId}`, token, witness)
            ],
            limitations: [`Original recovery witness: ${originalEvidenceCanonical(witness)}`]
          },
          ...(outcome.kind === 'failed' || outcome.kind === 'interrupted'
            ? {
                error: {
                  code: `original-turn-${outcome.kind}`,
                  message: outcome.error ?? 'Original turn was interrupted before completion.'
                }
              }
            : {})
        }
      }
    })
  }
  return {
    async prepare(input) {
      // Freeze before the first asynchronous read. The rich request is never rewritten for dispatch.
      const prompt = structuredClone(input.request)
      const attemptId = input.attemptId
      const operation = input.operation
      const reviewOwner = input.runtimeReviewOwner
      const target = structuredClone(input.target)
      if (!attemptId || !prompt.sessionId)
        throw new Error('Original dispatch attempt identity missing')
      const summary = (await projection.list()).find((entry) => entry.id === prompt.sessionId)
      if (!summary) throw new Error('Original Session ownership is unavailable')
      const session = await load(summary.projectId, prompt.sessionId)
      const project = await projects.get(session.projectId)
      if (!project || project.archivedAt) throw new Error('Original Project is unavailable')
      await reconcile(session.projectId, session.id)
      const stored = await settings.getSettings()
      // Explicit metadata allowlist: never serialize a provider document, credentials or media bytes.
      const configuration = {
        framework: session.agentFrameworkId ?? stored.agentFrameworkId,
        backend: session.agentBackendId,
        requested: session.agentConfiguration
          ? {
              providerId: session.agentConfiguration.providerId,
              model: session.agentConfiguration.model,
              reasoningEffort: session.agentConfiguration.reasoningEffort
            }
          : { providerId: stored.activeProviderId, model: stored.activeModel },
        target,
        permissionProfile: session.permissionProfile,
        memoryEnabled: prompt.memoryEnabled ?? session.memoryEnabled,
        autoReviewEnabled: session.autoReviewEnabled === true
      }
      const requestKey = `session:${generation}:${attemptId}`
      const request: ExecutionRequest = {
        contractVersion: 1,
        requestKey,
        projectId: session.projectId,
        // Media and all rich fields affect this fingerprint, but their bytes remain transient.
        taskSnapshotRef: ref(`session-prompt:${session.id}`, attemptId, prompt),
        invocationRef: ref(`session-invocation:${session.id}`, attemptId, {
          operation,
          reviewOwner,
          target
        }),
        agentSpecRef: ref(
          `session-agent:${session.id}`,
          String(session.revision ?? 0),
          configuration
        ),
        harnessRevisionRef: ref(
          `session-configuration:${session.id}`,
          String(session.revision ?? 0),
          configuration
        ),
        environmentSpecRef: ref(`session-environment:${session.id}`, attemptId, {
          projectId: session.projectId,
          cwd: session.cwd
        }),
        role: 'task',
        origin: {
          kind: reviewOwner === 'task' ? 'automation' : 'interactive',
          sessionId: session.id,
          ...(prompt.provenanceContext?.promptMessageId
            ? { promptMessageId: prompt.provenanceContext.promptMessageId }
            : {})
        },
        interactionPolicy: prompt.permissionPrompts === 'none' ? 'deny-unresolved' : 'interactive',
        budgetRef: requestKey,
        timeoutMs: 0
      }
      // Per-attempt original host is the sole writer; old journals are never reopened or replayed.
      const store = new FileExecutionStore(
        join(
          options.dataRoot,
          'executions',
          'session-attempts',
          generation,
          originalEvidenceDigest(attemptId).slice(7) + '.json'
        )
      )
      return {
        request,
        budgetLimit: 1,
        store,
        close: () => store.close(),
        async readResult(settlement) {
          const identity = structuredClone(settlement.identity)
          const promptId = identity.promptMessageId
          if (
            identity.sessionId !== session.id ||
            !promptId ||
            (prompt.provenanceContext?.promptMessageId &&
              promptId !== prompt.provenanceContext.promptMessageId)
          )
            throw new Error('Original admission identity does not match prepared Session turn')
          await options.flush?.(session.id, promptId)
          const frozen = await reader.scopeSnapshot(session.projectId, session.id, promptId)
          const outcome = resolveTurnOutcome(frozen.session, promptId)
          const released =
            frozen.session.activeRun?.promptMessageId !== promptId &&
            frozen.session.promptPreparation?.promptMessageId !== promptId
          const terminal = outcome && outcome.kind !== 'interrupted'
          const artifacts = await reader.artifacts(frozen)
          const complete = Boolean(terminal && released)
          return {
            phase:
              outcome?.kind === 'cancelled'
                ? 'cancelled'
                : outcome?.kind === 'completed' && !settlement.error && complete
                  ? 'completed'
                  : 'failed',
            cleanup: complete ? 'confirmed' : 'unknown',
            evidence: {
              status: complete ? 'complete' : 'partial',
              scope:
                'Original durable Session review-safe turn projection and fixed ArtifactVersion identities',
              text: originalTurnReply(frozen),
              artifacts,
              references: [frozen.reference],
              limitations: [
                'Rich input fingerprint includes transient media; media bytes are not retained as a reproducible snapshot.',
                'No semantic or deterministic assessment is implied by original turn completion.',
                ...(complete
                  ? []
                  : ['Original terminal commit or exact prompt lease release is unconfirmed.'])
              ]
            },
            configuration: {
              status: 'unknown',
              requestedDigest: request.harnessRevisionRef.digest,
              ...(configuration.framework ? { backend: configuration.framework } : {}),
              ...(configuration.requested.model ? { model: configuration.requested.model } : {}),
              instructions: [],
              skills: [],
              tools: [],
              confirmation:
                'Original requested Session configuration metadata only; runtime application unobserved.'
            },
            ...(!complete || outcome?.kind === 'failed' || settlement.error
              ? {
                  error: {
                    code: !complete ? 'original-terminal-unconfirmed' : 'original-turn-failed',
                    message:
                      outcome && 'error' in outcome && outcome.error
                        ? outcome.error
                        : 'Original turn did not complete successfully.'
                  }
                }
              : {})
          }
        }
      }
    }
  }
}
