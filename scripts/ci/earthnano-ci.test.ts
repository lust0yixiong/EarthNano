import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { compareHarnessReports } from './earthnano-harness-compare.mjs'
import {
  compareInventories,
  compareReports,
  exactElectronVersion,
  normalizeVitest,
  sourceTestInvocation,
  sourceBatch,
  registeredWorktreeMatches,
  validateSourceExecution,
  HARNESS_PIN,
  HARNESS_TREE,
  OPEN_SCIENCE_PIN,
  verifyPins
} from './earthnano-source.mjs'
const roots: string[] = []
const isolatedReporter = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'earthnano-isolated-observer-'))
  roots.push(directory)
  const reporter = join(directory, 'observer.mjs')
  await writeFile(reporter, await readFile('scripts/ci/earthnano-runtime-reporter.mjs'))
  await expect(lstat(join(directory, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
  // Native ESM must load the actual copied observer without Vite's resolver or repository deps.
  const loaded = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(reporter).href)})`],
    {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' }
    }
  )
  expect(loaded.status, loaded.stderr).toBe(0)
  return reporter
}
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
    for (const [field, changed] of [
      ['source', 'c'.repeat(40)],
      ['lockDigest', 'd'.repeat(64)]
    ]) {
      const originals: Array<[string, string]> = []
      for (let shard = 1; shard <= 8; shard++) {
        const path = join(reports, `win32-candidate-${shard}`, 'source-report.json')
        const bytes = await readFile(path, 'utf8')
        originals.push([path, bytes])
        await writeFile(path, JSON.stringify({ ...JSON.parse(bytes), [field]: changed }))
      }
      await expect(compareReports(reports, out)).rejects.toThrow('across platforms')
      for (const [path, bytes] of originals) await writeFile(path, bytes)
    }
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
    // A canonical setup input prevents drift; it never makes differing actual environments valid.
    for (const extra of [{ node: 'v24.22.0' }, { image: 'ubuntu24:20261018.339.1' }]) {
      await writeFile(file, JSON.stringify({ ...value, ...extra }))
      await expect(compareReports(reports, out)).rejects.toThrow('Unmatched baseline environment')
    }
    await rm(file)
    await expect(compareReports(reports, out)).rejects.toThrow('Missing/unavailable')
  })
  it('observes actual Vitest global failures even when its original JSON assertions all pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'earthnano-runtime-report-'))
    roots.push(root)
    const vitest = join(process.cwd(), 'node_modules/vitest/vitest.mjs')
    const reporter = await isolatedReporter()
    const config = join(root, 'vitest.config.mjs'),
      runtime = join(root, 'runtime.json')
    await writeFile(config, `export default {test:{include:['case.test.mjs'],maxWorkers:1}}`)
    for (const mode of ['passed', 'assertion', 'global', 'skips']) {
      const body =
        mode === 'assertion'
          ? 'expect(1).toBe(2)'
          : mode === 'global'
            ? 'process.emit("unhandledRejection",new Error("global fixture"),Promise.resolve())'
            : 'expect(1).toBe(1)'
      await writeFile(
        join(root, 'case.test.mjs'),
        `import {it,expect,describe} from ${JSON.stringify(join(process.cwd(), 'node_modules/vitest/dist/index.js'))};` +
          (mode === 'skips'
            ? `describe('outer',()=>{it.skip('skipped',()=>{});it.todo('todo');describe('inner',()=>it('passed',()=>expect(1).toBe(1)))})`
            : `it('case',()=>{${body}})`)
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
      if (mode === 'skips') {
        expect(raw).toMatchObject({
          numTotalTests: 3,
          numPassedTests: 1,
          numPendingTests: 1,
          numTodoTests: 1,
          numTotalTestSuites: 3,
          success: true
        })
        expect(inventory.map((test) => test.status).sort()).toEqual(['passed', 'skipped', 'todo'])
        expect(originalRuntime).toMatchObject({ reason: 'passed', unhandledErrors: [] })
      }
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
  it('anchors actual candidate Git cleanliness at the repository root before unittest admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'earthnano-harness-cleanliness-'))
    roots.push(root)
    const vendor = join(root, 'vendor', 'harness2'),
      script = join(process.cwd(), 'scripts/ci/earthnano-harness.py')
    await mkdir(join(vendor, 'harness2'), { recursive: true })
    await mkdir(join(vendor, 'tests'))
    await writeFile(join(vendor, 'harness2', '__init__.py'), '')
    await writeFile(join(vendor, 'LICENSE'), 'test-only-license')
    await writeFile(
      join(root, 'UPSTREAMS.json'),
      JSON.stringify({ upstreams: [{ name: 'Harness²', commit: HARNESS_PIN, tree: HARNESS_TREE }] })
    )
    const file = join(vendor, 'tests', 'test_case.py'),
      body = 'import unittest\nclass Original(unittest.TestCase):\n def test_case(self): pass'
    await writeFile(file, body)
    for (const args of [
      ['init', '--quiet'],
      ['add', '.'],
      [
        '-c',
        'user.name=CI',
        '-c',
        'user.email=ci@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'fixture'
      ]
    ])
      expect(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status).toBe(0)
    const python = process.env.EARTHNANO_RESEARCH_PYTHON ?? 'python3',
      output = join(root, 'clean-report.json')
    const invoke = (path: string): ReturnType<typeof spawnSync> =>
      spawnSync(python, [script, vendor, path, '--kind', 'candidate'], {
        encoding: 'utf8',
        timeout: 15_000
      })
    expect(invoke(output).status).toBe(0)
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({
      testsRun: 1,
      collectionErrors: [],
      source: { kind: 'candidate', scope: 'vendor/harness2' }
    })
    await writeFile(file, body + '\n# changed')
    expect(invoke(join(root, 'changed-report.json')).stderr?.toString()).toContain(
      'Harness source changed after checkout'
    )
    await writeFile(file, body)
    await writeFile(join(vendor, 'tests', 'test_untracked.py'), '# untracked')
    expect(invoke(join(root, 'untracked-report.json')).stderr?.toString()).toContain(
      'Harness source changed after checkout'
    )
  }, 60_000)
  it('keeps only a read-only pinned workflow and explicit unsigned native acceptance', async () => {
    const source = await readFile('.github/workflows/earthnano-ci.yml', 'utf8'),
      shared = (
        await Promise.all(
          ['source', 'native'].map((kind) =>
            readFile(`.github/workflows/earthnano-${kind}.yml`, 'utf8')
          )
        )
      ).join('\n'),
      recipes = source + '\n' + shared,
      workflow = load(source) as {
        permissions: Record<string, string>
        on: Record<string, unknown>
        jobs: { native_unix: { if: string }; native_windows: { if: string } }
      }
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.on.schedule).toBeUndefined()
    expect(workflow.on.pull_request_target).toBeUndefined()
    expect(recipes).not.toContain('secrets.')
    expect(recipes).not.toMatch(/permissions:[\s\S]{0,80}write/u)
    const nativeCondition =
      "(github.event_name == 'workflow_dispatch' && inputs.native) || " +
      "(github.event_name == 'push' && github.ref == 'refs/heads/ci/earthnano-native')"
    expect(workflow.jobs.native_unix.if).toBe(nativeCondition)
    expect(workflow.jobs.native_windows.if).toBe(nativeCondition)
    expect((workflow.on.push as { branches: string[] }).branches).toEqual([
      'main',
      'ci/earthnano-native'
    ])
    const actions = recipes.matchAll(/uses: ([^\s]+)/g)
    for (const action of actions)
      if (!action[1].startsWith('./')) expect(action[1]).toMatch(/@[a-f0-9]{40}$/)
    expect(recipes).toContain('xcrun actool --version')
    expect(source).toContain('macos-26-intel')
    expect(source).toContain("['windows-2022', 8]")
    expect(recipes).toContain('scripts/ci/npm-ci.mjs')
    expect(recipes).toContain('npm run build')
    expect(recipes).toContain('--publish never')
    expect(recipes).toContain('macos-package-smoke.mjs --artifact-dir dist')
    expect(recipes).toContain('windows-installer-smoke.mjs --installer-dir dist')
    expect(recipes).toContain('linux-package-smoke.mjs --artifact-dir dist')
    expect(recipes).toContain('if-no-files-found: error')
  })
})

it.each(['win32', 'darwin', 'linux'] as const)(
  'preserves the original npm test environment and exact source flags on %s',
  (platform) => {
    const args = [
      '--shard=7/8',
      '--maxWorkers=2',
      '--testTimeout=30000',
      '--hookTimeout=60000',
      '--reporter=json',
      '--reporter=/source/original-runtime-reporter.mjs',
      '--outputFile=/reports/vitest.json'
    ]
    expect(sourceTestInvocation(args, platform)).toEqual({
      command: platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['--ignore-scripts', 'test', '--', ...args],
      shell: platform === 'win32'
    })
  }
)
it('runs the original test script with npm_execpath without repeating the recorded pretest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earthnano-npm-test-env-'))
  roots.push(root)
  const resultFile = join(root, 'test-environment.json')
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'earthnano-original-source-test-environment',
      private: true,
      scripts: {
        pretest: 'node -e "throw new Error(\'pretest must remain a separate recorded stage\')"',
        test: 'node capture.mjs'
      }
    })
  )
  await writeFile(
    join(root, 'capture.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.EARTHNANO_TEST_ENV_OUTPUT, JSON.stringify({ npmExecpath: process.env.npm_execpath, lifecycleEvent: process.env.npm_lifecycle_event, args: process.argv.slice(2) }))`
  )
  const invocation = sourceTestInvocation(['--shard=7/8', '--maxWorkers=2'])
  const child = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    shell: invocation.shell,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, EARTHNANO_TEST_ENV_OUTPUT: resultFile }
  })
  expect(child.status, child.stdout + child.stderr).toBe(0)
  const observed = JSON.parse(await readFile(resultFile, 'utf8'))
  expect(observed).toMatchObject({
    lifecycleEvent: 'test',
    args: ['--shard=7/8', '--maxWorkers=2']
  })
  expect(observed.npmExecpath).toMatch(/[\\/]npm-cli\.js$/)
})

