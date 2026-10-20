import { createHash } from 'node:crypto'
import type { ArtifactReference, ExecutionRecord, Ref } from '../../shared/earthnano/execution-port'
import type { ReviewScopeSnapshotBlock, TurnScope } from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ManagedFileVersionService } from '../managed-file-versions/service'
import { resolveTurnScopeWithArtifactDigests } from '../reviewer/artifact-digest'
import { buildReviewScopeSnapshot } from '../reviewer/scope-snapshot'

export interface OriginalTurnEvidence {
  session: PersistedChatSession
  scope: TurnScope
  blocks: ReviewScopeSnapshotBlock[]
  reference: Ref
}
export const originalEvidenceCanonical = (value: unknown): string => {
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
export const originalEvidenceDigest = (value: string | Uint8Array): string =>
  'sha256:' + createHash('sha256').update(value).digest('hex')
export const originalTurnReply = (turn: OriginalTurnEvidence): string =>
  turn.blocks
    .filter((block) => block.kind === 'message' && block.payload.role === 'agent')
    .map((block) => String(block.payload.content ?? ''))
    .join('\n')

/** Reads original owners only. Binary ArtifactVersions are verified without decoding or loading them whole. */
export function createOriginalTurnEvidenceReader(options: {
  dataRoot: string
  load(projectId: string, sessionId: string): Promise<PersistedChatSession>
  versions: Pick<ManagedFileVersionService, 'openVersion'>
}): {
  scopeSnapshot(
    projectId: string,
    sessionId: string,
    promptId: string
  ): Promise<OriginalTurnEvidence>
  pinnedTurn(record: ExecutionRecord): Promise<OriginalTurnEvidence>
  artifacts(turn: OriginalTurnEvidence): Promise<ArtifactReference[]>
} {
  const scopeSnapshot = async (
    projectId: string,
    sessionId: string,
    promptId: string
  ): Promise<OriginalTurnEvidence> => {
    const session = await options.load(projectId, sessionId)
    if (session.id !== sessionId || session.projectId !== projectId)
      throw new Error('Durable Session identity mismatch')
    const scope = await resolveTurnScopeWithArtifactDigests(
      session,
      promptId,
      options.dataRoot,
      async (request) => {
        if (!request.fileId) throw new Error('Artifact logical identity missing')
        const lease = await options.versions.openVersion(
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
        digest: originalEvidenceDigest(originalEvidenceCanonical({ scope, blocks }))
      }
    }
  }
  const artifacts = async (turn: OriginalTurnEvidence): Promise<ArtifactReference[]> => {
    const result: ArtifactReference[] = []
    for (const id of turn.scope.artifactVersionIds) {
      const file = turn.session.artifacts?.find((entry) => entry.versionId === id)
      if (!file?.artifactId || !file.versionId)
        throw new Error('Finalized Artifact version identity unavailable')
      const lease = await options.versions.openVersion(
        { source: 'artifact', projectId: turn.session.projectId, fileId: file.artifactId },
        id
      )
      try {
        await lease.verifyUnchanged()
        result.push({
          artifactId: file.artifactId,
          versionId: id,
          checksum: lease.version.checksum
        })
      } finally {
        await lease.close()
      }
    }
    return result
  }
  const pinnedTurn = async (record: ExecutionRecord): Promise<OriginalTurnEvidence> => {
    const { sessionId, promptMessageId } = record.identity
    if (!sessionId || !promptMessageId) throw new Error('Execution has no durable turn identity')
    const result = await scopeSnapshot(record.request.projectId, sessionId, promptMessageId)
    if (
      !record.evidence.references.some(
        (ref) => originalEvidenceCanonical(ref) === originalEvidenceCanonical(result.reference)
      )
    )
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
    if (
      originalEvidenceCanonical(await artifacts(result)) !==
      originalEvidenceCanonical(record.evidence.artifacts)
    )
      throw new Error('Execution Artifact checksums differ from pinned versions')
    return result
  }
  return { scopeSnapshot, pinnedTurn, artifacts }
}
