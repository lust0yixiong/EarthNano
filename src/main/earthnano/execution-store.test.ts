import {
  createSynchronousFileDurability,
  defaultSynchronousFileDurability
} from '@aipoch/durable-files'
import {
  closeSync,
  fsyncSync,
  openSync,
  fstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fixtures from '../../../contracts/execution/fixtures.json'
import type { ExecutionRecord, ExecutionRequest } from '../../shared/earthnano/execution-port'
import { requestDigest } from './execution-contract'
import { emptyExecutionState } from './execution-core'
import { FileExecutionStore, recoverExecutionJournals } from './execution-store'
const fsyncControl = vi.hoisted(() => ({
  failure: undefined as Error | undefined,
  target: 'directory' as 'file' | 'directory',
  attempts: [] as Array<{ fd: number; directory: boolean }>
}))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return {
    ...actual,
    fsyncSync: (fd: number): void => {
      const directory = actual.fstatSync(fd).isDirectory()
      fsyncControl.attempts.push({ fd, directory })
      if (fsyncControl.failure && directory === (fsyncControl.target === 'directory'))
        throw fsyncControl.failure
      actual.fsyncSync(fd)
    }
  }
})
beforeEach(() => {
  vi.spyOn(defaultSynchronousFileDurability, 'syncDirectory').mockImplementation((path) => {
    createSynchronousFileDurability({
      platform: process.platform,
      openHandle: (directory, flags) => {
        const fd = openSync(directory, flags)
        return { sync: () => fsyncSync(fd), close: () => closeSync(fd) }
      }
    }).syncDirectory(path)
  })
})

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'execution-store-recovery-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  fsyncControl.failure = undefined
  fsyncControl.attempts.length = 0
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
  await recoverExecutionJournals({
    directory: root,
    matches: () => true,
    readOriginal: async () => ({ phase: 'completed', cleanup: 'confirmed' })
  })
  expect(JSON.parse(readFileSync(filename, 'utf8')).records.old).toMatchObject({
    phase: 'completed',
    cleanup: 'confirmed'
  })
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
  ).rejects.toThrow('fenced')
})
it('serializes concurrent recovery observers without duplicate reconciliation or charge changes', async () => {
  const filename = priorJournal()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const firstWitness = vi.fn(async () => {
    await gate
    return { phase: 'completed' as const, cleanup: 'confirmed' as const }
  })
  const secondWitness = vi.fn(async () => ({
    phase: 'completed' as const,
    cleanup: 'confirmed' as const
  }))
  const first = recoverExecutionJournals({
    directory: root,
    matches: () => true,
    readOriginal: firstWitness
  })
  await vi.waitFor(() => expect(firstWitness).toHaveBeenCalledOnce())
  const second = recoverExecutionJournals({
    directory: root,
    matches: () => true,
    readOriginal: secondWitness
  })
  release()
  await Promise.all([first, second])
  expect(secondWitness).not.toHaveBeenCalled()
  expect(Object.values(JSON.parse(readFileSync(filename, 'utf8')).budgets)).toEqual([
    { limit: 1, admitted: 1 }
  ])
})

it.each(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'])(
  'publishes the flushed execution journal when Windows directory sync returns %s',
  (code) => {
    const store = new FileExecutionStore(join(root, 'windows-journal.json'))
    const state = emptyExecutionState()
    state.budgets.charged = { limit: 1, admitted: 1 }
    fsyncControl.failure = Object.assign(new Error(code), { code })
    fsyncControl.target = 'directory'
    fsyncControl.attempts.length = 0
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    try {
      expect(() => store.commit(state)).not.toThrow()
      expect(store.load().budgets.charged).toEqual({ limit: 1, admitted: 1 })
      expect(fsyncControl.attempts.map(({ directory }) => directory)).toEqual([false, true])
      expect(() => fstatSync(fsyncControl.attempts[1].fd)).toThrow()
    } finally {
      store.close()
    }
  }
)
it.each(['linux', 'darwin'])('propagates unsupported directory sync failures on %s', (platform) => {
  const store = new FileExecutionStore(join(root, 'posix-journal.json'))
  const failure = Object.assign(new Error('directory fsync failure'), { code: 'EPERM' })
  fsyncControl.failure = failure
  fsyncControl.target = 'directory'
  vi.stubGlobal('process', { ...process, platform })
  try {
    expect(() => store.commit(emptyExecutionState())).toThrow(failure)
  } finally {
    store.close()
  }
})
it('propagates unexpected Windows directory durability failures', () => {
  const store = new FileExecutionStore(join(root, 'disk-error.json'))
  const failure = Object.assign(new Error('directory I/O failure'), { code: 'EIO' })
  fsyncControl.failure = failure
  fsyncControl.target = 'directory'
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  try {
    expect(() => store.commit(emptyExecutionState())).toThrow(failure)
  } finally {
    store.close()
  }
})
it('never suppresses a Windows file flush failure or publishes the unflushed state', () => {
  const filename = join(root, 'file-error.json')
  const store = new FileExecutionStore(filename)
  const previous = emptyExecutionState()
  previous.budgets.existing = { limit: 1, admitted: 1 }
  store.commit(previous)
  const failure = Object.assign(new Error('file fsync failure'), { code: 'EPERM' })
  fsyncControl.failure = failure
  fsyncControl.target = 'file'
  fsyncControl.attempts.length = 0
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  try {
    expect(() => store.commit(emptyExecutionState())).toThrow(failure)
    expect(store.load()).toEqual(previous)
    expect(fsyncControl.attempts.map(({ directory }) => directory)).toEqual([false])
  } finally {
    store.close()
  }
})