it.each([
  ['C:/repo/earthnano-upstream-1', 'C:\\repo\\earthnano-upstream-1', 'win32', true],
  ['//server/share/earthnano-upstream-1', '\\\\server\\share\\earthnano-upstream-1', 'win32', true],
  ['D:/repo/earthnano-upstream-1', 'C:\\repo\\earthnano-upstream-1', 'win32', false],
  ['C:/other/earthnano-upstream-1', 'C:\\repo\\earthnano-upstream-1', 'win32', false],
  ['C:/repo/earthnano-upstream-10', 'C:\\repo\\earthnano-upstream-1', 'win32', false],
  ['C:/repo/earthnano-upstream-1/child', 'C:\\repo\\earthnano-upstream-1', 'win32', false],
  ['//other/share/earthnano-upstream-1', '\\\\server\\share\\earthnano-upstream-1', 'win32', false],
  ['C:repo/earthnano-upstream-1', 'C:\\repo\\earthnano-upstream-1', 'win32', false],
  ['/repo/earthnano-upstream-1', '/repo/earthnano-upstream-1', 'linux', true],
  ['/other/earthnano-upstream-1', '/repo/earthnano-upstream-1', 'linux', false],
  ['/repo/../earthnano-upstream-1', '/earthnano-upstream-1', 'linux', false],
  ['/repo/earthnano-upstream-1', '/repo/earthnano-upstream-1', 'darwin', true]
] as const)(
  'matches only the complete registered worktree path (%s, %s, %s)',
  (registered, selected, platform, expected) => {
    const output = `worktree ${registered}\0HEAD ${OPEN_SCIENCE_PIN}\0detached\0\0`
    expect(registeredWorktreeMatches(output, selected, platform)).toBe(expected)
    expect(
      registeredWorktreeMatches(output.replace('worktree ', 'locked '), selected, platform)
    ).toBe(false)
  }
)

