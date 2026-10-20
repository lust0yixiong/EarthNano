import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fixtures from '../../../contracts/execution/fixtures.json'
import type { ExecutionRecord, ExecutionRequest } from '../../shared/earthnano/execution-port'
import { requestDigest } from './execution-contract'
import { emptyExecutionState } from './execution-core'
import { FileExecutionStore, recoverExecutionJournals } from './execution-store'
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'execution-store-recovery-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
it('recovers only a provably dead PID lock and preserves the charged durable state', () => {
  const filename = join(root, 'attempt.json')
  const old = new FileExecutionStore(filename)
  const state = old.load()
  state.budgets.charge = { limit: 1, admitted: 1 }
  old.commit(state)
  writeFileSync(filename + '.lock', '2147483647')
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('dead'), { code: 'ESRCH' })
  })
  const recovered = FileExecutionStore.recoverStale(filename)
  expect(kill).toHaveBeenCalledWith(2147483647, 0)
  expect(recovered.load().budgets.charge).toEqual({ limit: 1, admitted: 1 })
  expect(readFileSync(filename + '.lock', 'utf8')).toBe(String(process.pid))
  recovered.close()
})
it.each(['live', 'permission', 'malformed'] as const)(
  'never steals a %s owner lock',
  (scenario) => {
    const filename = join(root, 'attempt.json')
    const owner = new FileExecutionStore(filename)
    const contents = scenario === 'malformed' ? 'not-a-pid' : String(process.pid)
    writeFileSync(filename + '.lock', contents)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (scenario === 'permission')
        throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
      return true
    })
    expect(() => FileExecutionStore.recoverStale(filename)).toThrow()
    expect(readFileSync(filename + '.lock', 'utf8')).toBe(contents)
    owner.close()
  }
)
it('keeps a cooperating recovery claimant exclusive', () => {
  const filename = join(root, 'attempt.json')
  const owner = new FileExecutionStore(filename)
  writeFileSync(filename + '.lock.recovery', 'existing recovery')
  expect(() => FileExecutionStore.recoverStale(filename)).toThrow()
  expect(readFileSync(filename + '.lock', 'utf8')).toBe(String(process.pid))
  owner.close()
})

const priorJournal = (): string => {
  const filename = join(root, 'nested', 'attempt.json')
  const store = new FileExecutionStore(filename)
  const request = structuredClone(fixtures.valid) as ExecutionRequest
  const time = new Date().toISOString()
  const record: ExecutionRecord = {
    executionId: 'old',
    requestKey: request.requestKey,
    request,
    requestDigest: requestDigest(request),
    phase: 'running',
    cleanup: 'pending',
    identity: { sessionId: 'original-session', promptMessageId: 'prompt' },
    createdAt: time,
    updatedAt: time,
    cancellationRequested: false,
    evidence: {
      status: 'unavailable',
      scope: 'original',
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
      confirmation: 'unknown'
    }
  }
  const state = emptyExecutionState()
  state.records.old = record
  state.events.old = [{ executionId: 'old', sequence: 1, type: 'phase', phase: 'running', time }]
  state.sequences.old = 1
  state.budgets[JSON.stringify([request.projectId, request.budgetRef])] = { limit: 1, admitted: 1 }
  store.commit(state)
  store.close()
  writeFileSync(filename + '.lock', '2147483647')
  return filename
}
it('recovers nested journals through Core, retains unknown fence, never refunds or replays', async () => {
  const filename = priorJournal()
  await expect(recoverExecutionJournals({ directory: root, matches: () => true })).rejects.toThrow(
    'fenced'
  )
  const state = JSON.parse(readFileSync(filename, 'utf8'))
  expect(state.records.old).toMatchObject({
    phase: 'interrupted',
    cleanup: 'unknown',
    error: { code: 'process_restarted' }
  })
  expect(Object.values(state.budgets)).toEqual([{ limit: 1, admitted: 1 }])
  expect(state.events.old.map((event: { type: string }) => event.type)).toEqual(['phase', 'phase'])
  expect(readFileSync(filename + '.lock', 'utf8')).toBe(String(process.pid))
  await expect(
    recoverExecutionJournals({
      directory: root,
      matches: () => true,
      readOriginal: async () => ({ phase: 'completed', cleanup: 'confirmed' })
    })
  ).rejects.toThrow('live owner')
})
it('only original owner witnesses reconcile the selected resource, leaving other resources untouched', async () => {
  const filename = priorJournal()
  const readOriginal = vi.fn(async () => ({
    phase: 'completed' as const,
    cleanup: 'confirmed' as const
  }))
  await recoverExecutionJournals({ directory: root, matches: () => false, readOriginal })
  expect(readOriginal).not.toHaveBeenCalled()
  expect(JSON.parse(readFileSync(filename, 'utf8')).records.old.phase).toBe('running')
  await recoverExecutionJournals({
    directory: root,
    matches: (record) => record.identity.sessionId === 'original-session',
    readOriginal
  })
  expect(readOriginal).toHaveBeenCalledWith(
    expect.objectContaining({ phase: 'interrupted', cleanup: 'unknown' }),
    expect.objectContaining({ recoveredOwnerPid: 2147483647 })
  )
  const state = JSON.parse(readFileSync(filename, 'utf8'))
  expect(state.records.old).toMatchObject({ phase: 'completed', cleanup: 'confirmed' })
  expect(Object.values(state.budgets)).toEqual([{ limit: 1, admitted: 1 }])
})
it('keeps unknown old resources fenced while allowing a distinct environment identity', async () => {
  const filename = priorJournal()
  await recoverExecutionJournals({
    directory: root,
    targetEnvironmentId: 'fresh-isolated-environment',
    matches: () => true
  })
  const state = JSON.parse(readFileSync(filename, 'utf8'))
  expect(state.records.old).toMatchObject({ phase: 'interrupted', cleanup: 'unknown' })
  expect(readFileSync(filename + '.lock', 'utf8')).toBe(String(process.pid))
  await recoverExecutionJournals({
    directory: root,
    targetEnvironmentId: 'fresh-isolated-environment',
    matches: () => true
  })
  await expect(
    recoverExecutionJournals({
      directory: root,
      targetEnvironmentId: state.records.old.request.environmentSpecRef.id,
      matches: () => true
    })
  ).rejects.toThrow('live owner')
})
