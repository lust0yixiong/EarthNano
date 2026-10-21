import { createHash } from 'node:crypto'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type {
  ExecutionHandle,
  ExecutionRecord,
  ExecutionRequest
} from '../../shared/earthnano/execution-port'
import { emptyExecutionState, ExecutionCore, type ExecutionContext } from './execution-core'
import { HarnessDomainBinding } from './harness-domain-binding'
import { createHarnessBindingV2Identity, harnessBindingV2Slot } from './harness-binding-v2'
import { fixture, input } from '../../../test/earthnano/research-domain'

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
  return {
    ...f,
    core,
    execute,
    exporters,
    tasks,
    binding: new HarnessDomainBinding(tasks),
    readState: (): ReturnType<typeof emptyExecutionState> => structuredClone(state)
  }
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
  it('stops every v2 mode through the shared Core and refuses later admissions', async () => {
    const f = await setup(true)
    const identity = createHarnessBindingV2Identity({ k: 1, seed: null, modes: ['agg', 'seq'] })
    f.binding = new HarnessDomainBinding(
      f.tasks.map((task) => ({ ...task, bindingIdentity: identity }))
    )
    const handles: ExecutionHandle[] = []
    for (const scope of Object.values(identity.modeScopes)) {
      const args = invocation('task-0001')
      ;(args.invocation as Record<string, unknown>).scope = scope
      handles.push(
        await submit(f, (await f.binding.dispatch('freezeInvocation', args)) as ExecutionRequest)
      )
    }
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2))
    await f.binding.stop()
    await vi.waitFor(async () => {
      for (const handle of handles)
        expect((await f.core.get(handle.executionId)).phase).toBe('cancelled')
    })
    await expect(f.binding.dispatch('freezeInvocation', invocation('task-0001'))).rejects.toThrow(
      'stopped'
    )
    expect(f.execute).toHaveBeenCalledTimes(2)
  })
  it('keeps v2 mode slots and scoped reflection/baseline inventories distinct across resume', async () => {
    const f = await setup()
    const identity = createHarnessBindingV2Identity({ k: 1, seed: null, modes: ['agg', 'seq'] })
    const routing = new Map<string, { slot: string; scope: string }>()
    const options = f.tasks.map((task) => ({
      ...task,
      bindingIdentity: identity,
      onFreeze: (request: ExecutionRequest, slot: string, scope?: string): void => {
        expect(scope).toBeTruthy()
        routing.set(request.requestKey, { slot, scope: scope! })
      }
    }))
    f.binding = new HarnessDomainBinding(options)
    const offered = (role: string, scope: string): Record<string, unknown> => ({
      ...invocation('task-0001'),
      invocation: { ...(invocation('task-0001').invocation as object), role, scope }
    })
    const requests: ExecutionRequest[] = [],
      ids: string[] = []
    for (const [role, scope] of [
      ['baseline', identity.baseScope],
      ['reflection', identity.modeScopes.agg!],
      ['reflection', identity.modeScopes.seq!]
    ]) {
      const request = (await f.binding.dispatch(
        'freezeInvocation',
        offered(role, scope)
      )) as ExecutionRequest
      requests.push(request)
      const handle = await submit(f, request)
      ids.push(handle.executionId)
      await complete(f, handle.executionId)
    }
    expect(new Set([...routing.values()].map((row) => row.slot)).size).toBe(3)
    for (const [scope, own] of [
      [identity.modeScopes.agg!, ids[1]],
      [identity.modeScopes.seq!, ids[2]]
    ]) {
      const rows = (await f.binding.dispatch('taskRecords', {
        taskId: 'task-0001',
        scope
      })) as ExecutionRecord[]
      expect(rows.map((row) => row.executionId)).toEqual([ids[0], own])
    }
    const records = await Promise.all(ids.map((id) => f.core.get(id)))
    f.binding = new HarnessDomainBinding(
      options.map((task) => ({
        ...task,
        resumeRecords: task.taskId === 'task-0001' ? records : [],
        resumeSlot: (key: string): string | undefined => routing.get(key)?.slot,
        resumeScope: (key: string): string | undefined => routing.get(key)?.scope
      }))
    )
    for (const request of requests) {
      const original = records.find((record) => record.requestKey === request.requestKey)!
      const retried = (await f.binding.dispatch(
        'freezeInvocation',
        offered(request.role, routing.get(request.requestKey)!.scope)
      )) as ExecutionRequest
      expect(retried).toEqual(request)
      expect((await submit(f, retried)).executionId).toBe(original.executionId)
    }
    expect(f.execute).toHaveBeenCalledTimes(3)
    expect(f.binding.executionIds).toEqual(ids)
    expect(Object.values(f.readState().budgets)[0].admitted).toBe(3)
  })
  it('rejects v2 foreign scopes, cross-mode retries and missing/v1 resume routing before admission', async () => {
    const f = await setup()
    const identity = createHarnessBindingV2Identity({ k: 1, seed: null, modes: ['agg', 'seq'] })
    const routing = new Map<string, { slot: string; scope: string }>()
    const options = f.tasks.map((task) => ({
      ...task,
      bindingIdentity: identity,
      onFreeze: (request: ExecutionRequest, slot: string, scope?: string): void => {
        routing.set(request.requestKey, { slot, scope: scope! })
      }
    }))
    f.binding = new HarnessDomainBinding(options)
    const first = await freeze(f, 'task-0001'),
      admitted = await submit(f, first)
    await complete(f, admitted.executionId)
    const cross = invocation('task-0001', admitted.executionId)
    ;(cross.invocation as Record<string, unknown>).scope = identity.modeScopes.agg
    await expect(f.binding.dispatch('freezeInvocation', cross)).rejects.toThrow()
    const foreign = invocation('task-0001')
    ;(foreign.invocation as Record<string, unknown>).scope = 'earthnano-claude-text-seq2'
    await expect(f.binding.dispatch('freezeInvocation', foreign)).rejects.toThrow()
    await expect(
      f.binding.dispatch('taskRecords', { taskId: 'task-0001', scope: 'foreign' })
    ).rejects.toThrow()
    const record = await f.core.get(admitted.executionId)
    for (const [slot, scope] of [
      ['sha256:' + 'a'.repeat(64), identity.modeScopes.seq],
      [routing.get(first.requestKey)!.slot, undefined],
      [routing.get(first.requestKey)!.slot, 'foreign']
    ]) {
      expect(
        () =>
          new HarnessDomainBinding([
            {
              ...options[0],
              resumeRecords: [record],
              resumeSlot: () => slot,
              resumeScope: () => scope
            }
          ])
      ).toThrow()
    }
    const changed = new HarnessDomainBinding([
      {
        ...options[0],
        input: {
          ...options[0].input,
          agent: { ...options[0].input.agent, providerRef: 'changed-route' }
        },
        resumeRecords: [record],
        resumeSlot: () => routing.get(first.requestKey)!.slot,
        resumeScope: () => identity.modeScopes.seq
      }
    ])
    await expect(changed.dispatch('freezeInvocation', invocation('task-0001'))).rejects.toThrow(
      'paid replay refused'
    )
    // Rewriting a readable index must not turn a same-byte seq completion into an agg one.
    const agg = invocation('task-0001')
    ;(agg.invocation as Record<string, unknown>).scope = identity.modeScopes.agg
    const forgedSlot = harnessBindingV2Slot(identity, 'task-0001', {
      taskId: 'task-0001',
      scope: identity.modeScopes.agg,
      role: 'proposer',
      stageLabel: 'inv1',
      label: 'inv1.a1',
      attempt: 1
    })
    const rebound = new HarnessDomainBinding([
      {
        ...options[0],
        resumeRecords: [record],
        resumeSlot: () => forgedSlot,
        resumeScope: () => identity.modeScopes.agg
      }
    ])
    await expect(rebound.dispatch('freezeInvocation', agg)).rejects.toThrow('paid replay refused')
    await expect(
      rebound.dispatch('readResult', { executionId: record.executionId })
    ).rejects.toThrow('paid replay refused')
    const otherSlot = harnessBindingV2Slot(identity, 'task-0002', {
      taskId: 'task-0002',
      scope: identity.modeScopes.seq,
      role: 'proposer',
      stageLabel: 'inv1',
      label: 'inv1.a1',
      attempt: 1
    })
    const wrongTask = new HarnessDomainBinding([
      {
        ...options[1],
        resumeRecords: [record],
        resumeSlot: () => otherSlot,
        resumeScope: () => identity.modeScopes.seq
      }
    ])
    await expect(wrongTask.dispatch('freezeInvocation', invocation('task-0002'))).rejects.toThrow(
      'paid replay refused'
    )
    expect(f.execute).toHaveBeenCalledOnce()
  })
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

