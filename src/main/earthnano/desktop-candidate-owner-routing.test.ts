import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import fixtures from '../../../contracts/execution/fixtures.json'
import type { ExecutionRequest } from '../../shared/earthnano/execution-port'
import { ExecutionCore, type ExecutionState } from './execution-core'
import { FileExecutionStore } from './execution-store'
import { outputDigest } from './output-checks'
import { writeResumeJson, type OptimizationResumeIdentity } from './optimization-resume'
import {
  createDesktopCandidateOwnerRouting,
  readDesktopPrivateSessions,
  type CandidateOwnerPorts
} from './desktop-candidate-owner-routing'
const host = vi.hoisted(() => ({
  configRoot: '',
  dataRoot: '',
  release: vi.fn(),
  acquire: vi.fn(),
  readRoot: vi.fn()
}))
vi.mock('../storage-root', () => ({
  resolveConfigRoot: () => host.configRoot,
  resolveDataRoot: () => {
    host.readRoot()
    return host.dataRoot
  }
}))
vi.mock('../storage/migration-state', () => ({
  acquireDataRootWriter: () => {
    host.acquire()
    return host.release
  }
}))
const roots: string[] = []
afterEach(() => {
  vi.resetAllMocks()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
const runId = 'f1234567-1234-1234-1234-123456789abc'
const binding = {
  projectId: 'demo',
  sessionId: 'private',
  agentFrameId: 'frame',
  executionCwd: '/host'
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- preserve concrete fixture types
const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'earthnano-cold-routing-'))
  roots.push(root)
  const configRoot = join(root, 'config'),
    dataRoot = join(root, 'data')
  const configRun = join(configRoot, 'earthnano-desktop', runId)
  const workRoot = join(dataRoot, 'earthnano', 'desktop-runs', runId, 'execution')
  mkdirSync(configRun, { recursive: true })
  mkdirSync(workRoot, { recursive: true })
  const filename = join(workRoot, 'execution.json')
  const store = new FileExecutionStore(filename)
  const core = new ExecutionCore(store, {
    execute: async (_request, context) => {
      context.identity({
        sessionId: 'private',
        promptMessageId: `candidate-prompt-${context.executionId}`
      })
      context.running()
      return new Promise<never>(() => undefined)
    }
  })
  core.configureBudget('demo', 'trial', 10)
  const request: ExecutionRequest = {
    ...(structuredClone(fixtures.valid) as ExecutionRequest),
    role: 'baseline',
    origin: { kind: 'optimization', optimizationId: 'trial', stageId: 'base1' },
    interactionPolicy: 'deny-unresolved'
  }
  const handle = await core.submit(request)
  await vi.waitFor(() => expect(readFileSync(filename, 'utf8')).toContain('candidate-prompt-'))
  const record = await core.get(handle.executionId)
  core.dispose()
  const identity = {
    projectId: 'demo',
    sourceSessionId: 'source',
    taskId: runId,
    executionLimit: 10
  } as OptimizationResumeIdentity
  writeResumeJson(join(workRoot, 'resume.json'), {
    schemaVersion: 1,
    optimizationId: 'trial',
    identity,
    identityDigest: outputDigest(identity),
    methodDigest: `sha256:${'a'.repeat(64)}`
  })
  const desktop = {
    executionStarted: true,
    requestKey: 'once',
    digest: 'original',
    progress: {
      runId,
      projectId: 'demo',
      sourceSessionId: 'source',
      state: 'interrupted',
      executions: [{ executionId: record.executionId, sessionId: 'private' }],
      budget: { limit: 10, admitted: 1, completed: 0, active: 0 }
    }
  }
  writeFileSync(join(configRun, 'desktop.json'), JSON.stringify(desktop))
  return {
    root,
    configRoot,
    dataRoot,
    workRoot,
    filename,
    configRun,
    desktop,
    record,
    load: (): ExecutionState => JSON.parse(readFileSync(filename, 'utf8')),
    write: (state: ExecutionState): void => writeFileSync(filename, JSON.stringify(state))
  }
}
it.each(['completed', 'interrupted'] as const)(
  'fences a cold %s original Core Session without acquiring or changing its writer lock',
  async (phase) => {
    const f = await setup()
    const state = f.load()
    state.records[f.record.executionId].phase = phase
    if (phase === 'completed') state.records[f.record.executionId].cleanup = 'confirmed'
    f.write(state)
    const lock = readFileSync(f.filename + '.lock', 'utf8')
    const before = readFileSync(f.filename, 'utf8')
    const router = createDesktopCandidateOwnerRouting(async () => readDesktopPrivateSessions(f))
    expect(await router.resolveCandidateDelivery('private')).toEqual({
      kind: 'private-unavailable'
    })
    await expect(router.resolveControlPolicy(binding)).rejects.toThrow('unavailable')
    expect(await router.resolveCandidateDelivery('ordinary')).toEqual({ kind: 'ordinary' })
    expect(readFileSync(f.filename, 'utf8')).toBe(before)
    expect(readFileSync(f.filename + '.lock', 'utf8')).toBe(lock)
  }
)
it('discovers original data journals even when their desktop projection is absent', async () => {
  const f = await setup()
  rmSync(f.configRun, { recursive: true })
  expect([...readDesktopPrivateSessions(f)]).toEqual(['private'])
})
it.each([
  'execution',
  'manifest',
  'digest',
  'identity',
  'projection',
  'unknown-boundary',
  'link'
] as const)('never converts %s journal failure into ordinary authority', async (fault) => {
  const f = await setup()
  if (fault === 'execution') rmSync(f.filename)
  if (fault === 'manifest') writeFileSync(join(f.workRoot, 'resume.json'), '{')
  if (fault === 'digest') {
    const s = f.load()
    s.records[f.record.executionId].requestDigest = `sha256:${'f'.repeat(64)}`
    f.write(s)
  }
  if (fault === 'identity') {
    const s = f.load()
    s.records[f.record.executionId].identity.promptMessageId = 'foreign'
    f.write(s)
  }
  if (fault === 'projection') {
    f.desktop.progress.executions[0].sessionId = 'missing'
    writeFileSync(join(f.configRun, 'desktop.json'), JSON.stringify(f.desktop))
  }
  if (fault === 'unknown-boundary') {
    rmSync(join(f.dataRoot, 'earthnano'), { recursive: true })
    delete (f.desktop as Partial<typeof f.desktop>).executionStarted
    writeFileSync(join(f.configRun, 'desktop.json'), JSON.stringify(f.desktop))
  }
  if (fault === 'link') {
    rmSync(f.filename)
    symlinkSync(join(f.workRoot, 'resume.json'), f.filename)
  }
  const router = createDesktopCandidateOwnerRouting(async () => readDesktopPrivateSessions(f))
  expect(await router.resolveCandidateDelivery('ordinary')).toEqual({ kind: 'private-unavailable' })
  await expect(router.resolveControlPolicy({ ...binding, sessionId: 'ordinary' })).rejects.toThrow()
})
it('accepts only an explicit original pre-execution boundary with no data directory, IDs or admission', async () => {
  const f = await setup()
  rmSync(join(f.dataRoot, 'earthnano'), { recursive: true })
  f.desktop.executionStarted = false
  f.desktop.progress.executions = []
  f.desktop.progress.budget.admitted = 0
  writeFileSync(join(f.configRun, 'desktop.json'), JSON.stringify(f.desktop))
  expect([...readDesktopPrivateSessions(f)]).toEqual([])
  mkdirSync(f.workRoot, { recursive: true })
  expect(() => readDesktopPrivateSessions(f)).toThrow('unavailable')
})
it('rejects conflicting pre-execution IDs and non-boolean boundary metadata', async () => {
  const f = await setup()
  rmSync(join(f.dataRoot, 'earthnano'), { recursive: true })
  for (const executionStarted of [false, 'false']) {
    writeFileSync(
      join(f.configRun, 'desktop.json'),
      JSON.stringify({ ...f.desktop, executionStarted })
    )
    expect(() => readDesktopPrivateSessions(f)).toThrow('unavailable')
  }
})
it('reads the current root under its original lease on each query and fences migration failure', async () => {
  const f = await setup()
  host.configRoot = f.configRoot
  host.dataRoot = f.dataRoot
  const router = createDesktopCandidateOwnerRouting()
  expect(await router.resolveCandidateDelivery('private')).toEqual({ kind: 'private-unavailable' })
  expect(host.acquire).toHaveBeenCalledOnce()
  expect(host.release).toHaveBeenCalledOnce()
  expect(host.acquire.mock.invocationCallOrder[0]).toBeLessThan(
    host.readRoot.mock.invocationCallOrder[0]
  )
  expect(host.readRoot.mock.invocationCallOrder[0]).toBeLessThan(
    host.release.mock.invocationCallOrder[0]
  )
  const next = join(f.root, 'next-data')
  mkdirSync(next)
  host.dataRoot = next
  // Same config references data history missing at the new root, never a stale ordinary negative.
  expect(await router.resolveCandidateDelivery('ordinary')).toEqual({ kind: 'private-unavailable' })
  expect(host.release).toHaveBeenCalledTimes(2)
  host.acquire.mockImplementationOnce(() => {
    throw new Error('Moving root')
  })
  expect(await router.resolveCandidateDelivery('ordinary')).toEqual({ kind: 'private-unavailable' })
  expect(host.release).toHaveBeenCalledTimes(2)
})
const ports = (): CandidateOwnerPorts => ({
  resolveCandidateDelivery: vi.fn(async (id) =>
    id === 'private' ? { kind: 'private-unavailable' as const } : { kind: 'ordinary' as const }
  ),
  resolveControlPolicy: vi.fn(async () => undefined),
  shutdown: vi.fn(async () => ({ reaped: true }))
})
it('uses the same recognizing live factory for control, preserving its explicit old-profile undefined', async () => {
  const cold = vi.fn(async (): Promise<ReadonlySet<string>> => {
    throw new Error('Cold unavailable')
  })
  const router = createDesktopCandidateOwnerRouting(cold),
    owner = ports()
  router.onOwnersReady(owner)
  expect(await router.resolveControlPolicy(binding)).toBeUndefined()
  expect(owner.resolveControlPolicy).toHaveBeenCalledExactlyOnceWith(binding)
  expect(cold).not.toHaveBeenCalled()
  expect(await router.resolveCandidateDelivery('private')).toEqual({ kind: 'private-unavailable' })
})
it('never treats an absent private control hook or multiple owner claims as ordinary', async () => {
  const router = createDesktopCandidateOwnerRouting(async () => new Set())
  const owner = ports()
  delete owner.resolveControlPolicy
  router.onOwnersReady(owner)
  await expect(router.resolveControlPolicy(binding)).rejects.toThrow('unavailable')
  router.onOwnersReady(ports())
  await expect(router.resolveControlPolicy(binding)).rejects.toThrow('unavailable')
  expect(await router.resolveCandidateDelivery('private')).toEqual({ kind: 'private-unavailable' })
})
it('retains unknown cleanup handles, retries the same original shutdown, and fences cold history after release', async () => {
  const router = createDesktopCandidateOwnerRouting(async () => new Set(['private'])),
    owner = ports()
  vi.mocked(owner.shutdown)
    .mockResolvedValueOnce({ reaped: false })
    .mockResolvedValueOnce({ reaped: true })
  router.onOwnersReady(owner)
  expect(await router.shutdown()).toEqual({ reaped: false })
  expect(router.hasActiveWork()).toBe(true)
  expect(await router.shutdown()).toEqual({ reaped: true })
  expect(router.hasActiveWork()).toBe(false)
  expect(owner.shutdown).toHaveBeenCalledTimes(2)
  expect(await router.resolveCandidateDelivery('private')).toEqual({ kind: 'private-unavailable' })
  await expect(router.resolveControlPolicy(binding)).rejects.toThrow('unavailable')
})
it('returns an original private target and ordinary only after complete negative classification', async () => {
  const target = {
    sendContinuation: vi.fn(),
    isContinuationSaved: vi.fn(),
    canStartSessionTurn: vi.fn()
  }
  const owner: CandidateOwnerPorts = {
    ...ports(),
    resolveCandidateDelivery: async (id) =>
      id === 'private' ? { kind: 'private', target } : { kind: 'ordinary' }
  }
  const cold = vi.fn(async () => new Set<string>()),
    router = createDesktopCandidateOwnerRouting(cold)
  const release = router.onOwnersReady(owner)
  expect(await router.resolveCandidateDelivery('private')).toEqual({ kind: 'private', target })
  expect(cold).not.toHaveBeenCalled()
  expect(await router.resolveCandidateDelivery('ordinary')).toEqual({ kind: 'ordinary' })
  release?.()
  release?.()
  expect(router.hasActiveWork()).toBe(false)
})
