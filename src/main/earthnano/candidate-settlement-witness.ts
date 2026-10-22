import { defaultSynchronousFileDurability } from '@aipoch/durable-files'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type {
  ExecutionIdentity,
  ExecutionRecord,
  ExecutionRequest,
  Ref
} from '../../shared/earthnano/execution-port'
import type { ExecutionOutcome } from './execution-core'
import { requestDigest, validateRecord } from './execution-contract'
import { canonicalOutput, outputDigest } from './output-checks'

export interface CandidateOwnerSettlement {
  request: ExecutionRequest
  executionId: string
  identity: ExecutionIdentity
  outcome: ExecutionOutcome
}
export interface CandidateSettlementWitness {
  schemaVersion: 1
  scope: 'original-candidate-session-resources-v1'
  executionId: string
  requestDigest: string
  identity: ExecutionIdentity
  outcome: ExecutionOutcome & { cleanup: 'confirmed' }
  digest: string
}
const filename = (workRoot: string, executionId: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(executionId))
    throw new Error('Invalid owner settlement execution identity')
  return join(workRoot, 'owner-settlements', `${executionId}.json`)
}
const validate = (witness: CandidateSettlementWitness, request: ExecutionRequest): void => {
  if (
    !witness ||
    typeof witness !== 'object' ||
    Array.isArray(witness) ||
    Object.keys(witness).sort().join(',') !==
      'digest,executionId,identity,outcome,requestDigest,schemaVersion,scope' ||
    witness.schemaVersion !== 1 ||
    witness.scope !== 'original-candidate-session-resources-v1' ||
    witness.requestDigest !== requestDigest(request) ||
    witness.outcome?.cleanup !== 'confirmed' ||
    !['completed', 'failed', 'cancelled'].includes(witness.outcome.phase)
  )
    throw new Error('Invalid original owner settlement witness')
  const { digest, ...payload } = witness
  if (digest !== outputDigest(payload)) throw new Error('Original owner settlement witness changed')
  const time = new Date(0).toISOString()
  validateRecord({
    executionId: witness.executionId,
    requestKey: request.requestKey,
    request,
    requestDigest: witness.requestDigest,
    identity: witness.identity,
    createdAt: time,
    updatedAt: time,
    cancellationRequested: false,
    evidence: {
      status: 'unavailable',
      scope: 'owner settlement validation',
      text: '',
      artifacts: [],
      references: [],
      limitations: []
    },
    usage: { status: 'unknown' },
    configuration: {
      status: 'unknown',
      requestedDigest: request.harnessRevisionRef.digest,
      instructions: [],
      skills: [],
      tools: [],
      confirmation: 'Original settlement validation'
    },
    ...witness.outcome
  })
  if (
    witness.outcome.configuration &&
    witness.outcome.configuration.requestedDigest !== request.harnessRevisionRef.digest
  )
    throw new Error('Owner settlement configuration identity changed')
}

/** Called by the driver only AFTER its original ACP + owned Notebook shutdown acknowledgments.
 * An immutable durable receipt closes that small crash window; it does not prove cold orphan cleanup. */
export async function persistCandidateOwnerSettlement(
  workRoot: string,
  input: CandidateOwnerSettlement
): Promise<void> {
  const payload = JSON.parse(
    JSON.stringify({
      schemaVersion: 1,
      scope: 'original-candidate-session-resources-v1',
      executionId: input.executionId,
      requestDigest: requestDigest(input.request),
      identity: input.identity,
      outcome: input.outcome
    })
  )
  const witness: CandidateSettlementWitness = { ...payload, digest: outputDigest(payload) }
  validate(witness, input.request)
  const target = filename(workRoot, input.executionId)
  const directory = join(workRoot, 'owner-settlements')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const boundary = lstatSync(directory)
  if (!boundary.isDirectory() || boundary.isSymbolicLink())
    throw new Error('Linked owner settlement boundary is unsupported')
  const encoded = canonicalOutput(witness)
  if (Buffer.byteLength(encoded) > 32 * 1024 * 1024)
    throw new Error('Original owner settlement exceeds its bounded profile')
  let handle: number
  let created = true
  try {
    handle = openSync(target, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const previous = readCandidateOwnerSettlement(workRoot, {
      executionId: input.executionId,
      request: input.request,
      requestDigest: witness.requestDigest,
      identity: input.identity
    })
    if (!previous || canonicalOutput(previous) !== encoded)
      throw new Error('Original owner settlement cannot be replaced')
    // As in the original durability owner, Windows file flushes need a write-capable handle.
    handle = openSync(target, 'r+')
    created = false
  }
  // Exclusive creation never replaces an earlier receipt. An interrupted partial write fails the
  // complete JSON/schema/digest checks and remains forensic evidence, never cleanup authority.
  try {
    if (created) writeFileSync(handle, encoded)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  defaultSynchronousFileDurability.syncDirectory(directory)
}

export function readCandidateOwnerSettlement(
  workRoot: string,
  record: Pick<ExecutionRecord, 'executionId' | 'request' | 'requestDigest' | 'identity'>
): CandidateSettlementWitness | undefined {
  const target = filename(workRoot, record.executionId)
  let bytes: string
  try {
    const boundary = lstatSync(join(workRoot, 'owner-settlements'))
    if (!boundary.isDirectory() || boundary.isSymbolicLink())
      throw new Error('Linked owner settlement boundary is unsupported')
    const stat = lstatSync(target)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
      throw new Error('Invalid original owner settlement file')
    bytes = readFileSync(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const witness = JSON.parse(bytes) as CandidateSettlementWitness
  validate(witness, record.request)
  if (
    witness.executionId !== record.executionId ||
    witness.requestDigest !== record.requestDigest ||
    canonicalOutput(witness.identity) !== canonicalOutput(record.identity)
  )
    throw new Error('Original owner settlement scope mismatch')
  return witness
}
export const candidateSettlementReference = (witness: CandidateSettlementWitness): Ref => ({
  id: `candidate-owner-settlement:${witness.executionId}`,
  version: '1',
  digest: witness.digest
})

/** Known late completed work cannot be silently paid for again merely because failed history is
 * conservatively retained. Adopting such a result requires a separate original-owner product path. */
export function assertNoUnadoptedCandidateCompletion(
  workRoot: string,
  records: ExecutionRecord[]
): void {
  for (const record of records) {
    if (record.phase === 'completed') continue
    const witness = readCandidateOwnerSettlement(workRoot, record)
    if (witness?.outcome.phase === 'completed')
      throw new Error('Original completed owner result is not adopted; paid replay refused')
  }
}
