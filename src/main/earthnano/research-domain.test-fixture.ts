import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, vi } from 'vitest'
import type {
  ExecutionRecord,
  ExecutionRequest,
  ExecutionRole
} from '../../shared/earthnano/execution-port'
import { createCandidateSnapshotStore, type CandidateSnapshotInput } from './candidate-snapshot'
import { requestDigest, validateRecord, validateRequest } from './execution-contract'
import { outputDigest } from './output-checks'
import type {
  PersistentCandidateOwners,
  PersistentCandidateResult
} from './persistent-candidate-owner'

export const input: CandidateSnapshotInput = {
  task: {
    prompt: 'Reconcile the rows into result.json.',
    files: [{ path: 'rows.txt', content: '2\n4\n' }]
  },
  harness: {
    instructions: 'Read every source row and verify the sum.',
    skills: [],
    tools: 'workspace-only'
  },
  agent: {
    backend: 'claude-code',
    model: 'fixture-model',
    providerRef: 'fixture-provider',
    runtimeVersion: 'fixture'
  },
  environment: { isolation: 'directory-process', network: 'provider-only' }
}
export const reflectionText =
  '<experience>\ncue: Row reconciliation\nlesson: Verify all source rows\nevidence: The adopted output reconciles all rows\nconfidence: provisional\n</experience>'

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'earthnano-domain-adversarial-'))
  const snapshots = await createCandidateSnapshotStore({
    root: join(root, 'snapshots'),
    candidatesRoot: join(root, 'candidates')
  })
  onTestFinished(async () => {
    const unlock = async (path: string): Promise<void> => {
      const stat = await lstat(path)
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await chmod(path, 0o700)
        for (const name of await readdir(path)) await unlock(join(path, name))
      }
    }
    await unlock(root)
    await rm(root, { recursive: true, force: true })
  })
  const outputs = new Map<string, PersistentCandidateResult>()
  const exportResult = vi.fn(async (record: ExecutionRecord) => {
    const output = outputs.get(record.executionId)
    if (!output) throw new Error('Unowned immutable output')
    return structuredClone(output)
  })
  const commitDeterministicReview = vi.fn(async () => ({
    reviewId: 'deterministic-review',
    outcome: 'pass' as 'pass' | 'flagged'
  }))
  const owners = { exportResult, commitDeterministicReview } as unknown as PersistentCandidateOwners
  async function record(
    role: ExecutionRole,
    id: string,
    options: { harness?: string; content?: string; reply?: string } = {}
  ): Promise<ExecutionRecord> {
    const refs = await snapshots.freeze({
      ...input,
      harness: { ...input.harness, instructions: options.harness ?? input.harness.instructions }
    })
    const invocationRef = await snapshots.freezeInvocation({
      taskSnapshotRef: refs.taskSnapshotRef,
      harnessRevisionRef: refs.harnessRevisionRef,
      mission: `Role ${role}; ${id}`
    })
    const request: ExecutionRequest = {
      contractVersion: 1,
      requestKey: randomUUID(),
      projectId: 'project',
      ...refs,
      invocationRef,
      role,
      interactionPolicy: 'deny-unresolved',
      origin: { kind: 'optimization', optimizationId: 'experiment', stageId: id },
      budgetRef: 'budget',
      timeoutMs: 1000
    }
    validateRequest(request)
    const content = options.content ?? (role === 'reflection' ? reflectionText : '{"sum":6}')
    const artifactRef = {
      artifactId: `artifact-${id}`,
      versionId: `version-${id}`,
      checksum: outputDigest(content)
    }
    const digest = 'sha256:' + createHash('sha256').update(content).digest('hex')
    const result: ExecutionRecord = {
      executionId: id,
      requestKey: request.requestKey,
      request,
      requestDigest: requestDigest(request),
      phase: 'completed',
      identity: { sessionId: `session-${id}` },
      createdAt: '2026-10-20T00:00:00Z',
      updatedAt: '2026-10-20T00:00:00Z',
      cleanup: 'confirmed',
      cancellationRequested: false,
      evidence: {
        status: 'complete',
        scope: 'immutable fixture output',
        text: options.reply ?? (role === 'reflection' ? reflectionText : 'Completed'),
        artifacts: [artifactRef],
        references: [],
        limitations: []
      },
      usage: { status: 'unknown' },
      configuration: {
        status: 'unknown',
        requestedDigest: refs.harnessRevisionRef.digest,
        instructions: [],
        skills: [],
        tools: [],
        confirmation: 'Fixture only'
      }
    }
    validateRecord(result)
    outputs.set(id, {
      executionId: id,
      artifacts: [artifactRef],
      replyText: result.evidence.text,
      trajectoryText: 'Private execution trajectory',
      files: [
        {
          path: role === 'reflection' ? 'reflection-reply.md' : 'result.json',
          content,
          digest,
          artifactRef
        }
      ]
    })
    return result
  }
  return { root, snapshots, record, owners, outputs, exportResult, commitDeterministicReview }
}
