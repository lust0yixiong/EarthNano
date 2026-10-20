import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compareInventories,
  compareReports,
  exactElectronVersion,
  normalizeVitest,
  OPEN_SCIENCE_PIN,
  verifyPins
} from './earthnano-source.mjs'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const test = (id: string, status = 'passed'): { id: string; status: string } => ({ id, status })
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
      numTotalTests: 2,
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
              platform,
              kind,
              shard,
              total: platform === 'win32' ? 8 : 4,
              node: 'v24.0.0',
              arch: 'x64',
              electron: '43.7.5',
              profile: platform === 'win32' ? 'original-windows-full' : 'original-portable',
              source: kind === 'baseline' ? OPEN_SCIENCE_PIN : 'a'.repeat(40),
              stages: [{ name: 'tests', status: 0 }],
              tests: [test(`${platform}-${shard}`)]
            })
          )
        }
    await expect(compareReports(reports, out)).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(join(out, 'comparison.json'), 'utf8')).results).toHaveLength(3)
    const file = join(reports, 'win32-candidate-8', 'source-report.json'),
      value = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(file, JSON.stringify({ ...value, electron: '43.4.0' }))
    await expect(compareReports(reports, out)).rejects.toThrow('Unmatched baseline environment')
    await rm(file)
    await expect(compareReports(reports, out)).rejects.toThrow('Missing/unavailable')
  })
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
