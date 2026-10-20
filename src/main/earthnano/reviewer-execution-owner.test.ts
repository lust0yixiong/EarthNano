import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionRecord, ExecutionRequest } from '../../shared/earthnano/execution-port'
import type { ReviewAssessmentResult } from '../reviewer/review-assessment-owner'
import { ExecutionCore, emptyExecutionState, type ExecutionState } from './execution-core'
import { currentExecutionScope, withExecutionScope } from './execution-scope'
import { runReviewerExecution, type ReviewerExecutionOptions } from './reviewer-execution-owner'

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function options(): Promise<ReviewerExecutionOptions> {
  const artifactStorageRoot = await mkdtemp(join(tmpdir(), 'reviewer-execution-'))
  roots.push(artifactStorageRoot)
  return {
    artifactStorageRoot,
    projectId: 'project',
    sessionId: 'source-session',
    turnMessageId: 'source-turn',
    reviewerTimeoutMs: 1000,
    scope: { blocks: ['frozen source scope'] },
    prompt: 'initial review',
    recoveryPrompt: 'upstream protocol recovery',
    systemPrompt: 'reviewer-only rubric',
    model: 'reviewer-model',
    cwd: '/private/reviewer-workspace',
    mode: 'initial'
  }
}
const result = (): ReviewAssessmentResult =>
  ({
    review: { id: 'actual-review', lifecycle: 'complete' },
    submittedChecks: []
  }) as unknown as ReviewAssessmentResult
async function records(input: ReviewerExecutionOptions): Promise<ExecutionRecord[]> {
  const directory = join(input.artifactStorageRoot, 'earthnano', 'reviewer-executions')
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json'))
  const journals = await Promise.all(
    names.map(
      async (name) => JSON.parse(await readFile(join(directory, name), 'utf8')) as ExecutionState
    )
  )
  return journals.flatMap((state) => Object.values(state.records))
}