it.each([
  'complete',
  'unavailable',
  'locked-cleanup',
  'wrong-report',
  'wrong-head',
  'missing-report',
  'existing-checkout'
])(
  'retains eight original logical shards and strictly owns baseline cleanup (%s)',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'earthnano-cohort-'))
    roots.push(directory)
    const root = join(directory, 'candidate'),
      out = join(directory, 'reports')
    const git = (args: string[], cwd = root): string => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      return result.stdout
    }
    git(['clone', '--quiet', '--shared', '--no-checkout', process.cwd(), root], directory)
    const selected = join(directory, 'earthnano-upstream-1')
    if (mode === 'existing-checkout') {
      await mkdir(selected)
      await writeFile(join(selected, 'unknown'), 'must survive')
    }
    const calls: string[] = []
    const result = sourceBatch({ root, out }, async (args) => {
      calls.push(`${args.kind}-${args.shard}/${args.total}`)
      if (args.kind === 'baseline') {
        const checkout = join(directory, `earthnano-upstream-${args.shard}`)
        git([
          'worktree',
          'add',
          '--quiet',
          '--no-checkout',
          '--detach',
          checkout,
          mode === 'wrong-head' ? 'HEAD' : OPEN_SCIENCE_PIN
        ])
        await writeFile(
          join(checkout, 'untracked-node-modules-marker'),
          'owned dependency placeholder'
        )
        if (mode === 'locked-cleanup')
          git(['worktree', 'lock', checkout, '--reason', 'fault fixture'])
        await mkdir(args.out)
        if (mode === 'missing-report') return
        await writeFile(
          join(args.out, 'source-report.json'),
          JSON.stringify({
            kind: args.kind,
            shard: args.shard,
            total: args.total,
            testRoot: checkout,
            source: mode === 'wrong-report' ? '0'.repeat(40) : OPEN_SCIENCE_PIN
          })
        )
      } else {
        // Each original baseline and its dependencies must already be removed before candidates.
        for (let shard = 1; shard <= 4; shard++)
          await expect(lstat(join(directory, `earthnano-upstream-${shard}`))).rejects.toMatchObject(
            { code: 'ENOENT' }
          )
        if (mode === 'unavailable' && args.shard === 1)
          throw new Error('original unavailable shard')
      }
    })
    if (mode === 'complete') await expect(result).resolves.toBeUndefined()
    else
      await expect(result).rejects.toThrow(
        mode === 'existing-checkout'
          ? 'Refusing existing'
          : mode === 'unavailable'
            ? 'unavailable shards'
            : 'cleanup failed'
      )
    if (['complete', 'unavailable'].includes(mode)) {
      expect(calls).toEqual([
        'baseline-1/4',
        'baseline-2/4',
        'baseline-3/4',
        'baseline-4/4',
        'candidate-1/4',
        'candidate-2/4',
        'candidate-3/4',
        'candidate-4/4'
      ])
      const receipts = JSON.parse(await readFile(join(out, 'batch-receipt.json'), 'utf8'))
      expect(receipts).toHaveLength(8)
      expect(
        receipts
          .slice(0, 4)
          .every((r: { cleanup: string }) => r.cleanup === 'removed-owned-baseline')
      ).toBe(true)
      expect(git(['worktree', 'list', '--porcelain'])).not.toContain('earthnano-upstream-')
      for (let shard = 1; shard <= 4; shard++)
        expect(
          JSON.parse(await readFile(join(out, `baseline-${shard}`, 'source-report.json'), 'utf8'))
            .source
        ).toBe(OPEN_SCIENCE_PIN)
      if (mode === 'unavailable') expect(receipts[4].error).toBe('original unavailable shard')
    } else if (mode === 'existing-checkout') {
      expect(calls).toEqual([])
      expect(await readFile(join(selected, 'unknown'), 'utf8')).toBe('must survive')
    } else {
      expect(calls).toEqual(['baseline-1/4'])
      expect(await readFile(join(selected, 'untracked-node-modules-marker'), 'utf8')).toBe(
        'owned dependency placeholder'
      )
      expect(
        JSON.parse(await readFile(join(out, 'batch-receipt.json'), 'utf8'))[0].cleanupError
      ).toBeTruthy()
    }
  }
)

