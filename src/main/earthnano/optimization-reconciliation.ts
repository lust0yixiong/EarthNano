import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { ExecutionRecord } from '../../shared/earthnano/execution-port'
import type { ExecutionState } from './execution-core'
import { requestDigest, validateRecord } from './execution-contract'
import { recoverExecutionJournals } from './execution-store'
import {
  readPersistentOptimizationResume,
  type OptimizationResumeIdentity
} from './optimization-resume'
import {
  candidateSettlementReference,
  readCandidateOwnerSettlement
} from './candidate-settlement-witness'

export interface OptimizationReconciliationResult {
  status: 'settled' | 'fenced'
  /** Resource settlement and result adoption are distinct. Historical failures are never promoted. */
  resumeAllowed: boolean
  records: Array<Pick<ExecutionRecord, 'executionId' | 'phase' | 'cleanup'>>
  reasons: Array<
    | 'owner-witness-unavailable'
    | 'owner-witness-invalid'
    | 'owner-lock-unverified'
    | 'historical-result-not-adopted'
  >
}

/** Host-only explicit audit. Caller owns the original data-root lifetime lease and reauthorizes the
 * source scope. No provider/runtime is constructed, and no Task/Notebook work is submitted. */
export async function reconcilePersistentOptimization(options: {
  workRoot: string
  projectId: string
  sourceSessionId?: string
  authorize(identity: OptimizationResumeIdentity): Promise<void>
  signal?: AbortSignal
}): Promise<OptimizationReconciliationResult> {
  if (!isAbsolute(options.workRoot))
    throw new Error('Optimization reconciliation root must be absolute')
  options.signal?.throwIfAborted()
  const manifest = readPersistentOptimizationResume(options.workRoot)
  if (
    manifest.identity.projectId !== options.projectId ||
    manifest.identity.sourceSessionId !== options.sourceSessionId
  )
    throw new Error('Optimization reconciliation scope mismatch')
  await options.authorize(structuredClone(manifest.identity))
  options.signal?.throwIfAborted()
  const filename = join(options.workRoot, 'execution.json')
  const load = (): ExecutionRecord[] => {
    const state = JSON.parse(readFileSync(filename, 'utf8')) as ExecutionState
    if (
      !state.records ||
      Array.isArray(state.records) ||
      !state.budgets ||
      state.budgets[JSON.stringify([options.projectId, manifest.optimizationId])]?.limit !==
        manifest.identity.executionLimit
    )
      throw new Error('Original optimization journal identity unavailable')
    const records = Object.values(state.records)
    for (const record of records) {
      validateRecord(record)
      if (
        record.requestDigest !== requestDigest(record.request) ||
        record.request.projectId !== options.projectId ||
        record.request.origin.optimizationId !== manifest.optimizationId ||
        record.request.budgetRef !== manifest.optimizationId
      )
        throw new Error('Original optimization journal identity changed')
    }
    return records
  }
  const records = load()
  const result = (
    status: OptimizationReconciliationResult['status'],
    reasons: OptimizationReconciliationResult['reasons'],
    current = records
  ): OptimizationReconciliationResult => ({
    status,
    resumeAllowed:
      status === 'settled' &&
      !reasons.includes('historical-result-not-adopted') &&
      current.every((record) => ['completed', 'failed', 'cancelled'].includes(record.phase)),
    records: current.map(({ executionId, phase, cleanup }) => ({ executionId, phase, cleanup })),
    reasons
  })
  // Validate every required receipt BEFORE attempting original single-writer recovery. An absent
  // receipt does not even replace a stale lock, let alone confirm any physical resource release.
  const unresolved = records.filter(
    (record) =>
      record.cleanup !== 'confirmed' ||
      !['completed', 'failed', 'cancelled', 'interrupted'].includes(record.phase)
  )
  try {
    for (const record of records) {
      options.signal?.throwIfAborted()
      const witness = readCandidateOwnerSettlement(options.workRoot, record)
      if (unresolved.includes(record) && !witness)
        return result('fenced', ['owner-witness-unavailable'])
    }
  } catch {
    options.signal?.throwIfAborted()
    return result('fenced', ['owner-witness-invalid'])
  }
  try {
    await recoverExecutionJournals({
      directory: options.workRoot,
      filename,
      releaseSettledLock: true,
      matches: () => true,
      readOriginal: async (record) => {
        options.signal?.throwIfAborted()
        const witness = readCandidateOwnerSettlement(options.workRoot, record)
        if (!witness) return undefined
        const reference = candidateSettlementReference(witness)
        return {
          // Only release resources. Preserve Core's original interrupted/failed/cancelled outcome,
          // error, usage, effective configuration and immutable output evidence without promotion.
          phase: record.phase as 'completed' | 'failed' | 'cancelled' | 'interrupted',
          cleanup: 'confirmed',
          evidence: {
            ...record.evidence,
            references: [
              ...record.evidence.references.filter((entry) => entry.id !== reference.id),
              reference
            ],
            limitations: [
              ...record.evidence.limitations,
              'Exact original candidate owner durably confirmed ACP and owned Notebook retirement; historical terminal result is not promoted.'
            ]
          },
          usage: record.usage,
          configuration: record.configuration,
          ...(record.error ? { error: record.error } : {})
        }
      }
    })
  } catch {
    options.signal?.throwIfAborted()
    return result('fenced', ['owner-lock-unverified'], load())
  }
  const current = load()
  if (existsSync(`${filename}.lock`) || current.some((record) => record.cleanup !== 'confirmed'))
    return result('fenced', ['owner-lock-unverified'], current)
  const notAdopted = current.some(
    (record) =>
      record.phase === 'interrupted' ||
      (record.phase !== 'completed' &&
        readCandidateOwnerSettlement(options.workRoot, record)?.outcome.phase === 'completed')
  )
  return result('settled', notAdopted ? ['historical-result-not-adopted'] : [], current)
}
