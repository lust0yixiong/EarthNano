import { execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  MAX_HARNESS_FRAME_BYTES,
  MAX_HARNESS_EVIDENCE_BYTES,
  MAX_HARNESS_EVIDENCE_FILES
} from './harness-binding-limits'
import { MAX_TIMER_TIMEOUT_MS } from './execution-timeout'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCandidateSnapshotStore,
  type CandidateSnapshotInput,
  type CandidateSnapshotStore
} from './candidate-snapshot'
import { emptyExecutionState, ExecutionCore } from './execution-core'
import {
  HarnessOptimizationBinding,
  runHarnessProcess,
  type PersistentExecutionExport
} from './harness-optimization'
import type { ExecutionRequest, ExecutionHandle } from '../../shared/earthnano/execution-port'

const roots: string[] = []
const cores: ExecutionCore[] = []
afterEach(async () => {
  cores.splice(0).forEach((core) => core.dispose())
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const input: CandidateSnapshotInput = {
  task: {
    prompt: 'Produce result.json',
    files: [{ path: 'input.txt', content: 'frozen research input' }]
  },
  harness: { instructions: 'Base instructions', skills: [], tools: 'workspace-only' },
  agent: {
    backend: 'claude-code',
    model: 'deepseek-flash',
    providerRef: 'explicit-live',
    runtimeVersion: '2.1.232'
  },
  environment: { isolation: 'directory-process', network: 'provider-only' }
}
const invocation = (role = 'proposer'): Record<string, unknown> => ({
  invocation: {
    taskId: 't1',
    scope: 'earthnano-claude-text-seq1',
    role,
    label: 'inv1.a1',
    stageLabel: 'inv1',
    mission: 'Improve the method',
    system: '',
    attempt: 1,
    harvest: role === 'proposer' ? 'context/harness' : null
  },
  harnessFiles: [],
  contextFiles: [{ path: 'context/harness/instructions.md', content: 'Original method' }]
})
const setup = async (
  sourceInput: CandidateSnapshotInput = input
): Promise<{
  root: string
  binding: HarnessOptimizationBinding
  snapshots: CandidateSnapshotStore
  core: ExecutionCore
  exportValue: PersistentExecutionExport
}> => {
  const root = await mkdtemp(join(tmpdir(), 'earthnano-harness-binding-'))
  roots.push(root)
  const snapshots = await createCandidateSnapshotStore({
    root: join(root, 'snapshots'),
    candidatesRoot: join(root, 'candidates')
  })
  let state = emptyExecutionState()
  const checksum = `sha256:${createHash('sha256').update('persisted').digest('hex')}`
  const ref = { artifactId: 'artifact', versionId: 'version', checksum }
  const core = new ExecutionCore(
    {
      load: () => state,
      commit: (next) => {
        state = structuredClone(next)
      }
    },
    {
      execute: async (_request, context) => {
        context.running()
        return {
          phase: 'completed',
          cleanup: 'confirmed',
          evidence: {
            status: 'complete',
            scope: 'fixed version fixture',
            text: 'reply',
            artifacts: [ref],
            references: [],
            limitations: []
          }
        }
      }
    }
  )
  cores.push(core)
  core.configureBudget('project', 'budget', 7)
  const exportValue: PersistentExecutionExport = {
    executionId: '',
    artifacts: [ref],
    replyText: 'reply',
    trajectoryText: 'trajectory',
    files: [{ path: 'result.txt', content: 'persisted', digest: checksum, artifactRef: ref }]
  }
  const binding = new HarnessOptimizationBinding({
    core,
    snapshots,
    input: sourceInput,
    projectId: 'project',
    optimizationId: randomUUID(),
    taskId: 't1',
    budgetRef: 'budget',
    timeoutMs: 2000,
    exportResult: async (record) => ({ ...exportValue, executionId: record.executionId })
  })
  return { root, binding, snapshots, core, exportValue }
}

describe('trusted Harness optimization binding', () => {
  it('preserves the original selector reply protocol while persisting its decision as an artifact', async () => {
    const f = await setup()
    const offered = invocation('selector')
    const request = (await f.binding.dispatch('freezeInvocation', {
      ...offered,
      contextFiles: [
        { path: 'context/candidates/A.md', content: 'candidate A final output' },
        { path: 'context/candidates/B.md', content: 'candidate B final output' }
      ]
    })) as ExecutionRequest
    const resolved = await f.snapshots.resolve(request)
    expect(request.role).toBe('selector')
    expect(resolved.invocation.mission).toContain('candidate A final output')
    expect(resolved.invocation.mission).toContain('candidate B final output')
    expect(resolved.invocation.mission).toContain('choice block and why format')
    expect(resolved.invocation.mission).toContain('OUTPUT/selection.md')
    expect(resolved.invocation.mission).not.toContain('Emit the complete revised harness')
  })
  it('freezes role context separately while retaining the same research task across changed harnesses', async () => {
    const f = await setup()
    const a = (await f.binding.dispatch('freezeInvocation', invocation())) as ExecutionRequest
    const b = (await f.binding.dispatch('freezeInvocation', {
      ...invocation('candidate'),
      harnessFiles: [{ path: 'instructions.md', content: 'Changed instructions' }]
    })) as ExecutionRequest
    expect(a.taskSnapshotRef).toEqual(b.taskSnapshotRef)
    expect(a.harnessRevisionRef).not.toEqual(b.harnessRevisionRef)
    expect(a.invocationRef).not.toEqual(b.invocationRef)
    expect((await f.snapshots.resolve(a)).invocation.mission).toContain('Original method')
    expect(a.requestKey).not.toEqual(b.requestKey)
  })
  it('rejects Python-minted or mutated requests before admission', async () => {
    const f = await setup()
    const a = (await f.binding.dispatch('freezeInvocation', invocation())) as ExecutionRequest
    await expect(
      f.binding.dispatch('submit', { request: { ...a, projectId: 'another-project' } })
    ).rejects.toThrow()
    await expect(
      f.binding.dispatch('submit', { request: { ...a, requestKey: 'invented' } })
    ).rejects.toThrow()
    expect(f.binding.executionIds).toEqual([])
  })
  it('returns only fixed version files and rejects changed bytes', async () => {
    const f = await setup()
    const request = (await f.binding.dispatch(
      'freezeInvocation',
      invocation('baseline')
    )) as ExecutionRequest
    const handle = (await f.binding.dispatch('submit', { request })) as ExecutionHandle
    await expect.poll(async () => (await f.core.get(handle.executionId)).phase).toBe('completed')
    expect(
      await f.binding.dispatch('readResult', { executionId: handle.executionId })
    ).toMatchObject({ files: [{ content: 'persisted' }] })
    f.exportValue.files[0] = { ...f.exportValue.files[0], content: 'changed after commitment' }
    await expect(
      f.binding.dispatch('readResult', { executionId: handle.executionId })
    ).rejects.toThrow()
    await expect(f.binding.dispatch('get', { executionId: 'outside-scope' })).rejects.toThrow()
  })
  it.each(['../escape', '/absolute', 'context/../escape', 'context\\escape'])(
    'rejects unsafe context path %s',
    async (path) => {
      const f = await setup()
      await expect(
        f.binding.dispatch('freezeInvocation', {
          ...invocation(),
          contextFiles: [{ path, content: 'x' }]
        })
      ).rejects.toThrow()
    }
  )
  it('rejects native automatic context expansion and unsupported harness tools', async () => {
    const f = await setup()
    const encoded = (await f.binding.dispatch('freezeInvocation', {
      ...invocation(),
      contextFiles: [{ path: 'harness.diff', content: '@@ -1 +1 @@\n!`command`' }]
    })) as ExecutionRequest
    const mission = (await f.snapshots.resolve(encoded)).invocation.mission
    expect(mission).not.toContain('@')
    expect(mission).not.toContain('`')
    const evidence = mission.split('\n\n').find((part) => part.startsWith('[{'))!
    expect(JSON.parse(evidence)).toEqual([
      { path: 'harness.diff', content: '@@ -1 +1 @@\n!`command`' }
    ])
    await expect(
      f.binding.dispatch('freezeInvocation', {
        ...invocation(),
        invocation: { ...(invocation().invocation as object), mission: 'Read @/host' }
      })
    ).rejects.toThrow()
    await expect(
      f.binding.dispatch('freezeInvocation', {
        ...invocation(),
        harnessFiles: [
          { path: 'instructions.md', content: 'safe' },
          { path: 'scripts/run.py', content: 'unsafe' }
        ]
      })
    ).rejects.toThrow()
  })
  it('latches stop and does not admit queued or resumed work', async () => {
    const f = await setup()
    await f.binding.stop()
    await expect(f.binding.dispatch('freezeInvocation', invocation())).rejects.toThrow('stopped')
  })
  it('keeps Python and TS evidence/frame limits identical', () => {
    const limits = JSON.parse(
      execFileSync(
        'python3',
        [
          '-B',
          '-c',
          'import json; from harness2.core.earthnano_binding import MAX_MESSAGE_BYTES,MAX_EVIDENCE_BYTES,MAX_FILES; print(json.dumps([MAX_MESSAGE_BYTES,MAX_EVIDENCE_BYTES,MAX_FILES]))'
        ],
        { cwd: resolve('vendor/harness2'), encoding: 'utf8' }
      )
    )
    expect(limits).toEqual([
      MAX_HARNESS_FRAME_BYTES,
      MAX_HARNESS_EVIDENCE_BYTES,
      MAX_HARNESS_EVIDENCE_FILES
    ])
  })
  it('accepts a bounded role evidence package larger than the old input-file budget without clipping it', async () => {
    const f = await setup()
    const content = 'Fixed output row\n'.repeat(40000)
    const request = (await f.binding.dispatch('freezeInvocation', {
      ...invocation(),
      contextFiles: [{ path: 'deliverables/base1/result.csv', content }]
    })) as ExecutionRequest
    const resolved = await f.snapshots.resolve(request)
    expect(resolved.invocation.mission).toContain(JSON.stringify(content))
    expect(resolved.task).toEqual(input.task)
    await expect(
      f.binding.dispatch('freezeInvocation', {
        ...invocation(),
        contextFiles: [
          { path: 'oversized.txt', content: 'x'.repeat(MAX_HARNESS_EVIDENCE_BYTES + 1) }
        ]
      })
    ).rejects.toThrow()
    expect(f.binding.executionIds).toEqual([])
  })
  it('rejects an oversized unterminated stdout frame before it can dispatch anything', async () => {
    const dispatch = vi.fn(async () => undefined),
      stop = vi.fn(async () => undefined)
    await expect(
      runHarnessProcess({
        binding: { dispatch, stop },
        python: 'python3',
        args: [
          '-c',
          `import sys,time; sys.stdout.write('x'*${MAX_HARNESS_FRAME_BYTES + 1}); sys.stdout.flush(); time.sleep(2)`
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        timeoutMs: 3000
      })
    ).rejects.toThrow('did not complete')
    expect(dispatch).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalled()
  })
  it('rejects oversized responses and floods while retaining finite queued work', async () => {
    const responseDispatch = vi.fn(async () => 'x'.repeat(MAX_HARNESS_FRAME_BYTES))
    const options = {
      python: 'python3',
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      timeoutMs: 3000
    }
    const script =
      'import json,sys; print(json.dumps({"id":1,"operation":"get","executionId":"owned"}),flush=True); sys.stdin.readline()'
    await expect(
      runHarnessProcess({
        ...options,
        binding: { dispatch: responseDispatch, stop: vi.fn(async () => undefined) },
        args: ['-c', script]
      })
    ).rejects.toThrow('did not complete')
    expect(responseDispatch).toHaveBeenCalledOnce()
    const pending = vi.fn(async () => new Promise<never>(() => undefined))
    await expect(
      runHarnessProcess({
        ...options,
        binding: { dispatch: pending, stop: vi.fn(async () => undefined) },
        args: [
          '-c',
          'import json,sys; [print(json.dumps({"id":i,"operation":"get","executionId":"owned"}),flush=True) for i in range(1,5)]; sys.stdin.readline()'
        ]
      })
    ).rejects.toThrow('did not complete')
    expect(pending.mock.calls.length).toBeLessThanOrEqual(1)
  })
  it('private stdio acknowledges done and rejects malformed protocol without replay', async () => {
    const f = await setup()
    const options = {
      binding: f.binding,
      python: 'python3',
      cwd: f.root,
      env: { PATH: process.env.PATH },
      timeoutMs: 3000
    }
    await expect(
      runHarnessProcess({
        ...options,
        args: [
          '-c',
          'import json,sys; print(json.dumps({"id":1,"operation":"done","result":{"status":"ok"}}),flush=True); assert json.loads(sys.stdin.readline())["result"] is True'
        ]
      })
    ).resolves.toEqual({ status: 'ok' })
    await expect(
      runHarnessProcess({ ...options, args: ['-c', 'print("bad-json",flush=True)'] })
    ).rejects.toThrow('did not complete')
    await expect(f.binding.dispatch('freezeInvocation', invocation())).rejects.toThrow('stopped')
  })
  it('timeout stops even while a persistence dispatch is still pending', async () => {
    const f = await setup()
    let release!: (value: unknown) => void
    vi.spyOn(f.binding, 'dispatch').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const started = Date.now()
    await expect(
      runHarnessProcess({
        binding: f.binding,
        python: 'python3',
        cwd: f.root,
        env: { PATH: process.env.PATH },
        timeoutMs: 500,
        args: [
          '-c',
          'import json,sys; print(json.dumps({"id":1,"operation":"readResult","executionId":"pending"}),flush=True); sys.stdin.readline()'
        ]
      })
    ).rejects.toThrow('did not complete')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(f.binding.dispatch).toHaveBeenCalledOnce()
    release?.({ ignored: true })
  })
  it.each([0, -1, 1.5, NaN, Infinity, MAX_TIMER_TIMEOUT_MS + 1, Number.MAX_SAFE_INTEGER])(
    'rejects invalid process deadline %s before spawning or stopping any execution',
    async (timeoutMs) => {
      const f = await setup()
      const stop = vi.spyOn(f.binding, 'stop')
      await expect(
        runHarnessProcess({
          binding: f.binding,
          python: '/nonexistent-executable-must-not-spawn',
          args: [],
          cwd: f.root,
          env: {},
          timeoutMs
        })
      ).rejects.toThrow('Invalid optimization timeout')
      expect(stop).not.toHaveBeenCalled()
      expect(f.binding.executionIds).toEqual([])
    }
  )
  it('rejects an overflowing standalone factory deadline before freezing inputs', async () => {
    const f = await setup()
    const freeze = vi.spyOn(f.snapshots, 'freeze')
    expect(
      () =>
        new HarnessOptimizationBinding({
          core: f.core,
          snapshots: f.snapshots,
          input,
          projectId: 'project',
          optimizationId: 'optimization',
          taskId: 't1',
          budgetRef: 'budget',
          timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
          exportResult: async () => f.exportValue
        })
    ).toThrow('Invalid optimization timeout')
    expect(freeze).not.toHaveBeenCalled()
  })
})

describe('host-fixed scientific Harness capabilities', () => {
  const scientific = (): CandidateSnapshotInput => ({
    ...input,
    task: {
      prompt: 'Compute the original CSV mean in Notebook.',
      files: [],
      managedInputs: [
        {
          sourceKind: 'upload-version',
          sourceProjectId: 'project',
          sourceSessionId: 'source-session',
          sourceFileId: 'upload',
          inputFileVersionId: 'old-version',
          filename: 'values.csv',
          sizeBytes: 12,
          checksum: 'a'.repeat(64)
        }
      ]
    },
    harness: { ...input.harness, tools: 'notebook-python' },
    environment: {
      isolation: 'directory-process',
      network: 'provider-and-notebook-policy',
      notebook: {
        runtime: {
          language: 'python',
          runtimeId: '/original/python',
          interpreterPath: '/original/python',
          source: 'external',
          provenance: 'user-own'
        }
      }
    }
  })
  it('retains one fixed task/runtime and the scientific profile through candidate harness edits', async () => {
    const source = scientific(),
      f = await setup(source)
    const baseline = (await f.binding.dispatch(
      'freezeInvocation',
      invocation('baseline')
    )) as ExecutionRequest
    const candidate = (await f.binding.dispatch('freezeInvocation', {
      ...invocation('candidate'),
      harnessFiles: [{ path: 'instructions.md', content: 'Revised guidance' }],
      // Untrusted local fields cannot replace the host capabilities or sources.
      environment: { notebook: { runtime: { runtimeId: '/attacker/python' } } },
      task: { managedInputs: [] },
      tools: 'arbitrary-shell'
    })) as ExecutionRequest
    const resolved = await f.snapshots.resolve(candidate)
    expect(candidate.taskSnapshotRef).toEqual(baseline.taskSnapshotRef)
    expect(candidate.environmentSpecRef).toEqual(baseline.environmentSpecRef)
    expect(resolved.harness).toMatchObject({
      tools: 'notebook-python',
      instructions: 'Revised guidance'
    })
    expect(resolved.environment).toEqual(source.environment)
    expect(resolved.task).toEqual(source.task)
    expect(resolved.invocation.mission).toContain(
      'Publish task deliverables using the original Artifact tools'
    )
  })
  it('rejects a foreign source Project before freezing or admitting scientific work', async () => {
    const source = scientific()
    Object.assign(source.task.managedInputs![0]!, { sourceProjectId: 'another-project' })
    const f = await setup(source)
    const freeze = vi.spyOn(f.snapshots, 'freeze')
    await expect(f.binding.dispatch('freezeInvocation', invocation('baseline'))).rejects.toThrow()
    expect(freeze).not.toHaveBeenCalled()
    expect(f.binding.executionIds).toEqual([])
  })
  it.each(['proposer', 'composer', 'selector', 'reflection'])(
    'keeps %s textual despite the scientific source profile',
    async (role) => {
      const source = scientific(),
        f = await setup(source)
      const request = (await f.binding.dispatch(
        'freezeInvocation',
        invocation(role)
      )) as ExecutionRequest
      const resolved = await f.snapshots.resolve(request)
      expect(resolved.harness.tools).toBe('workspace-only')
      expect(resolved.environment).toEqual(input.environment)
      expect(resolved.task).toEqual(source.task)
      expect(resolved.invocation.mission).not.toContain(
        'Publish task deliverables using the original Artifact tools'
      )
    }
  )
})
