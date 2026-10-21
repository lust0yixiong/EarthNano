import { notebookToolsForLanguage } from '../../shared/earthnano/notebook-profile'
import type { CandidateBinaryArtifactFile } from '../../shared/earthnano/candidate-artifact'
import type { NotebookLanguage } from '../../shared/notebook-language-contract'
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
  type PersistentExecutionExport,
  type HarnessOptimizationBindingOptions
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
  sourceInput: CandidateSnapshotInput = input,
  materializeArtifact?: HarnessOptimizationBindingOptions['materializeArtifact']
): Promise<{
  root: string
  binding: HarnessOptimizationBinding
  snapshots: CandidateSnapshotStore
  core: ExecutionCore
  exportValue: PersistentExecutionExport
  readState(): ReturnType<typeof emptyExecutionState>
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
    exportResult: async (record) => ({ ...exportValue, executionId: record.executionId }),
    materializeArtifact
  })
  return { root, binding, snapshots, core, exportValue, readState: () => structuredClone(state) }
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
    expect(resolved.invocation.mission).toContain('selector-reply.md')
    expect(resolved.invocation.mission).not.toContain('OUTPUT/selection.md')
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
  const scientific = (language: NotebookLanguage = 'python'): CandidateSnapshotInput => ({
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
    harness: { ...input.harness, tools: notebookToolsForLanguage(language) },
    environment: {
      isolation: 'directory-process',
      network: 'provider-and-notebook-policy',
      notebook: {
        runtime: {
          language,
          runtimeId: `/original/${language}`,
          interpreterPath: `/original/${language}`,
          source: 'external',
          provenance: 'user-own'
        }
      }
    }
  })
  it.each(['python', 'r'] as const)(
    'retains the fixed %s task/runtime through candidate harness edits',
    async (language) => {
      const source = scientific(language),
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
        tools: notebookToolsForLanguage(language),
        instructions: 'Revised guidance'
      })
      expect(resolved.environment).toEqual(source.environment)
      expect(resolved.task).toEqual(source.task)
      expect(resolved.invocation.mission).toContain(
        'Publish task deliverables using the original Artifact tools'
      )
    }
  )
  it('preserves the pre-R Python invocation receipt exactly', async () => {
    const f = await setup(scientific())
    const request = (await f.binding.dispatch(
      'freezeInvocation',
      invocation('baseline')
    )) as ExecutionRequest
    // Receipt captured on da658402e before the method lane changes (see retained red log).
    expect(request.invocationRef?.digest).toBe(
      'sha256:6dce830906359faf48bf62a40c8e2405f1bb5551c262d0147f58530c4f32695f'
    )
  })
  it('refuses completed scientific replay when source version, byte digest or input order really changes', async () => {
    const base = scientific()
    const source: CandidateSnapshotInput = {
      ...base,
      task: {
        ...base.task,
        managedInputs: [
          base.task.managedInputs![0],
          {
            ...base.task.managedInputs![0],
            sourceFileId: 'second-upload',
            inputFileVersionId: 'second-version',
            filename: 'second.csv'
          }
        ]
      }
    }
    const f = await setup(source)
    const original = (await f.binding.dispatch(
      'freezeInvocation',
      invocation('baseline')
    )) as ExecutionRequest
    const handle = (await f.binding.dispatch('submit', { request: original })) as ExecutionHandle
    await expect.poll(async () => (await f.core.get(handle.executionId)).phase).toBe('completed')
    const record = await f.core.get(handle.executionId)
    const { outputDigest, canonicalOutput } = await import('./output-checks')
    const resume = (value: CandidateSnapshotInput): HarnessOptimizationBinding =>
      new HarnessOptimizationBinding({
        core: f.core,
        snapshots: f.snapshots,
        input: value,
        projectId: original.projectId,
        optimizationId: original.origin.optimizationId!,
        taskId: 't1',
        budgetRef: original.budgetRef,
        timeoutMs: original.timeoutMs,
        resumeRecords: [record],
        resumeSlot: () => outputDigest(['baseline', 'inv1', 'inv1.a1', 1]),
        exportResult: async (entry) => ({ ...f.exportValue, executionId: entry.executionId })
      })
    const keyReordered = JSON.parse(canonicalOutput(source)) as CandidateSnapshotInput
    expect(await resume(keyReordered).dispatch('freezeInvocation', invocation('baseline'))).toEqual(
      original
    )
    for (const change of ['version', 'bytes', 'order']) {
      const inputs = source.task.managedInputs!.map((entry) => ({ ...entry }))
      if (change === 'version') inputs[0].inputFileVersionId = 'new-version'
      if (change === 'bytes') inputs[0].checksum = 'b'.repeat(64)
      if (change === 'order') inputs.reverse()
      const changed: CandidateSnapshotInput = {
        ...source,
        task: { ...source.task, managedInputs: inputs }
      }
      await expect(
        resume(changed).dispatch('freezeInvocation', invocation('baseline'))
      ).rejects.toThrow('identity changed')
    }
    expect(
      (await resume(source).dispatch(
        'freezeInvocation',
        invocation('baseline')
      )) as ExecutionRequest
    ).toEqual(original)
  })
  it('reopens only the exact completed R stage and refuses changed language or runtime without another admission', async () => {
    const originalInput = scientific('r'),
      f = await setup(originalInput)
    const original = (await f.binding.dispatch(
      'freezeInvocation',
      invocation('baseline')
    )) as ExecutionRequest
    const handle = (await f.binding.dispatch('submit', { request: original })) as ExecutionHandle
    await expect.poll(async () => (await f.core.get(handle.executionId)).phase).toBe('completed')
    const record = await f.core.get(handle.executionId)
    const { outputDigest } = await import('./output-checks')
    const resumed = (source: CandidateSnapshotInput): HarnessOptimizationBinding =>
      new HarnessOptimizationBinding({
        core: f.core,
        snapshots: f.snapshots,
        input: source,
        projectId: 'project',
        optimizationId: original.origin.optimizationId!,
        taskId: 't1',
        budgetRef: original.budgetRef,
        timeoutMs: original.timeoutMs,
        resumeRecords: [record],
        resumeSlot: () => outputDigest(['baseline', 'inv1', 'inv1.a1', 1]),
        exportResult: async (entry) => ({ ...f.exportValue, executionId: entry.executionId })
      })
    const exact = resumed(structuredClone(originalInput))
    expect(await exact.dispatch('freezeInvocation', invocation('baseline'))).toEqual(original)
    expect(
      ((await exact.dispatch('submit', { request: original })) as ExecutionHandle).executionId
    ).toBe(handle.executionId)
    for (const source of [
      scientific('python'),
      {
        ...originalInput,
        environment: {
          ...originalInput.environment,
          notebook: {
            runtime: {
              ...originalInput.environment.notebook!.runtime,
              runtimeId: '/other/r',
              interpreterPath: '/other/r'
            }
          }
        }
      }
    ])
      await expect(
        resumed(source).dispatch('freezeInvocation', invocation('baseline'))
      ).rejects.toThrow('identity changed')
    const wrong = {
      ...originalInput,
      environment: {
        ...originalInput.environment,
        notebook: {
          runtime: { ...originalInput.environment.notebook!.runtime, language: 'python' as const }
        }
      }
    }
    await expect(
      resumed(wrong).dispatch('freezeInvocation', invocation('baseline'))
    ).rejects.toThrow('language mismatch')
    expect(f.binding.executionIds).toEqual([handle.executionId])
    expect(Object.values(f.readState().budgets)[0]!.admitted).toBe(1)
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
  it.each(
    (['python', 'r'] as const).flatMap((language) =>
      ['proposer', 'composer', 'selector', 'reflection'].map((role) => ({ language, role }))
    )
  )('keeps $role textual despite the $language source profile', async ({ language, role }) => {
    const source = scientific(language),
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
  })
})

