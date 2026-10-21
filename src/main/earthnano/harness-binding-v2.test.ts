import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HARNESS_BINDING_V2,
  assertHarnessBindingV2Identity,
  createHarnessBindingV2Identity,
  harnessBindingV2Slot,
  type HarnessBindingV2Identity
} from './harness-binding-v2'
import { outputDigest } from './output-checks'

const identity = (): Readonly<HarnessBindingV2Identity> =>
  createHarnessBindingV2Identity({ k: 2, seed: null, modes: ['agg', 'seq'] })
const invocation = (): {
  taskId: string
  scope: string
  role: string
  stageLabel: string
  label: string
  attempt: number
} => ({
  taskId: 'source-task',
  scope: identity().modeScopes.seq!,
  role: 'proposer',
  stageLabel: 'inv1',
  label: 'inv1.a1',
  attempt: 1
})
describe('inactive v2 namespace/slot identity', () => {
  it('pins an explicit immutable version and refuses missing/v1 identities rather than migrating slots', () => {
    const value = identity()
    expect(value.bindingProfile).toBe(HARNESS_BINDING_V2)
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.modes)).toBe(true)
    expect(Object.isFrozen(value.modeScopes)).toBe(true)
    expect(() =>
      assertHarnessBindingV2Identity(value, JSON.parse(JSON.stringify(value)))
    ).not.toThrow()
    for (const prior of [
      undefined,
      null,
      {},
      { schemaVersion: 1 },
      outputDigest(['proposer', 'inv1', 'inv1.a1', 1])
    ])
      expect(() => assertHarnessBindingV2Identity(value, prior)).toThrow('paid replay refused')
    expect(harnessBindingV2Slot(value, 'source-task', invocation())).toMatch(
      /^earthnano-harness-binding-v2:sha256:[a-f0-9]{64}$/
    )
  })
  it('refuses altered descriptor settings, forged digests and foreign fields', () => {
    const value = identity()
    for (const changed of [
      { ...value, k: 3 },
      { ...value, seed: 0 },
      { ...value, modes: ['seq'] },
      { ...value, bindingProfile: 'v1' },
      { ...value, digest: `sha256:${'0'.repeat(64)}` },
      { ...value, baseScope: 'foreign' },
      { ...value, modeScopes: { seq: 'foreign' } },
      { ...value, extra: true }
    ])
      expect(() => assertHarnessBindingV2Identity(value, changed)).toThrow('paid replay refused')
    expect(() => assertHarnessBindingV2Identity({ ...value, k: 3 }, value)).toThrow()
  })
  it('requires original canonical mode tokens and bounded current profile settings', () => {
    for (const options of [
      { k: 0, seed: null, modes: ['agg'] },
      { k: 9, seed: null, modes: ['agg'] },
      { k: 2, seed: 0.5, modes: ['agg'] },
      { k: 2, seed: undefined, modes: ['agg'] },
      { k: 2, seed: null, modes: [] },
      { k: 2, seed: null, modes: ['agg', 'agg'] },
      { k: 2, seed: null, modes: ['seq', 'agg'] },
      { k: 2, seed: null, modes: ['parallel'] },
      { k: 2, seed: null, modes: ['foreign'] },
      { k: 2, seed: null, modes: ['agg'], tag: 'new' }
    ])
      expect(() =>
        createHarnessBindingV2Identity(
          options as Parameters<typeof createHarnessBindingV2Identity>[0]
        )
      ).toThrow()
  })
  it('separates exact task, scope, role and retry slots without accepting a foreign registration', () => {
    const value = identity(),
      original = invocation()
    const slot = harnessBindingV2Slot(value, original.taskId, original)
    for (const changed of [
      { ...original, scope: value.modeScopes.agg },
      { ...original, role: 'composer' },
      { ...original, stageLabel: 'inv2' },
      { ...original, label: 'inv1.a2' },
      { ...original, attempt: 2 }
    ])
      expect(harnessBindingV2Slot(value, original.taskId, changed)).not.toBe(slot)
    expect(
      harnessBindingV2Slot(value, 'another-task', { ...original, taskId: 'another-task' })
    ).not.toBe(slot)
    for (const changed of [
      { ...original, taskId: 'another-task' },
      { ...original, scope: 'earthnano-claude-text-seq3' },
      { ...original, scope: value.modeScopes.seq + '-s0' },
      { ...original, scope: '../seq2' },
      { ...original, role: 'reviewer' },
      { ...original, attempt: 0 },
      { ...original, attempt: 1.5 },
      { ...original, label: '' },
      { ...original, stageLabel: '\0' },
      { ...original, untrusted: true }
    ])
      expect(() => harnessBindingV2Slot(value, original.taskId, changed)).toThrow()
  })
  it('shares the original agg baseline namespace without authorizing a disabled agg candidate mode', () => {
    const value = createHarnessBindingV2Identity({ k: 2, seed: null, modes: ['seq'] })
    const baseline = {
      ...invocation(),
      role: 'baseline',
      scope: value.baseScope,
      label: 'base1',
      stageLabel: 'base1'
    }
    expect(() => harnessBindingV2Slot(value, baseline.taskId, baseline)).not.toThrow()
    expect(() =>
      harnessBindingV2Slot(value, baseline.taskId, { ...baseline, role: 'candidate' })
    ).toThrow()
    expect(() =>
      harnessBindingV2Slot(value, baseline.taskId, { ...baseline, scope: value.modeScopes.seq })
    ).toThrow()
  })
  it('preserves identity/slots under JSON key reordering while refusing changed seed/modes', () => {
    const value = identity(),
      offered = invocation()
    const reordered = Object.fromEntries(
      Object.entries(JSON.parse(JSON.stringify(value))).reverse()
    )
    expect(() => assertHarnessBindingV2Identity(value, reordered)).not.toThrow()
    expect(
      harnessBindingV2Slot(
        value,
        offered.taskId,
        Object.fromEntries(Object.entries(offered).reverse())
      )
    ).toBe(harnessBindingV2Slot(value, offered.taskId, offered))
    for (const options of [
      { k: 2, seed: 0, modes: ['agg', 'seq'] as const },
      { k: 2, seed: null, modes: ['seq'] as const }
    ])
      expect(() =>
        assertHarnessBindingV2Identity(value, createHarnessBindingV2Identity(options))
      ).toThrow()
  })
  // Original schedule._write_summary requires POSIX fcntl. Keep the original constraint;
  // the other identity tests remain platform-neutral and no fake lock is installed here.
  it.skipIf(process.platform === 'win32')(
    'uses collision-free slots for actual original two-mode shared-base transcripts',
    () => {
      const root = resolve('vendor/harness2')
      const reports = JSON.parse(
        execFileSync(
          'python3',
          ['-B', resolve(root, 'tests/test_earthnano_sweep_binding_v2.py'), '--transcript'],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              PYTHONPATH: root,
              PYTHONDONTWRITEBYTECODE: '1',
              PYTHONNOUSERSITE: '1'
            },
            encoding: 'utf8',
            timeout: 15_000,
            maxBuffer: 1024 * 1024
          }
        )
      ) as Array<{
        originalCommit: string
        originalScheduleSha256: string
        seed: number | null
        k: number
        modes: ['agg', 'seq']
        baseScope: string
        modeScopes: { agg: string; seq: string }
        roleCounts: Record<string, number>
        originalRolloutCount: number
        invocations: Array<ReturnType<typeof invocation>>
      }>
      expect(reports.map((report) => report.seed)).toEqual([null, 0, -7])
      for (const report of reports) {
        const value = createHarnessBindingV2Identity({
          k: report.k,
          seed: report.seed,
          modes: report.modes
        })
        expect(report.originalCommit).toBe('1cfe254e8d25b15f37048c3730134686abe60335')
        expect(report.originalScheduleSha256).toBe(
          '6e46c5ab1e4ac111818ff3acd6b636e39d650898189ac0c21802a8233ad4cd38'
        )
        expect(value.baseScope).toBe(report.baseScope)
        expect(value.modeScopes).toEqual(report.modeScopes)
        expect(report.roleCounts).toEqual({
          baseline: 2,
          candidate: 12,
          proposer: 8,
          composer: 4,
          selector: 2
        })
        expect(report.originalRolloutCount).toBe(14)
        const slots = report.invocations.map((entry) =>
          harnessBindingV2Slot(value, entry.taskId, entry)
        )
        expect(new Set(slots).size).toBe(28)
        const v1 = report.invocations.map((entry) =>
          outputDigest([entry.role, entry.stageLabel, entry.label, entry.attempt])
        )
        expect(new Set(v1).size).toBeLessThan(slots.length)
      }
    }
  )
})