it('uses one Core and independent frozen Python/R task profiles across original mode scopes and cached reopen', async () => {
  const f = await setup()
  const identity = createHarnessBindingV2Identity({ k: 1, seed: 0, modes: ['agg', 'seq'] })
  const routing = new Map<string, { slot: string; scope: string }>()
  const options = f.tasks.map((task, index) => {
    const language = index === 0 ? ('python' as const) : ('r' as const)
    return {
      ...task,
      bindingIdentity: identity,
      input: {
        ...task.input,
        task: {
          prompt: `Original ${task.taskId}`,
          files: [],
          managedInputs: [
            {
              sourceKind: 'upload-version' as const,
              sourceProjectId: 'project',
              sourceSessionId: `source-${task.taskId}`,
              sourceFileId: `file-${task.taskId}`,
              inputFileVersionId: `version-${task.taskId}`,
              filename: 'same-name.csv',
              sizeBytes: 1,
              checksum: (index ? 'b' : 'a').repeat(64)
            }
          ]
        },
        harness: {
          ...task.input.harness,
          tools: index === 0 ? ('notebook-python' as const) : ('notebook-r' as const)
        },
        environment: {
          isolation: 'directory-process' as const,
          network: 'provider-and-notebook-policy' as const,
          notebook: {
            runtime: {
              language,
              runtimeId: `/original/${language}`,
              interpreterPath: `/original/${language}`,
              source: 'external' as const,
              provenance: 'user-own' as const
            }
          }
        }
      },
      onFreeze: (request: ExecutionRequest, slot: string, scope?: string): void => {
        routing.set(request.requestKey, { slot, scope: scope! })
      }
    }
  })
  f.binding = new HarnessDomainBinding(options)
  const requests: ExecutionRequest[] = []
  const offered = (taskId: string, role: string, scope: string): Record<string, unknown> => ({
    ...invocation(taskId),
    invocation: {
      ...(invocation(taskId).invocation as Record<string, unknown>),
      role,
      scope,
      harvest: null
    }
  })
  for (const task of options) {
    let fixed: ExecutionRequest | undefined
    for (const [role, scope] of [
      ['baseline', identity.baseScope],
      ['candidate', identity.modeScopes.agg!],
      ['candidate', identity.modeScopes.seq!],
      ['reflection', identity.modeScopes.seq!]
    ]) {
      const request = (await f.binding.dispatch(
        'freezeInvocation',
        offered(task.taskId, role!, scope!)
      )) as ExecutionRequest
      const resolved = await f.snapshots.resolve(request)
      expect(resolved.task).toEqual(task.input.task)
      if (role === 'reflection') {
        expect(resolved.harness.tools).toBe('workspace-only')
        expect(resolved.environment).toEqual(input.environment)
      } else {
        expect(resolved.harness.tools).toBe(task.input.harness.tools)
        expect(resolved.environment).toEqual(task.input.environment)
        if (fixed) {
          expect(request.taskSnapshotRef).toEqual(fixed.taskSnapshotRef)
          expect(request.environmentSpecRef).toEqual(fixed.environmentSpecRef)
        }
        fixed = request
      }
      requests.push(request)
      const handle = await submit(f, request)
      await complete(f, handle.executionId)
    }
  }
  expect(requests[0]!.taskSnapshotRef).not.toEqual(requests[4]!.taskSnapshotRef)
  expect(requests[0]!.environmentSpecRef).not.toEqual(requests[4]!.environmentSpecRef)
  const records = Object.values(f.readState().records)
  f.binding = new HarnessDomainBinding(
    options.map((task) => ({
      ...task,
      resumeRecords: records.filter(
        (record) =>
          record.request.taskSnapshotRef.digest ===
          requests[task.taskId === 'task-0001' ? 0 : 4]!.taskSnapshotRef.digest
      ),
      resumeSlot: (key: string): string | undefined => routing.get(key)?.slot,
      resumeScope: (key: string): string | undefined => routing.get(key)?.scope
    }))
  )
  for (const task of options)
    for (const [role, scope] of [
      ['baseline', identity.baseScope],
      ['candidate', identity.modeScopes.agg!],
      ['candidate', identity.modeScopes.seq!],
      ['reflection', identity.modeScopes.seq!]
    ]) {
      const restored = (await f.binding.dispatch(
        'freezeInvocation',
        offered(task.taskId, role!, scope!)
      )) as ExecutionRequest
      expect(requests).toContainEqual(restored)
      await submit(f, restored)
    }
  expect(f.execute).toHaveBeenCalledTimes(8)
  expect(Object.values(f.readState().budgets)[0]!.admitted).toBe(8)
})