describe('original reviewer execution owner', () => {
  it('owns one assessment admission through real result commit, with separate parent identity', async () => {
    const input = await options()
    const commit = Promise.withResolvers<void>()
    const admitted = Promise.withResolvers<void>()
    let parentState = emptyExecutionState()
    const parentCore = new ExecutionCore(
      {
        load: () => parentState,
        commit: (next) => {
          parentState = next
        }
      },
      {
        execute: async () => {
          throw new Error('parent must not run reviewer')
        }
      }
    )
    const parentRequest = {
      origin: { kind: 'optimization', optimizationId: 'optimization', stageId: 'stage' },
      role: 'candidate'
    } as ExecutionRequest
    let childId: string | undefined
    const pending = withExecutionScope(
      {
        core: parentCore,
        request: parentRequest,
        context: { executionId: 'parent-execution' } as never,
        identity: () => ({ sessionId: 'parent-session' })
      },
      () =>
        runReviewerExecution(input, async (owner) => {
          const scope = currentExecutionScope()!
          expect(scope.core).not.toBe(parentCore)
          expect(scope.request.role).toBe('reviewer')
          childId = scope.context.executionId
          owner.providerSession('disposable-provider-session')
          owner.providerAccepted()
          owner.providerAccepted() // existing optional recovery remains in this same assessment admission
          owner.resourcesDisposed(true)
          admitted.resolve()
          await commit.promise
          return result()
        })
    )
    await admitted.promise
    const [running] = await records(input)
    expect(running.phase).toBe('running')
    expect(running.request.origin).toEqual({
      kind: 'optimization',
      optimizationId: 'optimization',
      stageId: 'stage',
      sessionId: 'source-session',
      promptMessageId: 'source-turn',
      parentExecutionId: 'parent-execution'
    })
    expect(running.identity).toEqual({ providerSessionId: 'disposable-provider-session' })
    expect(childId).not.toBe('parent-execution')
    commit.resolve()
    expect(await pending).toEqual(result())
    const [completed] = await records(input)
    expect(completed).toMatchObject({ phase: 'completed', cleanup: 'confirmed' })
    expect(completed.evidence.references[0].id).toBe('review:actual-review')
    expect(await records(input)).toHaveLength(1)
    expect(Object.values(parentState.records)).toHaveLength(0)
    const journal = await readFile(
      join(
        input.artifactStorageRoot,
        'earthnano',
        'reviewer-executions',
        (await readdir(join(input.artifactStorageRoot, 'earthnano', 'reviewer-executions')))[0]
      ),
      'utf8'
    )
    expect(journal).not.toContain('frozen source scope')
    expect(journal).not.toContain('upstream protocol recovery')
    parentCore.dispose()
  })

  it('preserves commit failure and original cleanup uncertainty', async () => {
    const input = await options()
    await expect(
      runReviewerExecution(input, async (owner) => {
        owner.providerSession('provider')
        owner.providerAccepted()
        owner.resourcesDisposed(false)
        throw new Error('original Review commit failed')
      })
    ).rejects.toThrow('original Review commit failed')
    expect((await records(input))[0]).toMatchObject({
      phase: 'failed',
      cleanup: 'unknown',
      error: { code: 'review-owner-failed', message: 'original Review commit failed' }
    })
  })

  it('acknowledges cancellation through the original signal and waits for disposal/Review commit', async () => {
    const input = await options()
    const controller = new AbortController()
    input.abortSignal = controller.signal
    const disposed = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let ownerSignal: AbortSignal | undefined
    const pending = runReviewerExecution(input, async (owner) => {
      ownerSignal = owner.signal
      owner.providerSession('provider')
      owner.providerAccepted()
      entered.resolve()
      await disposed.promise
      owner.resourcesDisposed(true)
      return {
        ...result(),
        review: {
          ...result().review,
          lifecycle: 'error',
          errorMessage: 'reviewer session was aborted before stopping'
        }
      }
    })
    await entered.promise
    controller.abort()
    expect(ownerSignal?.aborted).toBe(true)
    expect((await records(input))[0].phase).toBe('running')
    disposed.resolve()
    const actual = await pending
    expect(actual.review.lifecycle).toBe('error')
    expect((await records(input))[0]).toMatchObject({
      phase: 'cancelled',
      cleanup: 'confirmed',
      cancellationRequested: true
    })
  })

  it('keeps the canonical deadline ahead of a late successful original Review commit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const input = await options()
    input.reviewerTimeoutMs = 1
    const entered = Promise.withResolvers<void>()
    const commit = Promise.withResolvers<void>()
    let originalCommitted = false
    let ownerSignal: AbortSignal | undefined
    const pending = runReviewerExecution(input, async (owner) => {
      ownerSignal = owner.signal
      owner.providerSession('provider')
      entered.resolve()
      await commit.promise
      originalCommitted = true
      owner.resourcesDisposed(true)
      return result()
    })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await entered.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(30_002)
    expect(ownerSignal?.aborted).toBe(true)
    expect((await records(input))[0]).toMatchObject({ phase: 'interrupted', cleanup: 'unknown' })
    commit.resolve()
    await rejected
    expect(originalCommitted).toBe(true)
    expect((await records(input))[0]).toMatchObject({ phase: 'interrupted', cleanup: 'unknown' })
  })

  it.each(['dead', 'live'] as const)(
    'recovers a prior %s owner without replay or invented cleanup',
    async (kind) => {
      const input = await options()
      await runReviewerExecution(input, async (owner) => {
        owner.resourcesDisposed(true)
        return result()
      })
      const directory = join(input.artifactStorageRoot, 'earthnano', 'reviewer-executions')
      const filename = join(directory, (await readdir(directory))[0])
      const stale = JSON.parse(await readFile(filename, 'utf8')) as ExecutionState
      const [prior] = Object.values(stale.records)
      prior.phase = 'running'
      prior.cleanup = 'pending'
      await writeFile(filename, JSON.stringify(stale))
      await writeFile(`${filename}.lock`, String(process.pid))
      if (kind === 'dead') {
        vi.spyOn(process, 'kill').mockImplementation(() => {
          throw Object.assign(new Error('prior PID no longer exists'), { code: 'ESRCH' })
        })
      }
      let newAssessments = 0
      await runReviewerExecution(input, async (owner) => {
        newAssessments++
        owner.resourcesDisposed(true)
        return result()
      })
      expect(newAssessments).toBe(1)
      const historical = JSON.parse(await readFile(filename, 'utf8')) as ExecutionState
      expect(historical.records[prior.executionId]).toMatchObject(
        kind === 'dead'
          ? { phase: 'interrupted', cleanup: 'unknown', error: { code: 'process_restarted' } }
          : { phase: 'running', cleanup: 'pending' }
      )
      expect((await records(input)).filter((record) => record.phase === 'completed')).toHaveLength(
        1
      )
    }
  )

  it('preserves original committed Review facts while rejecting unconfirmed canonical cleanup', async () => {
    const input = await options()
    let originalCommitted = false
    await expect(
      runReviewerExecution(input, async (owner) => {
        owner.providerSession('provider')
        originalCommitted = true
        owner.resourcesDisposed(false)
        return result()
      })
    ).rejects.toMatchObject({ code: 'reviewer-cleanup-unconfirmed' })
    expect(originalCommitted).toBe(true)
    expect((await records(input))[0]).toMatchObject({ phase: 'failed', cleanup: 'unknown' })
  })

  it('does not let an abort relabel an independent original commit failure', async () => {
    const input = await options()
    const controller = new AbortController()
    input.abortSignal = controller.signal
    await runReviewerExecution(input, async (owner) => {
      owner.providerSession('provider')
      controller.abort()
      owner.resourcesDisposed(true)
      return {
        ...result(),
        review: { ...result().review, lifecycle: 'error', errorMessage: 'commit failed' }
      }
    })
    expect((await records(input))[0]).toMatchObject({
      phase: 'failed',
      cleanup: 'confirmed',
      error: { message: 'commit failed' }
    })
  })
})
