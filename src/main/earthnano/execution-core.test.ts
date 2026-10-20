import { describe, it, expect, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import fixtures from '../../../contracts/execution/fixtures.json'
import {
  ExecutionCore,
  emptyExecutionState,
  type ExecutionContext,
  type ExecutionOutcome,
  type ExecutionStore
} from './execution-core'
import { FileExecutionStore } from './execution-store'
import { requestDigest, validateRequest } from './execution-contract'
import type { ExecutionRequest, ExecutionEvent } from '../../shared/earthnano/execution-types'

const request = (key = 'one'): ExecutionRequest => ({
  ...(structuredClone(fixtures.valid) as ExecutionRequest),
  requestKey: key
})
const cores: ExecutionCore[] = []
afterEach(() => {
  cores.splice(0).forEach((core) => core.dispose())
})
const successful: ExecutionOutcome = { phase: 'completed', cleanup: 'confirmed' }
interface Setup {
  core: ExecutionCore
  execute: ReturnType<
    typeof vi.fn<(req: ExecutionRequest, ctx: ExecutionContext) => Promise<ExecutionOutcome>>
  >
  contexts: Map<string, ExecutionContext>
  completions: Map<string, (value: ExecutionOutcome) => void>
  store: ExecutionStore
}
function setup(limit = 10, eventLimit = 256, concurrency?: number): Setup {
  let state = emptyExecutionState()
  const store: ExecutionStore = {
    load: () => structuredClone(state),
    commit: (next) => {
      state = structuredClone(next)
    }
  }
  const contexts = new Map<string, ExecutionContext>()
  const completions = new Map<string, (value: ExecutionOutcome) => void>()
  const execute = vi.fn(async (req: ExecutionRequest, ctx: ExecutionContext) => {
    contexts.set(req.requestKey, ctx)
    ctx.running()
    return new Promise<ExecutionOutcome>((resolve) => completions.set(req.requestKey, resolve))
  })
  const core = new ExecutionCore(store, { execute }, eventLimit, { concurrency })
  cores.push(core)
  core.configureBudget('demo', 'trial', limit)
  return { core, execute, contexts, completions, store }
}
const waitStarted = async (s: Setup, key = 'one'): Promise<void> =>
  vi.waitFor(() => expect(s.contexts.has(key)).toBe(true))
const replay = async (core: ExecutionCore, id: string, cursor = 0): Promise<ExecutionEvent[]> => {
  const events: ExecutionEvent[] = []
  for await (const event of core.events(id, cursor)) events.push(event)
  return events
}

describe('shared wire contract', () => {
  it('generates both language types without drift', () => {
    expect(() =>
      execFileSync('python3', ['scripts/earthnano/generate-contract.py', '--check'])
    ).not.toThrow()
  })
  it('has the same validated Unicode request digest in TypeScript and Python', () => {
    expect(requestDigest(fixtures.valid as ExecutionRequest)).toBe(fixtures.digest)
    const out = execFileSync(
      'python3',
      [
        '-B',
        '-c',
        `import json; from harness2.core.execution_contract import request_digest; f=json.load(open('contracts/execution/fixtures.json')); print(request_digest(f['valid']))`
      ],
      {
        env: { ...process.env, PYTHONPATH: resolve('vendor/harness2') },
        encoding: 'utf8'
      }
    )
    expect(out.trim()).toBe(fixtures.digest)
  })
  it('rejects malformed, unknown and ambiguous fields in both languages', () => {
    const invalid: unknown[] = [
      { ...request(), contractVersion: 2 },
      { ...request(), extra: 1 },
      { ...request(), timeoutMs: true },
      { ...request(), timeoutMs: 1.5 },
      { ...request(), role: 'judge' },
      { ...request(), requestKey: '\uD800' },
      { ...request(), origin: { kind: 'optimization' } },
      { ...request(), invocationRef: { id: 'x', version: '1', digest: 'mutable-path' } }
    ]
    invalid.forEach((value) => expect(() => validateRequest(value)).toThrow())
    const out = execFileSync(
      'python3',
      [
        '-B',
        '-c',
        `import json,sys; from harness2.core.execution_contract import validate_request
for q in json.load(sys.stdin):
 try: validate_request(q)
 except (ValueError,UnicodeError): continue
 raise Exception('Accepted invalid request')
print('rejected')`
      ],
      {
        env: { ...process.env, PYTHONPATH: resolve('vendor/harness2') },
        input: JSON.stringify(invalid),
        encoding: 'utf8'
      }
    )
    expect(out.trim()).toBe('rejected')
  })
})

describe('execution lifecycle contract', () => {
  it('commits admission before driving; deduplicates concurrent submissions at the budget cap', async () => {
    const s = setup(1)
    const [a, b] = await Promise.all([s.core.submit(request()), s.core.submit(request())])
    expect(a).toEqual(b)
    expect(a.phase).toBe('queued')
    expect(s.execute).not.toHaveBeenCalled()
    expect(s.store.load().records[a.executionId]).toBeDefined()
    await waitStarted(s)
    expect(s.execute).toHaveBeenCalledTimes(1)
  })
  it('rejects same key with changed role input, and rejects new admission when budget is used', async () => {
    const s = setup(1)
    await s.core.submit(request())
    const changed = request()
    changed.invocationRef.version = '2'
    await expect(s.core.submit(changed)).rejects.toMatchObject({ code: 'request-conflict' })
    await expect(s.core.submit(request('next'))).rejects.toMatchObject({ code: 'budget-exhausted' })
  })
  it('routes ordinary and candidate roles through the same driver without mutating snapshots', async () => {
    const s = setup()
    const task = request('task')
    const candidate = request('candidate')
    candidate.role = 'candidate'
    candidate.origin = { kind: 'optimization', optimizationId: 'experiment', stageId: 'c1' }
    candidate.invocationRef.id = 'candidate-input'
    await s.core.submit(task)
    await s.core.submit(candidate)
    task.taskSnapshotRef.id = 'mutated-after-submit'
    await waitStarted(s, 'candidate')
    expect(s.execute.mock.calls.map(([q]) => [q.role, q.invocationRef.id])).toEqual([
      ['task', 'snapshot'],
      ['candidate', 'candidate-input']
    ])
    expect(s.execute.mock.calls[0][0].taskSnapshotRef.id).toBe('snapshot')
  })
  it('cancels queued work without starting the provider', async () => {
    const s = setup()
    const h = await s.core.submit(request())
    expect((await s.core.cancel(h.executionId)).status).toBe('cancelled')
    await new Promise((resolve) => setImmediate(resolve))
    expect(s.execute).not.toHaveBeenCalled()
    expect((await s.core.cancel(h.executionId)).status).toBe('cancelled')
  })
  it('does not equate cancellation requested with exited; preserves owner completion in the race', async () => {
    const s = setup()
    const h = await s.core.submit(request())
    await waitStarted(s)
    expect((await s.core.cancel(h.executionId)).status).toBe('requested')
    expect((await s.core.get(h.executionId)).phase).toBe('running')
    expect(s.contexts.get('one')!.signal.aborted).toBe(true)
    s.completions.get('one')!(successful)
    await vi.waitFor(async () => expect((await s.core.get(h.executionId)).phase).toBe('completed'))
    expect((await s.core.cancel(h.executionId)).status).toBe('already-terminal')
  })
  it('confirms cancelled only from the driver outcome', async () => {
    const s = setup()
    const h = await s.core.submit(request())
    await waitStarted(s)
    await s.core.cancel(h.executionId)
    s.completions.get('one')!({ phase: 'cancelled', cleanup: 'confirmed' })
    await vi.waitFor(async () => expect((await s.core.get(h.executionId)).phase).toBe('cancelled'))
  })
  it('separates original identities and refuses overwrite', async () => {
    const s = setup()
    const h = await s.core.submit(request())
    await waitStarted(s)
    const context = s.contexts.get('one')!
    context.identity({ runId: 'legacy', runtimeExecutionId: 'runtime', turnToken: 'turn' })
    expect(() => context.identity({ turnToken: 'different' })).toThrow(
      'Identity cannot be overwritten'
    )
    expect((await s.core.get(h.executionId)).identity.turnToken).toBe('turn')
    expect(h.executionId).not.toBe('runtime')
  })
  it('keeps evidence versions immutable and unknown usage distinct from zero', async () => {
    const s = setup()
    const h = await s.core.submit(request())
    await waitStarted(s)
    const outcome: ExecutionOutcome = {
      ...successful,
      evidence: {
        status: 'complete',
        scope: 'public-output',
        text: 'done',
        artifacts: [{ artifactId: 'a', versionId: 'v1', checksum: 'original' }],
        references: [],
        limitations: []
      }
    }
    s.completions.get('one')!(outcome)
    await vi.waitFor(async () => expect((await s.core.get(h.executionId)).phase).toBe('completed'))
    outcome.evidence!.artifacts[0].checksum = 'later'
    const record = await s.core.get(h.executionId)
    record.evidence.artifacts[0].versionId = 'later'
    expect((await s.core.get(h.executionId)).evidence.artifacts[0]).toEqual({
      artifactId: 'a',
      versionId: 'v1',
      checksum: 'original'
    })
    expect(record.usage).toEqual({ status: 'unknown' })
  })
  it('reports bounded replay gaps and rejects impossible cursors', async () => {
    const s = setup(10, 2)
    const h = await s.core.submit(request())
    await waitStarted(s)
    s.contexts.get('one')!.emit('session-admitted')
    s.contexts.get('one')!.emit('provider-accepted')
    const events = await replay(s.core, h.executionId)
    expect(events.map((e) => e.type)).toEqual(['gap', 'session-admitted', 'provider-accepted'])
    expect(await replay(s.core, h.executionId, events.at(-1)!.sequence)).toEqual([])
    await expect(replay(s.core, h.executionId, 999)).rejects.toMatchObject({
      code: 'invalid-cursor'
    })
  })
  it('times out even an unresponsive driver and fences unknown cleanup', async () => {
    const s = setup()
    const q = request()
    q.timeoutMs = 20
    const h = await s.core.submit(q)
    await vi.waitFor(async () =>
      expect((await s.core.get(h.executionId)).phase).toBe('interrupted')
    )
    await expect(s.core.submit(request('retry'))).rejects.toMatchObject({
      code: 'cleanup-unconfirmed'
    })
    s.completions.get('one')!(successful)
    await new Promise((resolve) => setImmediate(resolve))
    expect((await s.core.get(h.executionId)).error?.code).toBe('timeout')
  })
  it('allocates a new execution for an explicit retry and retains the link', async () => {
    const s = setup()
    const first = await s.core.submit(request())
    await waitStarted(s)
    s.completions.get('one')!({ phase: 'failed', cleanup: 'confirmed' })
    await vi.waitFor(async () => expect((await s.core.get(first.executionId)).phase).toBe('failed'))
    const q = request('retry')
    q.origin.retryOfExecutionId = first.executionId
    const second = await s.core.submit(q)
    expect(second.executionId).not.toBe(first.executionId)
    expect((await s.core.get(second.executionId)).request.origin.retryOfExecutionId).toBe(
      first.executionId
    )
  })
  it('fails admission closed on journal failure without invoking the driver', async () => {
    const s = setup()
    const commit = vi.spyOn(s.store, 'commit').mockImplementation(() => {
      throw new Error('disk failed')
    })
    await expect(s.core.submit(request())).rejects.toThrow('disk failed')
    await new Promise((resolve) => setImmediate(resolve))
    expect(s.execute).not.toHaveBeenCalled()
    commit.mockRestore()
  })
  it('recovers a real persisted journal without replaying prior work or losing reservations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'earthnano-contract-'))
    const filename = join(root, 'executions.json')
    let store = new FileExecutionStore(filename)
    const execute = vi.fn(async () => new Promise<ExecutionOutcome>(() => {}))
    let core = new ExecutionCore(store, { execute })
    cores.push(core)
    try {
      core.configureBudget('demo', 'trial', 1)
      const h = await core.submit(request())
      expect(() => new FileExecutionStore(filename)).toThrow()
      core.dispose()
      store.close()
      store = new FileExecutionStore(filename)
      core = new ExecutionCore(store, { execute })
      cores.push(core)
      expect((await core.get(h.executionId)).phase).toBe('interrupted')
      expect((await core.get(h.executionId)).cleanup).toBe('unknown')
      expect((await core.submit(request())).executionId).toBe(h.executionId)
      await expect(core.submit(request('again'))).rejects.toMatchObject({
        code: 'budget-exhausted'
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(execute).not.toHaveBeenCalled()
    } finally {
      core.dispose()
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('rejects corrupted persisted identity, budget accounting and event sequence', async () => {
    const s = setup()
    const h = await s.core.submit(request())
    s.core.dispose()
    const original = s.store.load()
    const mutations = [
      (state: typeof original): void => {
        state.records[h.executionId].request.invocationRef.version = 'changed'
      },
      (state: typeof original): void => {
        Object.values(state.budgets)[0].admitted = 0
      },
      (state: typeof original): void => {
        state.events[h.executionId][0].sequence = 2
      },
      (state: typeof original): void => {
        state.records[h.executionId].executionId = 'other'
      }
    ]
    for (const mutate of mutations) {
      const damaged = structuredClone(original)
      mutate(damaged)
      expect(
        () => new ExecutionCore({ load: () => damaged, commit: () => {} }, { execute: s.execute })
      ).toThrow()
    }
  })
  it('ignores late provider completion after retirement and restart', async () => {
    const s = setup()
    const h = await s.core.submit(request())
    await waitStarted(s)
    s.core.dispose()
    const restarted = new ExecutionCore(s.store, { execute: s.execute })
    cores.push(restarted)
    s.completions.get('one')!(successful)
    await new Promise((resolve) => setImmediate(resolve))
    expect((await restarted.get(h.executionId)).phase).toBe('interrupted')
    expect(s.store.load().records[h.executionId].phase).toBe('interrupted')
    expect(s.execute).toHaveBeenCalledTimes(1)
  })
  it('does not resolve prototype properties as execution identities', async () => {
    const s = setup()
    await expect(s.core.get('__proto__')).rejects.toMatchObject({ code: 'not-found' })
    await expect(s.core.cancel('constructor')).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('bounded concurrent execution', () => {
  it('reserves queued budget atomically and drains in admission order within the bound', async () => {
    const s = setup(4, 256, 2)
    const handles = await Promise.all(['a', 'b', 'c', 'd'].map((id) => s.core.submit(request(id))))
    await waitStarted(s, 'b')
    expect(s.execute.mock.calls.map(([q]) => q.requestKey)).toEqual(['a', 'b'])
    expect((await s.core.get(handles[2].executionId)).phase).toBe('queued')
    expect(Object.values(s.store.load().budgets)[0]).toEqual({ limit: 4, admitted: 4 })
    await expect(s.core.submit(request('over'))).rejects.toMatchObject({ code: 'budget-exhausted' })
    expect((await s.core.submit(request('c'))).executionId).toBe(handles[2].executionId)
    s.completions.get('b')!(successful)
    await waitStarted(s, 'c')
    expect(s.contexts.has('d')).toBe(false)
    s.completions.get('a')!(successful)
    await waitStarted(s, 'd')
    expect(s.execute.mock.calls.map(([q]) => q.requestKey)).toEqual(['a', 'b', 'c', 'd'])
  })
  it('cancels active and queued admissions without starting a queued provider', async () => {
    const s = setup(3, 256, 2)
    const handles = await Promise.all(['a', 'b', 'c'].map((id) => s.core.submit(request(id))))
    await waitStarted(s, 'b')
    await Promise.all(handles.map((h) => s.core.cancel(h.executionId)))
    expect(s.contexts.get('a')!.signal.aborted).toBe(true)
    expect(s.contexts.get('b')!.signal.aborted).toBe(true)
    expect((await s.core.get(handles[2].executionId)).phase).toBe('cancelled')
    for (const name of ['a', 'b'])
      s.completions.get(name)!({ phase: 'cancelled', cleanup: 'confirmed' })
    await vi.waitFor(async () =>
      expect((await s.core.get(handles[0].executionId)).phase).toBe('cancelled')
    )
    expect(s.execute).toHaveBeenCalledTimes(2)
    expect(Object.values(s.store.load().budgets)[0].admitted).toBe(3)
  })
  it('fences already queued work after unknown cleanup even when another slot becomes free', async () => {
    const s = setup(4, 256, 2)
    const handles = await Promise.all(['a', 'b', 'c'].map((id) => s.core.submit(request(id))))
    await waitStarted(s, 'b')
    s.completions.get('a')!({ phase: 'failed', cleanup: 'unknown' })
    await vi.waitFor(async () =>
      expect((await s.core.get(handles[0].executionId)).phase).toBe('failed')
    )
    s.completions.get('b')!(successful)
    await vi.waitFor(async () =>
      expect((await s.core.get(handles[1].executionId)).phase).toBe('completed')
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(s.execute).toHaveBeenCalledTimes(2)
    expect((await s.core.get(handles[2].executionId)).phase).toBe('queued')
    await expect(s.core.submit(request('d'))).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
    expect((await s.core.cancel(handles[2].executionId)).status).toBe('cancelled')
  })
  it('does not drain after timeout or let late success release a fenced slot', async () => {
    const s = setup(3, 256, 1)
    const first = { ...request('a'), timeoutMs: 20 }
    const a = await s.core.submit(first)
    const b = await s.core.submit(request('b'))
    await vi.waitFor(async () =>
      expect((await s.core.get(a.executionId)).phase).toBe('interrupted')
    )
    s.completions.get('a')!(successful)
    await new Promise((resolve) => setImmediate(resolve))
    expect(s.execute).toHaveBeenCalledTimes(1)
    expect((await s.core.get(b.executionId)).phase).toBe('queued')
    await s.core.cancel(b.executionId)
  })
})
