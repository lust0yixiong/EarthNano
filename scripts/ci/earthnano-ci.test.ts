import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { compareHarnessReports } from './earthnano-harness-compare.mjs'
import {
  compareInventories,
  compareReports,
  exactElectronVersion,
  normalizeVitest,
  validateSourceExecution,
  HARNESS_PIN,
  HARNESS_TREE,
  OPEN_SCIENCE_PIN,
  verifyPins
} from './earthnano-source.mjs'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const test = (id: string, status = 'passed'): { id: string; status: string } => ({ id, status })
const rawReport = (root = '/source', failed = false): Record<string, unknown> => ({
  numTotalTests: 1,
  numPassedTests: failed ? 0 : 1,
  numFailedTests: failed ? 1 : 0,
  numPendingTests: 0,
  numTodoTests: 0,
  numTotalTestSuites: 1,
  numPassedTestSuites: failed ? 0 : 1,
  numFailedTestSuites: failed ? 1 : 0,
  numPendingTestSuites: 0,
  success: !failed,
  testResults: [
    {
      name: `${root}/src/foo.test.ts`,
      status: failed ? 'failed' : 'passed',
      message: '',
      assertionResults: [{ fullName: 'case', status: failed ? 'failed' : 'passed' }]
    }
  ]
})
const stages = (failed = false): Array<{ name: string; status: number; signal: null }> =>
  ['npm-ci', 'pretest', 'typecheck', 'tests'].map((name) => ({
    name,
    status: name === 'tests' && failed ? 1 : 0,
    signal: null
  }))
