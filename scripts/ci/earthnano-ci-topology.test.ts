import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  id?: string
  name?: string
  shell?: string
  run?: string
  uses?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}
interface Job {
  needs?: string | string[]
  uses?: string
  if?: string
  'timeout-minutes'?: number
  steps?: Step[]
  outputs?: Record<string, string>
  env?: Record<string, string>
  with?: Record<string, string>
  strategy?: { 'fail-fast'?: boolean; matrix?: { include: unknown[] } | string }
}
interface Workflow {
  on: Record<string, { branches?: string[] }>
  permissions: Record<string, string>
  jobs: Record<string, Job>
}
const readWorkflow = (name: string): Workflow =>
  load(readFileSync(`.github/workflows/earthnano-${name}.yml`, 'utf8')) as Workflow
const workflow = readWorkflow('ci')
const needs = (job: Job): string[] =>
  job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)])
    )
  return value
}
const digest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
const recipe = (kind: string): Workflow =>
  load(
    readFileSync(`.github/workflows/earthnano-${kind}.yml`, 'utf8').replaceAll('inputs.', 'matrix.')
  ) as Workflow

describe('EarthNano runtime dependency split', () => {
  it('plans every original shard exactly once and partitions only by Windows runtime need', () => {
    const root = mkdtempSync(join(tmpdir(), 'earthnano-ci-plan-'))
    try {
      const output = join(root, 'output')
      const script = workflow.jobs.plan.steps!.find((step) => step.id === 'matrix')!
      expect(script.shell).toBe('node {0}')
      const result = spawnSync(process.execPath, ['-e', script.run!], {
        env: { GITHUB_OUTPUT: output },
        encoding: 'utf8'
      })
      expect(result.status, result.stderr).toBe(0)
      const plans = Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map((line) => {
            const equal = line.indexOf('=')
            return [line.slice(0, equal), JSON.parse(line.slice(equal + 1))]
          })
      ) as Record<
        string,
        { include: Array<{ os: string; kind: string; shard: number; total: number }> }
      >
      expect(Object.keys(plans).sort()).toEqual(['unix_matrix', 'windows_matrix'])
      expect(plans.unix_matrix.include).toHaveLength(16)
      expect(plans.windows_matrix.include).toHaveLength(16)
      expect(plans.unix_matrix.include.every((row) => !row.os.startsWith('windows-'))).toBe(true)
      expect(plans.windows_matrix.include.every((row) => row.os === 'windows-2022')).toBe(true)
      const expected = []
      for (const [os, total] of [
        ['ubuntu-24.04', 4],
        ['macos-15', 4],
        ['windows-2022', 8]
      ] as const)
        for (const kind of ['baseline', 'candidate'])
          for (let shard = 1; shard <= total; shard++) expected.push({ os, kind, shard, total })
      const rows = [...plans.unix_matrix.include, ...plans.windows_matrix.include]
      expect(rows).toEqual(expected)
      expect(new Set(rows.map((row) => `${row.os}/${row.kind}/${row.shard}`)).size).toBe(32)
      expect(workflow.jobs.plan.outputs).toEqual({
        unix_matrix: '${{ steps.matrix.outputs.unix_matrix }}',
        windows_matrix: '${{ steps.matrix.outputs.windows_matrix }}'
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('allows Unix source/native jobs to start without a completed Windows cold build', () => {
    expect(needs(workflow.jobs.source_unix)).toEqual(['plan'])
    expect(needs(workflow.jobs.native_unix)).toEqual([])
    expect(needs(workflow.jobs.plan)).toEqual([])
    expect(needs(workflow.jobs.source_windows)).toEqual(['plan', 'windows_runtime'])
    expect(needs(workflow.jobs.native_windows)).toEqual(['windows_runtime'])
    for (const [name, output] of [
      ['source_unix', 'unix_matrix'],
      ['source_windows', 'windows_matrix']
    ])
      expect(workflow.jobs[name].strategy).toEqual({
        'fail-fast': false,
        matrix: '${{ fromJSON(needs.plan.outputs.' + output + ') }}'
      })
    const targets = ['native_unix', 'native_windows'].flatMap((name) => {
      expect(workflow.jobs[name].strategy!['fail-fast']).toBe(false)
      return (workflow.jobs[name].strategy!.matrix as { include: unknown[] }).include
    })
    expect(targets).toEqual([
      { os: 'macos-26', platform: 'mac', arch: 'arm64', subdir: 'osx-arm64' },
      { os: 'macos-26-intel', platform: 'mac', arch: 'x64', subdir: 'osx-64' },
      { os: 'ubuntu-24.04', platform: 'linux', arch: 'x64', subdir: 'linux-64' },
      { os: 'windows-2022', platform: 'win', arch: 'x64', subdir: 'win-64' }
    ])
  })
  it('shares exact original recipes instead of copying commands into split callers', () => {
    for (const kind of ['source', 'native']) {
      for (const platform of ['unix', 'windows']) {
        const job = workflow.jobs[`${kind}_${platform}`]
        expect(job.uses).toBe(`./.github/workflows/earthnano-${kind}.yml`)
        expect(job.steps).toBeUndefined()
        expect(job).not.toHaveProperty('continue-on-error')
        expect(job.with).toEqual(
          Object.fromEntries(
            (kind === 'source'
              ? ['os', 'kind', 'shard', 'total']
              : ['os', 'platform', 'arch', 'subdir']
            ).map((key) => [key, '${{ matrix.' + key + ' }}'])
          )
        )
      }
      const shared = recipe(kind)
      expect(Object.keys(shared.on)).toEqual(['workflow_call'])
      expect(shared.permissions).toEqual({ contents: 'read' })
      expect(Object.keys(shared.jobs)).toEqual([kind])
      // Original d4b20667d inventories plus the single reviewed Python input change:
      // literal 3.12.13 → canonical version file (hosted macOS arm64 has no 3.12.13 asset).
      // Keep the complete new hash AND restore only that input to prove all other steps
      // still match d4. No pin, condition, command, environment or artifact waiver.
      expect(digest(shared.jobs[kind].steps)).toBe(
        kind === 'source'
          ? '9c710bb6dea916d0e6d92236d1448248ae2efafbe262adf652c6dc2806afc207'
          : 'ce027e4bfd00597f19507e5a897929d98c23015cefdc89f7bce30dcddcce9087'
      )
      const originalSteps = structuredClone(shared.jobs[kind].steps!)
      const python = originalSteps.filter((step) => step.uses?.startsWith('actions/setup-python@'))
      expect(python).toHaveLength(1)
      expect(python[0].uses).toBe('actions/setup-python@e797f83bcb11b83ae66e0230d6156d7c80228e7c')
      expect(python[0].with).toEqual({ 'python-version-file': '.github/earthnano-python-version' })
      python[0].with = { 'python-version': '3.12.13' }
      expect(digest(originalSteps)).toBe(
        kind === 'source'
          ? 'de9ac67cde4f371c609984cd10c4152428fee6018dc230ed70e210c59a9c59a1'
          : '37581731c958b836724b48cc7eaafaba974b63fac4e0b3292a81a8d41cba5cc0'
      )
    }
    const harnessPython = workflow.jobs.harness.steps!.filter((step) =>
      step.uses?.startsWith('actions/setup-python@')
    )
    expect(harnessPython).toHaveLength(1)
    expect(harnessPython[0]).toEqual({
      uses: 'actions/setup-python@e797f83bcb11b83ae66e0230d6156d7c80228e7c',
      with: { 'python-version-file': '.github/earthnano-python-version' }
    })
    // A single exact patch version, never a range or multiple platform-specific resolutions.
    const versionFile = readFileSync('.github/earthnano-python-version', 'utf8')
    expect(versionFile).toBe('3.12.10\n')
    expect(readWorkflow('native').jobs.native.env).toEqual({
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      MACOSX_DEPLOYMENT_TARGET: '12.0'
    })
  })
  it('extends only the cold-build budget and keeps source/native test deadlines', () => {
    expect(workflow.jobs.windows_runtime['timeout-minutes']).toBe(150)
    expect(readWorkflow('source').jobs.source['timeout-minutes']).toBe(90)
    expect(readWorkflow('native').jobs.native['timeout-minutes']).toBe(90)
    expect(workflow.jobs.comparison['timeout-minutes']).toBe(10)
    expect(workflow.jobs.harness['timeout-minutes']).toBe(15)
    expect(
      workflow.jobs.windows_runtime.steps!.find((step) => step.uses?.startsWith('./'))!.uses
    ).toBe('./.github/actions/windows-notebook-runtime')
  })
  it('runs comparison even when source dependencies fail or skip, except the explicit native-only branch', () => {
    const job = workflow.jobs.comparison
    expect(job).not.toHaveProperty('continue-on-error')
    expect(needs(job)).toEqual(['source_unix', 'source_windows'])
    expect(job.if).toBe("always() && github.ref != 'refs/heads/ci/earthnano-native'")
    const check = job.steps!.findIndex(
      (step) => step.name === 'Require both complete source matrices'
    )
    const download = job.steps!.findIndex((step) =>
      step.uses?.startsWith('actions/download-artifact@')
    )
    const compare = job.steps!.findIndex((step) =>
      step.run?.startsWith('node scripts/ci/earthnano-source.mjs compare')
    )
    expect(check).toBeGreaterThanOrEqual(0)
    expect(download).toBeGreaterThan(check)
    expect(compare).toBeGreaterThan(download)
    expect(job.steps![check].env).toEqual({
      SOURCE_UNIX_RESULT: '${{ needs.source_unix.result }}',
      SOURCE_WINDOWS_RESULT: '${{ needs.source_windows.result }}'
    })
    expect(job.steps![compare].run).toBe(
      'node scripts/ci/earthnano-source.mjs compare --reports source-reports --out test-results/earthnano-ci'
    )
  })
  it.each([undefined, '', 'skipped', 'failure', 'cancelled', 'neutral'])(
    'rejects missing or non-success matrix status %s before report comparison',
    (status) => {
      const check = workflow.jobs.comparison.steps!.find(
        (step) => step.name === 'Require both complete source matrices'
      )!
      for (const failed of ['SOURCE_UNIX_RESULT', 'SOURCE_WINDOWS_RESULT']) {
        const env: Record<string, string> = {
          SOURCE_UNIX_RESULT: 'success',
          SOURCE_WINDOWS_RESULT: 'success'
        }
        if (status === undefined) delete env[failed]
        else env[failed] = status
        const result = spawnSync(process.execPath, ['-e', check.run!], { env, encoding: 'utf8' })
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain(`Required source matrix did not succeed: ${failed}`)
      }
    }
  )
  it('accepts both successful matrices while leaving report inventory validation mandatory', () => {
    const check = workflow.jobs.comparison.steps!.find(
      (step) => step.name === 'Require both complete source matrices'
    )!
    expect(
      spawnSync(process.execPath, ['-e', check.run!], {
        env: { SOURCE_UNIX_RESULT: 'success', SOURCE_WINDOWS_RESULT: 'success' }
      }).status
    ).toBe(0)
  })
  it('runs stacked Alpha PRs without widening permissions, push or automatic native triggers', () => {
    expect(workflow.on.pull_request.branches).toEqual(['main', 'feat/alpha-*'])
    expect(workflow.on.push.branches).toEqual(['main', 'ci/earthnano-native'])
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.on.pull_request_target).toBeUndefined()
    for (const name of ['native_unix', 'native_windows'])
      expect(workflow.jobs[name].if).toBe(
        "(github.event_name == 'workflow_dispatch' && inputs.native) || " +
          "(github.event_name == 'push' && github.ref == 'refs/heads/ci/earthnano-native')"
      )
  })
})