it('explains only actual inherited skips with complete runner observations and preserves raw pending identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earthnano-inherited-skip-'))
  roots.push(root)
  const config = join(root, 'vitest.config.mjs')
  const rawFile = join(root, 'vitest.json')
  const runtimeFile = join(root, 'runtime.json')
  const reporter = await isolatedReporter()
  await writeFile(config, `export default {test:{include:['case.test.mjs'],maxWorkers:1}}`)
  await writeFile(
    join(root, 'case.test.mjs'),
    `import {describe,it,expect} from ${JSON.stringify(join(process.cwd(), 'node_modules/vitest/dist/index.js'))};` +
      `describe.skip('no original interpreter',()=>describe.skipIf(true)('original POSIX-only suite',()=>{it('first original case',()=>expect(1).toBe(1));it('second original case',()=>expect(1).toBe(1))}));it('ordinary pass',()=>expect(1).toBe(1))`
  )
  const child = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      config,
      '--root',
      root,
      '--reporter=json',
      `--reporter=${reporter}`,
      `--outputFile=${rawFile}`
    ],
    {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, EARTHNANO_CI_RUNTIME_REPORT: runtimeFile }
    }
  )
  expect(child.status, child.stdout + child.stderr).toBe(0)
  const raw = JSON.parse(await readFile(rawFile, 'utf8'))
  const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'))
  const originalRaw = JSON.stringify(raw)
  expect(raw).toMatchObject({
    numTotalTests: 3,
    numPassedTests: 1,
    numPendingTests: 0,
    success: true
  })
  expect(runtime).toMatchObject({ schemaVersion: 1, reason: 'passed', unhandledErrors: [] })
  expect(() => normalizeVitest(raw, root)).toThrow('Incomplete')
  const inventory = normalizeVitest(raw, root, process.platform, runtime)
  expect(inventory.map((test) => test.status)).toEqual(['pending', 'pending', 'passed'])
  expect(inventory.filter((test) => test.inheritedSkip)).toHaveLength(2)
  expect(JSON.stringify(raw)).toBe(originalRaw)
  expect(() =>
    validateSourceExecution({ tests: inventory, stages: stages() }, runtime)
  ).not.toThrow()
  const comparison = compareInventories(
    inventory.map((test) => ({ ...test, status: 'passed' })),
    inventory
  )
  expect(comparison.regressions).toEqual([
    { id: inventory[0].id, reason: 'passed-to-pending' },
    { id: inventory[1].id, reason: 'passed-to-pending' }
  ])

  const changes = [
    [
      'old sidecar',
      (r: typeof runtime) => {
        delete r.taskInventory
      }
    ],
    [
      'missing leaf',
      (r: typeof runtime) => {
        r.taskInventory.leaves.shift()
      }
    ],
    [
      'extra leaf',
      (r: typeof runtime) => {
        r.taskInventory.leaves.push(r.taskInventory.leaves[0])
      }
    ],
    [
      'wrong identity',
      (r: typeof runtime) => {
        r.taskInventory.leaves[0].fullName += ' changed'
      }
    ],
    [
      'wrong status',
      (r: typeof runtime) => {
        r.taskInventory.leaves[0].mode = 'todo'
      }
    ],
    [
      'no skipped ancestor',
      (r: typeof runtime) => {
        for (const ancestor of r.taskInventory.leaves[0].ancestors) {
          ancestor.mode = 'run'
          ancestor.hasResult = true
          ancestor.resultState = 'pass'
        }
      }
    ],
    [
      'unfinished run',
      (r: typeof runtime) => {
        Object.assign(r.taskInventory.leaves[0], { hasResult: true, resultState: 'run' })
      }
    ],
    [
      'unfinished queued',
      (r: typeof runtime) => {
        Object.assign(r.taskInventory.leaves[0], { hasResult: true, resultState: 'queued' })
      }
    ],
    [
      'arbitrary resultless only leaf',
      (r: typeof runtime) => {
        r.taskInventory.leaves[0].mode = 'only'
      }
    ],
    [
      'running ancestor',
      (r: typeof runtime) => {
        Object.assign(r.taskInventory.leaves[0].ancestors[0], {
          hasResult: true,
          resultState: 'run'
        })
      }
    ],
    [
      'global error',
      (r: typeof runtime) => {
        r.unhandledErrors.push({ message: 'unhandled rejection' })
      }
    ],
    [
      'interrupted outcome',
      (r: typeof runtime) => {
        r.reason = 'interrupted'
      }
    ]
  ] as const
  for (const [name, change] of changes) {
    const altered = structuredClone(runtime)
    change(altered)
    expect(() => normalizeVitest(raw, root, process.platform, altered), name).toThrow()
  }
  for (const counters of [
    { numTotalTests: 4 },
    { numPassedTests: 2 },
    { numFailedTests: 1 },
    { numPendingTests: 1 },
    { numPendingTests: 2 },
    { numTodoTests: 1 }
  ])
    expect(() =>
      normalizeVitest({ ...raw, ...counters }, root, process.platform, runtime)
    ).toThrow()
  const duration = structuredClone(raw)
  duration.testResults[0].assertionResults[0].duration = 1
  expect(() => normalizeVitest(duration, root, process.platform, runtime)).toThrow()
}, 30_000)