describe('EarthNano original-baseline gates', () => {
  it('requires the actual exact Electron binary; cached43.4 is not lock43.7.5', () => {
    const lock = { packages: { 'node_modules/electron': { version: '43.7.5' } } }
    expect(exactElectronVersion(lock, { version: '43.7.5' }, '43.7.5\n')).toBe('43.7.5')
    expect(() => exactElectronVersion(lock, { version: '43.7.5' }, '43.4.0\n')).toThrow(
      'Electron identity mismatch'
    )
    expect(() => exactElectronVersion(lock, { version: '43.4.0' }, '43.7.5\n')).toThrow()
    expect(() => exactElectronVersion({}, { version: '43.7.5' }, '43.7.5')).toThrow()
    expect(() => exactElectronVersion(lock, { version: '43.7.5' }, '43.7.5', 1)).toThrow()
  })
  it('retains baseline failures/skips separately and fails newly failed, skipped or removed assertions', () => {
    const result = compareInventories(
      [
        test('okay'),
        test('existing-failure', 'failed'),
        test('existing-skip', 'pending'),
        test('removed')
      ],
      [
        test('okay', 'pending'),
        test('existing-failure', 'failed'),
        test('existing-skip', 'pending'),
        test('added-failure', 'failed'),
        test('new-not-run', 'pending')
      ]
    )
    expect(result.baselineFailures).toEqual([test('existing-failure', 'failed')])
    expect(result.baselineSkips).toEqual([test('existing-skip', 'pending')])
    expect(result.regressions).toEqual(
      expect.arrayContaining([
        { id: 'okay', reason: 'passed-to-pending' },
        { id: 'removed', reason: 'baseline-test-missing' },
        { id: 'added-failure', reason: 'new-failure' }
      ])
    )
    expect(result.newSkips).toEqual([test('new-not-run', 'pending')])
    expect(result.regressions.some((entry) => entry.id === 'new-not-run')).toBe(false)
    expect(result.conclusion).toBe('new-regressions')
    expect(
      compareInventories([test('old', 'failed')], [test('old', 'failed'), test('new')])
    ).toMatchObject({ conclusion: 'no-new-regressions', counts: { added: 1 } })
  })
  it('normalizes full assertion identities including same-name parameter cases and rejects partial discovery', () => {
    const report = {
      ...rawReport(),
      numTotalTests: 2,
      numPassedTests: 2,
      testResults: [
        {
          name: '/source/src/foo.test.ts',
          status: 'passed',
          assertionResults: [
            { fullName: 'case', status: 'passed' },
            { fullName: 'case', status: 'passed' }
          ]
        }
      ]
    }
    expect(normalizeVitest(report, '/source').map((entry) => entry.id)).toEqual([
      'src/foo.test.ts :: case :: 0',
      'src/foo.test.ts :: case :: 1'
    ])
    expect(() => normalizeVitest({ ...report, numTotalTests: 3 }, '/source')).toThrow('Incomplete')
    expect(() => normalizeVitest({ numTotalTests: 0, testResults: [] }, '/source')).toThrow(
      'unavailable'
    )
    expect(() =>
      normalizeVitest(
        {
          ...rawReport(),
          numTotalTests: 0,
          testResults: [{ name: '/source/crash.test.ts', status: 'failed', assertionResults: [] }]
        },
        '/source'
      )
    ).toThrow('runtime failure')
  })
  it('maps only explicitly reviewed branding assertion names while still enforcing their actual result', () => {
    const path = 'src/main/app-branding.test.ts'
    const before =
      'app display branding uses the Open-Science display name in shell and workspace surfaces'
    const after =
      'app display branding uses the EarthNano display name in shell and workspace surfaces'
    const baseline = [{ path, name: before, id: `${path} :: ${before} :: 0`, status: 'passed' }]
    const candidate = [{ path, name: after, id: `${path} :: ${after} :: 0`, status: 'passed' }]
    const comparison = compareInventories(baseline, candidate)
    expect(comparison.conclusion).toBe('no-new-regressions')
    expect(comparison.reviewedTestRenames).toHaveLength(1)
    expect(baseline[0].name).toBe(before)
    expect(compareInventories(baseline, []).regressions).toHaveLength(1)
    for (const status of ['failed', 'pending'])
      expect(compareInventories(baseline, [{ ...candidate[0], status }]).conclusion).toBe(
        'new-regressions'
      )
    expect(
      compareInventories([{ ...baseline[0], path: 'different.ts' }], candidate).conclusion
    ).toBe('new-regressions')
    for (const asset of ['build/icon.ico', 'resources/icon-light.ico', 'resources/icon-dark.ico']) {
      const path = 'src/main/windows-icon-assets.test.ts'
      const before = `Windows icon assets keeps the V3 ring recognizable in the small frames of '${asset}'`
      const after = `Windows icon assets keeps the EarthNano mark recognizable in the small frames of '${asset}'`
      const old = [{ path, name: before, id: `${path} :: ${before} :: 0`, status: 'passed' }]
      const current = [{ path, name: after, id: `${path} :: ${after} :: 0`, status: 'passed' }]
      expect(compareInventories(old, current).conclusion).toBe('no-new-regressions')
      expect(compareInventories(old, [{ ...current[0], status: 'failed' }]).conclusion).toBe(
        'new-regressions'
      )
    }
  })
  it('rejects global/runtime errors and dishonest success/counters instead of classifying them as assertions', () => {
    for (const extra of [
      { success: false },
      { wasInterrupted: true },
      { numRuntimeErrorTestSuites: 1 },
      { unhandledErrors: [{ message: 'global failure' }] },
      { errors: [{ message: 'runtime failure' }] },
      { numPassedTests: 0 },
      { numFailedTests: 1 },
      { numPendingTestSuites: 1 }
    ])
      expect(() => normalizeVitest({ ...rawReport(), ...extra }, '/source')).toThrow()
    const failed = rawReport('/source', true)
    expect(normalizeVitest(failed, '/source')[0].status).toBe('failed')
    ;(failed.testResults as Array<{ message: string }>)[0].message = 'afterAll failed too'
    expect(() => normalizeVitest(failed, '/source')).toThrow('runtime failure')
  })
  it('requires complete physical stage/global outcomes while allowing represented original assertion failures', () => {
    const runtime = { schemaVersion: 1, reason: 'passed', unhandledErrors: [] }
    const report = { stages: stages(), tests: [test('original')] }
    expect(() => validateSourceExecution(report, runtime)).not.toThrow()
    for (const changed of [
      [],
      stages().slice(1),
      [...stages(), stages()[0]],
      stages().map((stage) => (stage.name === 'tests' ? { ...stage, status: 1 } : stage)),
      stages().map((stage) => (stage.name === 'pretest' ? { ...stage, status: 'running' } : stage)),
      stages().map((stage) =>
        stage.name === 'tests' ? { ...stage, signal: 'SIGTERM', status: null } : stage
      )
    ])
      expect(() => validateSourceExecution({ ...report, stages: changed }, runtime)).toThrow()
    for (const changed of [
      undefined,
      { ...runtime, reason: 'interrupted' },
      { ...runtime, unhandledErrors: [{ message: 'global' }] }
    ])
      expect(() => validateSourceExecution(report, changed)).toThrow()
    const originalFailure = { stages: stages(true), tests: [test('original', 'failed')] }
    expect(() =>
      validateSourceExecution(originalFailure, { ...runtime, reason: 'failed' })
    ).not.toThrow()
    expect(() =>
      validateSourceExecution(originalFailure, {
        ...runtime,
        reason: 'failed',
        unhandledErrors: [{ message: 'also-global' }]
      })
    ).toThrow()
  })
  it('enforces reviewed source/license pins without installing or building', async () => {
    await expect(verifyPins(process.cwd())).resolves.toMatchObject({ schemaVersion: 1 })
  })
  it('requires all original platform shards, matching environments and consistent source identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'earthnano-report-gate-'))
    roots.push(root)
    const reports = join(root, 'reports'),
      out = join(root, 'out')
    for (const platform of ['darwin', 'linux', 'win32'])
      for (const kind of ['baseline', 'candidate'])
        for (let shard = 1; shard <= (platform === 'win32' ? 8 : 4); shard++) {
          const dir = join(reports, `${platform}-${kind}-${shard}`)
          await mkdir(dir, { recursive: true })
          await writeFile(
            join(dir, 'source-report.json'),
            JSON.stringify({
              schemaVersion: 1,
              platform,
              kind,
              shard,
              total: platform === 'win32' ? 8 : 4,
              node: 'v24.0.0',
              arch: 'x64',
              electron: '43.7.5',
              image: 'fixture:1',
              lockDigest: 'b'.repeat(64),
              pins: {
                openScience: OPEN_SCIENCE_PIN,
                harness: HARNESS_PIN,
                harnessTree: HARNESS_TREE
              },
              profile: platform === 'win32' ? 'original-windows-full' : 'original-full',
              source: kind === 'baseline' ? OPEN_SCIENCE_PIN : 'a'.repeat(40),
              testRoot: '/source',
              stages: stages(),
              tests: normalizeVitest(rawReport(), '/source')
            })
          )
          // Distinct per-shard assertion names mirror a real Vitest shard, not duplicate data.
          const raw = rawReport()
          ;(
            raw.testResults as Array<{ assertionResults: Array<{ fullName: string }> }>
          )[0].assertionResults[0].fullName = `${platform}-${shard}`
          const report = JSON.parse(await readFile(join(dir, 'source-report.json'), 'utf8'))
          report.tests = normalizeVitest(raw, '/source')
          await writeFile(join(dir, 'source-report.json'), JSON.stringify(report))
          await writeFile(join(dir, 'vitest.json'), JSON.stringify(raw))
          await writeFile(
            join(dir, 'runtime.json'),
            JSON.stringify({ schemaVersion: 1, reason: 'passed', unhandledErrors: [] })
          )
        }
    await expect(compareReports(reports, out)).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(join(out, 'comparison.json'), 'utf8')).results).toHaveLength(3)
    const file = join(reports, 'win32-candidate-8', 'source-report.json'),
      value = JSON.parse(await readFile(file, 'utf8'))
    for (const extra of [
      { stages: [] },
      { shard: 0 },
      { shard: 9 },
      { shard: 1.5 },
      { schemaVersion: 2 },
      { pins: {} },
      { image: undefined }
    ]) {
      await writeFile(file, JSON.stringify({ ...value, ...extra }))
      await expect(compareReports(reports, out)).rejects.toThrow()
    }
    for (const malformed of ['{', 'null', '{}']) {
      await writeFile(file, malformed)
      await expect(compareReports(reports, out)).rejects.toThrow()
      expect(await readFile(file, 'utf8')).toBe(malformed)
    }
    await writeFile(file, JSON.stringify(value))
    for (const name of ['vitest.json', 'runtime.json']) {
      const path = join(reports, 'win32-candidate-8', name),
        original = await readFile(path, 'utf8')
      for (const malformed of ['{', 'null', '{}']) {
        await writeFile(path, malformed)
        await expect(compareReports(reports, out)).rejects.toThrow()
        expect(await readFile(path, 'utf8')).toBe(malformed)
      }
      await rm(path)
      await expect(compareReports(reports, out)).rejects.toThrow()
      await writeFile(path, original)
    }
    for (const kind of ['baseline', 'candidate']) {
      const dir = join(reports, `linux-${kind}-1`),
        raw = rawReport('/source', true)
      ;(
        raw.testResults as Array<{ assertionResults: Array<{ fullName: string }> }>
      )[0].assertionResults[0].fullName = 'linux-1'
      const metadata = JSON.parse(await readFile(join(dir, 'source-report.json'), 'utf8'))
      metadata.tests = normalizeVitest(raw, '/source')
      metadata.stages = stages(true)
      await writeFile(join(dir, 'source-report.json'), JSON.stringify(metadata))
      await writeFile(join(dir, 'vitest.json'), JSON.stringify(raw))
      await writeFile(
        join(dir, 'runtime.json'),
        JSON.stringify({ schemaVersion: 1, reason: 'failed', unhandledErrors: [] })
      )
    }
    await expect(compareReports(reports, out)).resolves.toBeUndefined()
    const comparison = JSON.parse(await readFile(join(out, 'comparison.json'), 'utf8'))
    expect(
      comparison.results.find((result: { platform: string }) => result.platform === 'linux')
        .baselineFailures
    ).toHaveLength(1)
    await writeFile(file, JSON.stringify({ ...value, electron: '43.4.0' }))
    await expect(compareReports(reports, out)).rejects.toThrow('Unmatched baseline environment')
    await rm(file)
    await expect(compareReports(reports, out)).rejects.toThrow('Missing/unavailable')
  })
  it('observes actual Vitest global failures even when its original JSON assertions all pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'earthnano-runtime-report-'))
    roots.push(root)
    const vitest = join(process.cwd(), 'node_modules/vitest/vitest.mjs')
    const reporter = join(process.cwd(), 'scripts/ci/earthnano-runtime-reporter.mjs')
    const config = join(root, 'vitest.config.mjs'),
      runtime = join(root, 'runtime.json')
    await writeFile(config, `export default {test:{include:['case.test.mjs'],maxWorkers:1}}`)
    for (const mode of ['passed', 'assertion', 'global']) {
      const body =
        mode === 'assertion'
          ? 'expect(1).toBe(2)'
          : mode === 'global'
            ? 'process.emit("unhandledRejection",new Error("global fixture"),Promise.resolve())'
            : 'expect(1).toBe(1)'
      await writeFile(
        join(root, 'case.test.mjs'),
        `import {it,expect} from ${JSON.stringify(join(process.cwd(), 'node_modules/vitest/dist/index.js'))};it('case',()=>{${body}})`
      )
      const child = spawnSync(
        process.execPath,
        [
          vitest,
          'run',
          '--config',
          config,
          '--root',
          root,
          '--reporter=json',
          `--reporter=${reporter}`,
          `--outputFile=${join(root, 'vitest.json')}`
        ],
        {
          encoding: 'utf8',
          timeout: 15_000,
          env: { ...process.env, EARTHNANO_CI_RUNTIME_REPORT: runtime }
        }
      )
      const raw = JSON.parse(await readFile(join(root, 'vitest.json'), 'utf8'))
      const originalRuntime = JSON.parse(await readFile(runtime, 'utf8'))
      const inventory = normalizeVitest(raw, root)
      const report = { tests: inventory, stages: stages(mode === 'assertion') }
      report.stages.at(-1)!.status = child.status!
      if (mode === 'global') {
        expect(inventory.every((test) => test.status === 'passed')).toBe(true)
        expect(raw.success).toBe(true)
        expect(child.status).toBe(1)
        expect(originalRuntime.unhandledErrors.length).toBeGreaterThan(0)
        expect(() => validateSourceExecution(report, originalRuntime)).toThrow('global/runtime')
      } else expect(() => validateSourceExecution(report, originalRuntime)).not.toThrow()
    }
  }, 60_000)
  it('requires original Harness pins, complete inventories and identical real interpreter environment', () => {
    const report = (kind: string): Record<string, unknown> => ({
      schemaVersion: 1,
      pins: { harness: HARNESS_PIN, tree: HARNESS_TREE },
      python: '3.12.13',
      executable: '/installed/python',
      platform: 'darwin',
      arch: 'arm64',
      collectionErrors: [],
      testsRun: 1,
      tests: [test('test_workflow.original', 'failed')],
      source: {
        kind,
        commit: kind === 'baseline' ? HARNESS_PIN : 'a'.repeat(40),
        tree: kind === 'baseline' ? HARNESS_TREE : 'b'.repeat(40),
        scope: kind === 'baseline' ? '.' : 'vendor/harness2',
        digest: 'c'.repeat(64),
        licenseDigest: 'd'.repeat(64)
      }
    })
    expect(compareHarnessReports(report('baseline'), report('candidate'))).toMatchObject({
      conclusion: 'no-new-regressions',
      baselineFailures: [test('test_workflow.original', 'failed')]
    })
    for (const changed of [
      null,
      {},
      { ...report('candidate'), tests: [], testsRun: 0 },
      { ...report('candidate'), testsRun: 2 },
      { ...report('candidate'), pins: {} },
      { ...report('candidate'), arch: 'x64' },
      { ...report('candidate'), unavailable: 'source-changed' },
      { ...report('candidate'), collectionErrors: ['unittest.loader._FailedTest.test_workflow'] },
      {
        ...report('candidate'),
        tests: [test('unittest.loader._FailedTest.test_workflow', 'failed')]
      },
      { ...report('candidate'), tests: [test('setUpClass (test_workflow.Original)', 'failed')] },
      { ...report('candidate'), tests: [test('test_workflow.original', 'unknown')] }
    ])
      expect(() => compareHarnessReports(report('baseline'), changed)).toThrow()
    expect(() =>
      compareHarnessReports(
        { ...report('baseline'), source: report('candidate').source },
        report('candidate')
      )
    ).toThrow()
  })
  it('retains actual unittest import/setup errors as raw unavailable evidence and refuses no-test discovery', async () => {
    const script = join(process.cwd(), 'scripts/ci/earthnano-harness.py')
    const python = process.env.EARTHNANO_RESEARCH_PYTHON ?? 'python3'
    for (const body of [
      'raise ImportError("original fixture import failure")',
      'import unittest\nclass Original(unittest.TestCase):\n @classmethod\n def setUpClass(cls): raise RuntimeError("original fixture setup failure")\n def test_case(self): pass',
      'import unittest',
      'import unittest\nclass Original(unittest.TestCase):\n def test_case(self): self.fail("original assertion failure")'
    ]) {
      const root = await mkdtemp(join(tmpdir(), 'earthnano-unittest-inventory-'))
      roots.push(root)
      await mkdir(join(root, 'tests'))
      await writeFile(join(root, 'tests', 'test_case.py'), body)
      const output = join(root, 'report.json')
      const child = spawnSync(
        python,
        [
          '-c',
          'import importlib.util,pathlib; s=importlib.util.spec_from_file_location("gate",' +
            JSON.stringify(script) +
            '); m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.run_inventory(pathlib.Path(' +
            JSON.stringify(root) +
            '),pathlib.Path(' +
            JSON.stringify(output) +
            '),{})'
        ],
        { encoding: 'utf8', timeout: 15_000 }
      )
      const original = JSON.parse(await readFile(output, 'utf8'))
      if (body.includes('self.fail')) {
        expect(child.status).toBe(0)
        expect(original.collectionErrors).toEqual([])
        expect(original.tests).toMatchObject([
          { id: 'test_case.Original.test_case', status: 'failed' }
        ])
      } else {
        expect(child.status).not.toBe(0)
        if (body.includes('raise')) {
          expect(original.collectionErrors).toHaveLength(1)
          expect(original.tests[0].status).toBe('failed')
          expect(original.tests[0].failureMessages.length).toBeGreaterThan(0)
        } else expect(original.testsRun).toBe(0)
      }
    }
    const wrongPin = spawnSync(
      python,
      [
        script,
        'vendor/harness2',
        join(tmpdir(), 'must-not-be-used-harness.json'),
        '--kind',
        'baseline'
      ],
      { encoding: 'utf8', timeout: 15_000 }
    )
    expect(wrongPin.status).not.toBe(0)
    expect(wrongPin.stderr).toContain('Wrong original Harness source pin/tree')
  }, 60_000)
  it('keeps only a read-only pinned workflow and explicit unsigned native acceptance', async () => {
    const source = await readFile('.github/workflows/earthnano-ci.yml', 'utf8'),
      workflow = load(source) as {
        permissions: Record<string, string>
        on: Record<string, unknown>
        jobs: { native: { if: string } }
      }
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.on.schedule).toBeUndefined()
    expect(workflow.on.pull_request_target).toBeUndefined()
    expect(source).not.toContain('secrets.')
    expect(source).not.toMatch(/permissions:[\s\S]{0,80}write/u)
    expect(workflow.jobs.native.if).toBe(
      "(github.event_name == 'workflow_dispatch' && inputs.native) || " +
        "(github.event_name == 'push' && github.ref == 'refs/heads/ci/earthnano-native')"
    )
    expect((workflow.on.push as { branches: string[] }).branches).toEqual([
      'main',
      'ci/earthnano-native'
    ])
    const actions = source.matchAll(/uses: ([^\s]+)/g)
    for (const action of actions)
      if (!action[1].startsWith('./')) expect(action[1]).toMatch(/@[a-f0-9]{40}$/)
    expect(source).toContain('xcrun actool --version')
    expect(source).toContain('macos-26-intel')
    expect(source).toContain("['windows-2022', 8]")
    expect(source).toContain('scripts/ci/npm-ci.mjs')
    expect(source).toContain('npm run build')
    expect(source).toContain('--publish never')
    expect(source).toContain('macos-package-smoke.mjs --artifact-dir dist')
    expect(source).toContain('windows-installer-smoke.mjs --installer-dir dist')
    expect(source).toContain('linux-package-smoke.mjs --artifact-dir dist')
    expect(source).toContain('if-no-files-found: error')
  })
})