it('rejects cross-task context asset references even when task snapshots and artifact bytes match', async () => {
  const f = await setup()
  const args = invocation('task-0001')
  ;(args.invocation as Record<string, unknown>).role = 'baseline'
  ;(args.invocation as Record<string, unknown>).harvest = null
  const request = (await f.binding.dispatch('freezeInvocation', args)) as ExecutionRequest
  const admitted = await submit(f, request)
  await complete(f, admitted.executionId)
  const foreign = {
    path: 'candidates/A/asset.png',
    sourceExecutionId: admitted.executionId,
    artifact: {
      path: 'figure.png',
      representation: 'binary',
      sizeBytes: 1,
      digest: 'sha256:' + 'a'.repeat(64),
      artifactRef: {
        artifactId: 'same-artifact-bytes',
        versionId: 'same-version',
        checksum: 'a'.repeat(64)
      }
    }
  }
  await expect(
    f.binding.dispatch('freezeInvocation', { ...invocation('task-0002'), assets: [foreign] })
  ).rejects.toThrow('out-of-scope')
  expect(f.exporters.every((exporter) => exporter.mock.calls.length === 0)).toBe(true)
  await expect(
    f.binding.dispatch('materializeArtifact', {
      executionId: 'outside-domain',
      artifactRef: foreign.artifact.artifactRef
    })
  ).rejects.toThrow('Unowned')
})
