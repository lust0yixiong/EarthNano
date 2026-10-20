import { createHash } from 'node:crypto'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type {
  ExecutionHandle,
  ExecutionRecord,
  ExecutionRequest
} from '../../shared/earthnano/execution-port'
import { emptyExecutionState, ExecutionCore, type ExecutionContext } from './execution-core'
import { HarnessDomainBinding } from './harness-domain-binding'
import { fixture, input } from './research-domain.test-fixture'

const invocation = (taskId: string, retryOfExecutionId = ''): Record<string, unknown> => ({
  invocation: {
    taskId,
    scope: 'earthnano-claude-text-seq1',
    role: 'proposer',
    label: 'inv1.a1',
    stageLabel: 'inv1',
    mission: 'Use the frozen current task.',
    system: '',
    attempt: 1,
    harvest: 'context/harness',
    retryOfExecutionId
  },
  harnessFiles: [],
  contextFiles: []
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Preserve the exact inferred composite fixture type for adversarial mutations.
async function setup(hang = false) {
  const f = await fixture()
  let state = emptyExecutionState()
  const artifact = {
    artifactId: 'same-artifact-bytes',
    versionId: 'same-version',
    checksum: 'sha256:' + 'a'.repeat(64)
  }
  const execute = vi.fn(async (_request: ExecutionRequest, context: ExecutionContext) => {
    context.running()
    if (hang)
      return await new Promise<{ phase: 'cancelled'; cleanup: 'confirmed' }>((resolve) =>
        context.signal.addEventListener(
          'abort',
          () => resolve({ phase: 'cancelled', cleanup: 'confirmed' }),
          { once: true }
        )
      )
    return {
      phase: 'completed' as const,
      cleanup: 'confirmed' as const,
      evidence: {
        status: 'complete' as const,
        scope: 'fixed output',
        text: 'done',
        artifacts: [artifact],
        references: [],
        limitations: []
      }
    }
  })
  const core = new ExecutionCore(
    {
      load: () => structuredClone(state),
      commit: (value) => {
        state = structuredClone(value)
      }
    },
    { execute }
  )
  core.configureBudget('project', 'budget', 8)
  onTestFinished(() => core.dispose())
  const exporters = ['task-0001', 'task-0002'].map((taskId) =>
    vi.fn(async (record: ExecutionRecord) => {
      const content = `Immutable output owned by ${taskId}`
      return {
        executionId: record.executionId,
        artifacts: [artifact],
        replyText: taskId,
        trajectoryText: 'trajectory',
        files: [
          {
            path: 'answer.txt',
            content,
            artifactRef: artifact,
            digest: 'sha256:' + createHash('sha256').update(content).digest('hex')
          }
        ]
      }
    })
  )
  const tasks = ['task-0001', 'task-0002'].map((taskId, index) => ({
    core,
    snapshots: f.snapshots,
    input: structuredClone(input),
    projectId: 'project',
    optimizationId: 'experiment',
    taskId,
    budgetRef: 'budget',
    timeoutMs: 5000,
    exportResult: exporters[index]!
  }))
  return { ...f, core, execute, exporters, tasks, binding: new HarnessDomainBinding(tasks) }
}
const freeze = async (
  f: Awaited<ReturnType<typeof setup>>,
  taskId: string,
  retry = ''
): Promise<ExecutionRequest> =>
  (await f.binding.dispatch('freezeInvocation', invocation(taskId, retry))) as ExecutionRequest
const submit = async (
  f: Awaited<ReturnType<typeof setup>>,
  request: ExecutionRequest
): Promise<ExecutionHandle> => (await f.binding.dispatch('submit', { request })) as ExecutionHandle
const complete = async (f: Awaited<ReturnType<typeof setup>>, executionId: string): Promise<void> =>
  await vi.waitFor(async () => expect((await f.core.get(executionId)).phase).toBe('completed'))

describe('domain task execution ownership', () => {
  it('keeps identical task snapshots and artifact bytes associated with their actual task admissions', async () => {
    const f = await setup()
    const first = await freeze(f, 'task-0001'),
      second = await freeze(f, 'task-0002')
    expect(first.taskSnapshotRef).toEqual(second.taskSnapshotRef)
    const a = await submit(f, first),
      b = await submit(f, second)
    await Promise.all([complete(f, a.executionId), complete(f, b.executionId)])
    expect(f.binding.executionIdsForTask('task-0001')).toEqual([a.executionId])
    expect(f.binding.executionIdsForTask('task-0002')).toEqual([b.executionId])
    expect(f.binding.executionIds).toEqual([a.executionId, b.executionId])
    expect(
      await f.binding.dispatch('readResult', { executionId: a.executionId, taskId: 'task-0002' })
    ).toMatchObject({ replyText: 'task-0001' })
    expect(f.exporters[1]).not.toHaveBeenCalled()
    expect(await f.binding.dispatch('readResult', { executionId: b.executionId })).toMatchObject({
      replyText: 'task-0002'
    })
    expect(f.exporters[0]).toHaveBeenCalledOnce()
  })
  it('permits only same-task retry provenance and refuses a modified or unfrozen request', async () => {
    const f = await setup()
    const first = await freeze(f, 'task-0001'),
      admitted = await submit(f, first)
    await expect(freeze(f, 'task-0002', admitted.executionId)).rejects.toThrow()
    const retry = await freeze(f, 'task-0001', admitted.executionId)
    expect(retry.requestKey).not.toBe(first.requestKey)
    expect(retry.origin.retryOfExecutionId).toBe(admitted.executionId)
    const retryHandle = await submit(f, retry)
    expect(f.binding.executionIdsForTask('task-0001')).toEqual([
      admitted.executionId,
      retryHandle.executionId
    ])
    expect(f.binding.executionIdsForTask('task-0002')).toEqual([])
    await expect(submit(f, { ...first, requestKey: 'not-frozen' })).rejects.toThrow('Unowned')
    await expect(submit(f, { ...first, role: 'composer' })).rejects.toThrow()
    expect(f.binding.executionIds).toHaveLength(2)
  })
  it.each(['get', 'readResult', 'cancel', 'events'])(
    'refuses %s for an execution admitted outside this experiment',
    async (operation) => {
      const f = await setup()
      const request = await freeze(f, 'task-0001')
      // A direct core admission is not a mux admission, even if its request was frozen here.
      const external = await f.core.submit(request)
      await expect(
        f.binding.dispatch(operation, { executionId: external.executionId })
      ).rejects.toThrow('Unowned')
      expect(f.exporters.every((exporter) => exporter.mock.calls.length === 0)).toBe(true)
    }
  )
  it('stops both owners and prevents every later admission without confusing identical snapshots', async () => {
    const f = await setup(true)
    const a = await submit(f, await freeze(f, 'task-0001'))
    const b = await submit(f, await freeze(f, 'task-0002'))
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2))
    await f.binding.stop()
    await vi.waitFor(async () => {
      expect((await f.core.get(a.executionId)).phase).toBe('cancelled')
      expect((await f.core.get(b.executionId)).phase).toBe('cancelled')
    })
    await expect(freeze(f, 'task-0001')).rejects.toThrow('stopped')
    await expect(f.binding.dispatch('get', { executionId: a.executionId })).rejects.toThrow(
      'stopped'
    )
    expect(f.binding.executionIdsForTask('task-0001')).toEqual([a.executionId])
    expect(f.binding.executionIdsForTask('task-0002')).toEqual([b.executionId])
  })
  it('rejects duplicate task identities and unknown tasks before freezing or admitting', async () => {
    const f = await setup()
    expect(() => new HarnessDomainBinding([f.tasks[0]!, f.tasks[0]!])).toThrow('Duplicate')
    await expect(freeze(f, 'unknown')).rejects.toThrow('Unknown')
    expect(f.binding.executionIds).toEqual([])
  })
})
