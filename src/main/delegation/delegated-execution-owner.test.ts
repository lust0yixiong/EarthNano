import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileExecutionStore } from '../earthnano/execution-store'
import { currentExecutionScope } from '../earthnano/execution-scope'
import { createDelegatedExecutionOwner } from './delegated-execution-owner'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'delegated-canonical-'))
  roots.push(root)
  const makeOwner = () =>
    createDelegatedExecutionOwner(root, {
      projectId: 'project',
      sourceSessionId: 'source',
      parentPromptMessageId: 'root-prompt',
      frameId: 'child-frame',
      attemptId: 'attempt',
      runtimeSegmentId: 'segment-1',
      task: 'Private task text',
      inputs: [],
      workspaceCwd: root,
      frameworkId: 'codex'
    })
  const owner = makeOwner()
  const files = async () => {
    const base = join(root, 'delegation', 'executions')
    const [mission] = await readdir(base)
    return { path: join(base, mission), names: await readdir(join(base, mission)) }
  }
  return { owner, files, makeOwner }
}
const turn = (id: string, segment = 'segment-1') => ({
  promptMessageId: id,
  agentFrameId: 'child-frame',
  runtimeSegmentId: segment
})

describe('original delegated mission execution owner', () => {
  it('reuses a confirmed mission identity without dispatching another provider', async () => {
    const { owner, makeOwner } = await setup()
    const first = await owner.run(
      async (context) => {
        context.running()
      },
      () => ({ phase: 'completed', cleanup: 'confirmed' }),
      async () => undefined
    )
    const repeatedWork = vi.fn(async () => undefined)
    const second = await makeOwner().run(
      repeatedWork,
      () => ({ phase: 'completed', cleanup: 'confirmed' }),
      async () => undefined
    )
    expect(second.executionId).toBe(first.executionId)
    expect(repeatedWork).not.toHaveBeenCalled()
  })

  it('marks a dead mission interrupted and keeps its resources fenced without replay', async () => {
    const { owner, files, makeOwner } = await setup()
    await owner.run(
      async (context) => {
        context.running()
      },
      () => ({ phase: 'completed', cleanup: 'confirmed' }),
      async () => undefined
    )
    const { path, names } = await files()
    const filename = join(
      path,
      names.find((name) => name.endsWith('.json'))!
    )
    const state = JSON.parse(await readFile(filename, 'utf8'))
    const record = Object.values(state.records)[0] as { phase: string; cleanup: string }
    record.phase = 'running'
    record.cleanup = 'pending'
    await writeFile(filename, JSON.stringify(state))
    await writeFile(`${filename}.lock`, '99999999')
    const work = vi.fn(async () => undefined)
    await expect(
      makeOwner().run(
        work,
        () => ({ phase: 'completed', cleanup: 'confirmed' }),
        async () => undefined
      )
    ).rejects.toThrow('fenced pending original-owner reconciliation')
    expect(work).not.toHaveBeenCalled()
    const recovered = JSON.parse(await readFile(filename, 'utf8'))
    expect(Object.values(recovered.records)[0]).toMatchObject({
      phase: 'interrupted',
      cleanup: 'unknown'
    })
    expect(Object.values(recovered.budgets)).toEqual([{ limit: 1, admitted: 1 }])
    expect(await readFile(`${filename}.lock`, 'utf8')).toBe(String(process.pid))
  })

  it('rejects a failed preparing commit without waiting for a driver that never started', async () => {
    const { owner, files } = await setup()
    const original = FileExecutionStore.prototype.commit
    const commit = vi.spyOn(FileExecutionStore.prototype, 'commit').mockImplementation(function (
      this: FileExecutionStore,
      state
    ) {
      if (Object.values(state.records).some((record) => record.phase === 'preparing')) {
        throw new Error('preparing durable commit failed')
      }
      return original.call(this, state)
    })
    const work = vi.fn(async () => undefined)
    try {
      await expect(
        owner.run(
          work,
          () => ({ phase: 'completed', cleanup: 'confirmed' }),
          async () => undefined
        )
      ).rejects.toThrow('retired before terminal commit')
      expect(work).not.toHaveBeenCalled()
      expect((await files()).names.some((name) => name.endsWith('.lock'))).toBe(true)
    } finally {
      commit.mockRestore()
    }
  })

  it('admits one mission across internal turns and waits for original durable cleanup before completion', async () => {
    const { owner, files } = await setup()
    const cleanup = deferred()
    const entered = deferred()
    let executionId = ''
    const result = owner.run(
      async (context) => {
        context.identity({ sessionId: 'physical-child', promptMessageId: 'first' })
        context.running()
        executionId = currentExecutionScope()!.context.executionId
        expect(owner.ownsExecution(executionId)).toBe(true)
        owner.activateTurn(turn('first'))
        expect(owner.ownsTurn(turn('first'))).toBe(true)
        owner.activateTurn(turn('second', 'segment-2'))
        expect(owner.ownsTurn(turn('first'))).toBe(false)
        expect(owner.ownsTurn(turn('second', 'segment-2'))).toBe(true)
        expect(owner.ownsTurn({ ...turn('second', 'segment-2'), agentFrameId: 'other' })).toBe(
          false
        )
        entered.resolve()
        await cleanup.promise
      },
      () => ({ phase: 'completed', cleanup: 'confirmed' }),
      async () => undefined
    )
    await entered.promise
    let returned = false
    void result.then(() => {
      returned = true
    })
    await Promise.resolve()
    expect(returned).toBe(false)
    const active = await files()
    expect(active.names.some((name) => name.endsWith('.lock'))).toBe(true)
    const state = JSON.parse(
      await readFile(
        join(
          active.path,
          active.names.find((name) => name.endsWith('.json'))!
        ),
        'utf8'
      )
    )
    expect(Object.keys(state.records)).toHaveLength(1)
    expect(Object.values(state.budgets)).toEqual([{ limit: 1, admitted: 1 }])
    expect(JSON.stringify(state)).not.toContain('Private task text')
    cleanup.resolve()
    expect(await result).toMatchObject({
      phase: 'completed',
      identity: { sessionId: 'physical-child', promptMessageId: 'first' }
    })
    expect(owner.ownsExecution(executionId)).toBe(false)
    expect((await files()).names.some((name) => name.endsWith('.lock'))).toBe(false)
  })

  it('acknowledges original cancellation before aborting the mission', async () => {
    const { owner } = await setup()
    const entered = deferred()
    const acknowledged = deferred()
    let aborted = false
    const result = owner.run(
      async (context) => {
        context.identity({ sessionId: 'physical-child', promptMessageId: 'first' })
        context.running()
        context.signal.addEventListener('abort', () => {
          aborted = true
        })
        entered.resolve()
        await new Promise<void>((resolve) =>
          context.signal.addEventListener('abort', () => resolve(), { once: true })
        )
      },
      () => ({ phase: 'cancelled', cleanup: 'confirmed' }),
      () => acknowledged.promise
    )
    await entered.promise
    const stopped = owner.cancel(async () => {
      throw new Error('Must use registered owner cancellation')
    })
    expect(aborted).toBe(false)
    acknowledged.resolve()
    await stopped
    expect(await result).toMatchObject({ phase: 'cancelled', cancellationRequested: true })
  })

  it('preserves a rejected stop and permits the original mission to finish', async () => {
    const { owner } = await setup()
    const entered = deferred()
    const complete = deferred()
    const result = owner.run(
      async (context) => {
        context.running()
        entered.resolve()
        await complete.promise
        expect(context.signal.aborted).toBe(false)
      },
      () => ({ phase: 'completed', cleanup: 'confirmed' }),
      async () => {
        throw new Error('Owner rejected stop')
      }
    )
    await entered.promise
    await expect(owner.cancel(async () => undefined)).rejects.toThrow('Owner rejected stop')
    complete.resolve()
    expect(await result).toMatchObject({ phase: 'completed', cancellationRequested: false })
  })

  it('keeps uncertain process cleanup fenced after preserving the original result', async () => {
    const { owner, files } = await setup()
    const result = await owner.run(
      async (context) => {
        context.running()
      },
      () => ({ phase: 'completed', cleanup: 'unknown' }),
      async () => undefined
    )
    expect(result).toMatchObject({ phase: 'completed', cleanup: 'unknown' })
    expect((await files()).names.some((name) => name.endsWith('.lock'))).toBe(true)
    await expect(
      owner.run(
        async () => undefined,
        () => ({ phase: 'completed', cleanup: 'confirmed' }),
        async () => undefined
      )
    ).rejects.toThrow('already admitted')
  })

  it('retains an original failure after confirmed process retirement', async () => {
    const { owner } = await setup()
    const readResult = vi.fn(() => ({
      phase: 'failed' as const,
      cleanup: 'confirmed' as const,
      error: { code: 'delegation-owner-failed', message: 'Original child commit failed' }
    }))
    expect(
      await owner.run(
        async (context) => {
          context.running()
        },
        readResult,
        async () => undefined
      )
    ).toMatchObject({
      phase: 'failed',
      cleanup: 'confirmed',
      error: { message: 'Original child commit failed' }
    })
  })
})