it.each(['proposer', 'composer', 'selector', 'reflection'])(
  'keeps empty-input Compute source identity through %s without granting Compute to method roles',
  async (role) => {
    const source: CandidateSnapshotInput = {
      ...structuredClone(input),
      task: { prompt: 'Original Compute task', files: [], managedInputs: [] },
      harness: { ...input.harness, tools: 'notebook-compute' },
      environment: {
        isolation: 'directory-process',
        network: 'provider-and-notebook-policy',
        compute: {
          sourceProjectId: 'project',
          sourceSessionId: 'compute-source',
          access: { enabledProviderIds: [], selectedProviderIds: [] },
          hosts: []
        }
      }
    }
    const f = await setup(source)
    const baseline = (await f.binding.dispatch(
      'freezeInvocation',
      invocation('baseline')
    )) as ExecutionRequest
    const candidate = (await f.binding.dispatch(
      'freezeInvocation',
      invocation('candidate')
    )) as ExecutionRequest
    expect(candidate.taskSnapshotRef).toEqual(baseline.taskSnapshotRef)
    expect(candidate.environmentSpecRef).toEqual(baseline.environmentSpecRef)
    expect((await f.snapshots.resolve(candidate)).task).toEqual(source.task)
    for (const request of [baseline, candidate])
      expect(request.origin.sessionId).toBe('compute-source')
    const method = (await f.binding.dispatch(
      'freezeInvocation',
      invocation(role)
    )) as ExecutionRequest
    const resolved = await f.snapshots.resolve(method)
    expect(method.origin.sessionId).toBe('compute-source')
    expect(resolved.task).toEqual({ prompt: source.task.prompt, files: [] })
    expect(resolved.environment).toEqual(input.environment)
    expect(resolved.harness.tools).toBe('workspace-only')
  }
)

it('reuses only the exact completed original stage and refuses changed task or role context before replay', async () => {
  const f = await setup()
  const original = (await f.binding.dispatch(
    'freezeInvocation',
    invocation('baseline')
  )) as ExecutionRequest
  const handle = (await f.binding.dispatch('submit', { request: original })) as ExecutionHandle
  await expect.poll(async () => (await f.core.get(handle.executionId)).phase).toBe('completed')
  const record = await f.core.get(handle.executionId)
  const { outputDigest } = await import('./output-checks')
  const slot = outputDigest(['baseline', 'inv1', 'inv1.a1', 1])
  const resumed = (source = input): HarnessOptimizationBinding =>
    new HarnessOptimizationBinding({
      core: f.core,
      snapshots: f.snapshots,
      input: source,
      projectId: original.projectId,
      optimizationId: original.origin.optimizationId!,
      taskId: 't1',
      budgetRef: original.budgetRef,
      timeoutMs: original.timeoutMs,
      resumeRecords: [record],
      resumeSlot: () => slot,
      exportResult: async (value) => ({ ...f.exportValue, executionId: value.executionId })
    })
  const binding = resumed()
  const reused = (await binding.dispatch(
    'freezeInvocation',
    invocation('baseline')
  )) as ExecutionRequest
  expect(reused).toEqual(original)
  expect(await binding.dispatch('submit', { request: reused })).toEqual({
    ...handle,
    phase: 'completed'
  })
  expect(await binding.dispatch('readResult', { executionId: handle.executionId })).toMatchObject({
    reused: true
  })
  expect(binding.executionIds).toEqual([handle.executionId])
  await expect(
    resumed({ ...input, task: { ...input.task, prompt: 'Changed scientific task' } }).dispatch(
      'freezeInvocation',
      invocation('baseline')
    )
  ).rejects.toThrow('identity changed')
  await expect(
    resumed().dispatch('freezeInvocation', {
      ...invocation('baseline'),
      contextFiles: [{ path: 'context/harness/instructions.md', content: 'Changed evidence' }]
    })
  ).rejects.toThrow('identity changed')
  await expect(
    binding.dispatch('submit', { request: { ...reused, role: 'candidate' } })
  ).rejects.toThrow()
})

describe('version-backed binary binding', () => {
  const binary = (f: Awaited<ReturnType<typeof setup>>): CandidateBinaryArtifactFile => {
    const checksum = createHash('sha256')
      .update(Buffer.from([137, 80, 78, 71, 0, 255]))
      .digest('hex')
    f.exportValue.artifacts[0]!.checksum = checksum
    const file = {
      path: 'plots/figure.png',
      representation: 'binary' as const,
      sizeBytes: 6,
      contentType: 'image/png',
      digest: `sha256:${checksum}`,
      artifactRef: f.exportValue.artifacts[0]!
    }
    f.exportValue.files = [file]
    return file
  }
  const admitted = async (
    f: Awaited<ReturnType<typeof setup>>,
    role = 'baseline'
  ): Promise<string> => {
    const request = (await f.binding.dispatch(
      'freezeInvocation',
      invocation(role)
    )) as ExecutionRequest
    const handle = (await f.binding.dispatch('submit', { request })) as ExecutionHandle
    await expect.poll(async () => (await f.core.get(handle.executionId)).phase).toBe('completed')
    return handle.executionId
  }
  it('preserves descriptors and materializes only the admitted completed original reference', async () => {
    const materialize =
      vi.fn<NonNullable<HarnessOptimizationBindingOptions['materializeArtifact']>>()
    const f = await setup(input, materialize)
    const file = binary(f)
    materialize.mockResolvedValue({ file, assetPath: '/isolated/opaque.png' })
    const executionId = await admitted(f)
    expect(
      ((await f.binding.dispatch('readResult', { executionId })) as PersistentExecutionExport).files
    ).toEqual([file])
    expect(
      await f.binding.dispatch('materializeArtifact', {
        executionId,
        artifactRef: file.artifactRef
      })
    ).toEqual({ file, assetPath: '/isolated/opaque.png' })
    expect(materialize.mock.calls[0]![0].executionId).toBe(executionId)
    expect(materialize.mock.calls[0]![2]?.aborted).toBe(false)
    for (const args of [
      { executionId: 'foreign', artifactRef: file.artifactRef },
      { executionId, artifactRef: { ...file.artifactRef, versionId: 'different' } },
      { executionId, artifactRef: file.artifactRef, targetPath: '/chosen/by/caller' }
    ])
      await expect(f.binding.dispatch('materializeArtifact', args)).rejects.toThrow()
    expect(materialize).toHaveBeenCalledTimes(1)
    materialize.mockResolvedValue({
      file: { ...file, sizeBytes: 7 },
      assetPath: '/isolated/wrong.png'
    })
    await expect(
      f.binding.dispatch('materializeArtifact', { executionId, artifactRef: file.artifactRef })
    ).rejects.toThrow()
  })
  it.each([false, true])(
    'separates the original JSONL envelope while preserving binary payload validation (extra=%s)',
    async (extra) => {
      const materialize =
        vi.fn<NonNullable<HarnessOptimizationBindingOptions['materializeArtifact']>>()
      const f = await setup(input, materialize)
      const file = binary(f)
      const result = { file, assetPath: '/isolated/opaque.png' }
      materialize.mockResolvedValue(result)
      const executionId = await admitted(f)
      const operation = runHarnessProcess({
        binding: f.binding,
        python: 'python3',
        cwd: resolve('vendor/harness2'),
        env: { PATH: process.env.PATH },
        timeoutMs: 3000,
        args: [
          '-c',
          [
            'import json, sys',
            'from harness2.core.earthnano_binding import JsonLineClient',
            'client = JsonLineClient(sys.stdin, sys.stdout)',
            'result = client.exchange("materializeArtifact", **json.loads(sys.argv[1]))',
            'client.exchange("done", result=result)'
          ].join('\n'),
          JSON.stringify({
            executionId,
            artifactRef: file.artifactRef,
            ...(extra ? { targetPath: '/chosen/by/caller' } : {})
          })
        ]
      })
      if (extra) {
        await expect(operation).rejects.toThrow('did not complete')
        expect(materialize).not.toHaveBeenCalled()
      } else {
        await expect(operation).resolves.toEqual(result)
        expect(materialize).toHaveBeenCalledOnce()
        expect(materialize.mock.calls[0]![0].executionId).toBe(executionId)
        expect(materialize.mock.calls[0]![1]).toEqual(file.artifactRef)
      }
    }
  )
  it('refuses a role reply artifact as a scientific asset and rejects unknown context sources', async () => {
    const materialize = vi.fn()
    const f = await setup(input, materialize)
    const file = binary(f)
    const executionId = await admitted(f, 'proposer')
    await expect(
      f.binding.dispatch('materializeArtifact', { executionId, artifactRef: file.artifactRef })
    ).rejects.toThrow()
    await expect(
      f.binding.dispatch('freezeInvocation', {
        ...invocation('selector'),
        assets: [
          { path: 'candidates/A/opaque.png', sourceExecutionId: executionId, artifact: file }
        ]
      })
    ).rejects.toThrow()
    await expect(
      f.binding.dispatch('freezeInvocation', {
        ...invocation('selector'),
        assets: [
          { path: 'candidates/A/opaque.png', sourceExecutionId: 'another-task', artifact: file }
        ]
      })
    ).rejects.toThrow()
    expect(materialize).not.toHaveBeenCalled()
  })
  it('binds assets to invocation identity while keeping private source identities out of the mission', async () => {
    const f = await setup()
    const file = binary(f)
    const executionId = await admitted(f)
    const asset = {
      path: 'candidates/A/opaque.png',
      sourceExecutionId: executionId,
      artifact: file
    }
    const request = (await f.binding.dispatch('freezeInvocation', {
      ...invocation('selector'),
      assets: [asset]
    })) as ExecutionRequest
    const frozen = await f.snapshots.resolve(request)
    expect(frozen.invocation.assets).toEqual([asset])
    expect(frozen.invocation.mission).toContain('actual binary bytes')
    expect(frozen.invocation.mission).not.toContain(executionId)
    expect(frozen.invocation.mission).not.toContain(file.artifactRef.artifactId)
    expect(frozen.invocation.mission).not.toContain(file.artifactRef.checksum)
    for (const changed of [
      { ...asset, artifact: { ...file, sizeBytes: 7 } },
      { ...asset, path: 'context/harness/instructions.md' },
      { ...asset, artifact: { ...file, content: 'fake PNG text' } }
    ])
      await expect(
        f.binding.dispatch('freezeInvocation', { ...invocation('selector'), assets: [changed] })
      ).rejects.toThrow()
  })
  it('aborts host materialization on stop and never returns a stopped asset', async () => {
    let entered!: () => void
    const pending = new Promise<void>((resolve) => {
      entered = resolve
    })
    const materialize = vi.fn<
      NonNullable<HarnessOptimizationBindingOptions['materializeArtifact']>
    >(async (_record, _ref, signal) => {
      entered()
      await new Promise<void>((resolve) =>
        signal!.addEventListener('abort', () => resolve(), { once: true })
      )
      return { file, assetPath: '/isolated/opaque.png' }
    })
    const f = await setup(input, materialize)
    const file = binary(f)
    const executionId = await admitted(f)
    const operation = f.binding.dispatch('materializeArtifact', {
      executionId,
      artifactRef: file.artifactRef
    })
    const rejected = expect(operation).rejects.toThrow('stopped')
    await pending
    await f.binding.stop()
    await rejected
    expect(materialize.mock.calls[0]![2]!.aborted).toBe(true)
  })
  it('reuses the exact binary selector invocation and rejects another admitted source without replay', async () => {
    const f = await setup()
    const file = binary(f)
    const firstId = await admitted(f)
    const otherArgs = invocation('baseline')
    Object.assign(otherArgs.invocation as Record<string, unknown>, {
      label: 'other-baseline',
      stageLabel: 'other-baseline'
    })
    const otherRequest = (await f.binding.dispatch(
      'freezeInvocation',
      otherArgs
    )) as ExecutionRequest
    const other = (await f.binding.dispatch('submit', { request: otherRequest })) as ExecutionHandle
    await expect.poll(async () => (await f.core.get(other.executionId)).phase).toBe('completed')
    const asset = { path: 'candidates/A/opaque.png', sourceExecutionId: firstId, artifact: file }
    const offered = { ...invocation('selector'), assets: [asset] }
    const selected = (await f.binding.dispatch('freezeInvocation', offered)) as ExecutionRequest
    const handle = (await f.binding.dispatch('submit', { request: selected })) as ExecutionHandle
    await expect.poll(async () => (await f.core.get(handle.executionId)).phase).toBe('completed')
    const records = await Promise.all(
      [firstId, other.executionId, handle.executionId].map((id) => f.core.get(id))
    )
    const { outputDigest } = await import('./output-checks')
    const slots = new Map(
      records.map((record) => [
        record.requestKey,
        outputDigest([
          record.request.role,
          record.request.origin.stageId,
          record.executionId === other.executionId ? 'other-baseline' : 'inv1.a1',
          1
        ])
      ])
    )
    const resumed = new HarnessOptimizationBinding({
      core: f.core,
      snapshots: f.snapshots,
      input,
      projectId: selected.projectId,
      optimizationId: selected.origin.optimizationId!,
      taskId: 't1',
      budgetRef: selected.budgetRef,
      timeoutMs: selected.timeoutMs,
      resumeRecords: records,
      resumeSlot: (key) => slots.get(key),
      exportResult: async (record) => ({ ...f.exportValue, executionId: record.executionId })
    })
    expect(await resumed.dispatch('freezeInvocation', offered)).toEqual(selected)
    const before = f.readState()
    await expect(
      resumed.dispatch('freezeInvocation', {
        ...offered,
        assets: [{ ...asset, sourceExecutionId: other.executionId }]
      })
    ).rejects.toThrow('identity changed')
    expect(f.readState()).toEqual(before)
  })
})
