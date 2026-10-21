import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
  'continue-on-error'?: boolean
}
interface Job {
  needs?: string | string[]
  uses?: string
  if?: string
  'timeout-minutes'?: number | string
  steps?: Step[]
  outputs?: Record<string, string>
  env?: Record<string, string>
  with?: Record<string, string>
  strategy?: { 'fail-fast'?: boolean; matrix?: { include: unknown[] } | string }
}
interface Workflow {
  on: Record<string, { branches?: string[]; inputs?: Record<string, unknown> }>
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
  it('permits a Windows diagnostic rerun without reducing the default five-target acceptance matrix', () => {
    expect(workflow.on.workflow_dispatch.inputs?.nativeTargets).toMatchObject({
      type: 'choice',
      default: 'all',
      options: ['all', 'windows']
    })
    const targets = (event: string, native: boolean, nativeTargets?: string): unknown[] =>
      ['native_unix', 'native_windows'].flatMap((name) => {
        const job = workflow.jobs[name]
        const enabled = new Function('github', 'inputs', `return (${job.if})`) as (
          github: { event_name: string; ref: string },
          inputs: { native: boolean; nativeTargets?: string }
        ) => boolean
        return enabled(
          { event_name: event, ref: 'refs/heads/ci/earthnano-native' },
          { native, nativeTargets }
        )
          ? (job.strategy!.matrix as { include: unknown[] }).include
          : []
      })
    expect(targets('push', false)).toHaveLength(5)
    expect(targets('workflow_dispatch', true)).toHaveLength(5)
    expect(targets('workflow_dispatch', true, 'all')).toHaveLength(5)
    expect(targets('workflow_dispatch', false, 'windows')).toEqual([])
    expect(targets('workflow_dispatch', true, 'windows')).toEqual([
      { os: 'windows-2022', platform: 'win', arch: 'x64', subdir: 'win-64' }
    ])
    const steps = readWorkflow('native').jobs.native.steps!
    const probe = steps.findIndex((step) => step.name?.startsWith('Observe original NSIS'))
    const smoke = steps.findIndex((step) => step.name?.startsWith('Original Windows installed'))
    expect(probe).toBeGreaterThan(-1)
    expect(smoke).toBeGreaterThan(probe)
    expect(steps[probe]).toEqual({
      name: 'Observe original NSIS argument parsing (diagnostic only)',
      if: "runner.os == 'Windows'",
      'continue-on-error': true,
      run: 'node scripts/windows-nsis-arguments-probe.mjs --out test-results/native-evidence/nsis-arguments'
    })
    expect(steps.filter((step) => step['continue-on-error'])).toEqual([steps[probe]])
    expect(steps[smoke]['continue-on-error']).toBeUndefined()
    expect(steps[smoke].if).toBe("runner.os == 'Windows'")
    expect(steps[smoke].run).toBe('node scripts/windows-installer-smoke.mjs --installer-dir dist')
  })
  it('plans one Linux cohort plus eight macOS and sixteen Windows jobs covering all original shards', () => {
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
        {
          include: Array<{ os: string; kind: string; shard: number; total: number; batch: boolean }>
        }
      >
      expect(Object.keys(plans).sort()).toEqual(['unix_matrix', 'windows_matrix'])
      expect(plans.unix_matrix.include).toHaveLength(9)
      expect(plans.windows_matrix.include).toHaveLength(16)
      expect(plans.unix_matrix.include.every((row) => !row.os.startsWith('windows-'))).toBe(true)
      expect(plans.windows_matrix.include.every((row) => row.os === 'windows-2022')).toBe(true)
      expect(plans.unix_matrix.include.filter((row) => row.os === 'ubuntu-24.04')).toEqual([
        { os: 'ubuntu-24.04', kind: 'cohort', shard: 1, total: 4, batch: true }
      ])
      expect(plans.unix_matrix.include.filter((row) => row.os === 'macos-15')).toHaveLength(8)
      expect(
        [...plans.unix_matrix.include, ...plans.windows_matrix.include].filter((row) => !row.batch)
      ).toHaveLength(24)
      const expected = []
      for (const [os, total] of [
        ['ubuntu-24.04', 4],
        ['macos-15', 4],
        ['windows-2022', 8]
      ] as const)
        for (const kind of ['baseline', 'candidate'])
          for (let shard = 1; shard <= total; shard++) expected.push({ os, kind, shard, total })
      const rows = [...plans.unix_matrix.include, ...plans.windows_matrix.include].flatMap((row) =>
        row.batch
          ? ['baseline', 'candidate'].flatMap((kind) =>
              Array.from({ length: 4 }, (_, index) => ({
                os: row.os,
                kind,
                shard: index + 1,
                total: 4
              }))
            )
          : [{ os: row.os, kind: row.kind, shard: row.shard, total: row.total }]
      )
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
      { os: 'ubuntu-24.04-arm', platform: 'linux', arch: 'arm64', subdir: 'linux-aarch64' },
      { os: 'windows-2022', platform: 'win', arch: 'x64', subdir: 'win-64' }
    ])
  })
  it.each([
    ['ubuntu-24.04', 'Linux', 'cohort', 1, 4, true, true],
    ['macos-15', 'macOS', 'baseline', 3, 4, false, true],
    ['windows-2022', 'Windows', 'candidate', 7, 8, false, true],
    ['macos-15', 'macOS', 'cohort', 1, 4, true, false],
    ['ubuntu-24.04', 'Linux', 'cohort', 2, 4, true, false],
    ['ubuntu-24.04', 'Linux', 'cohort', 1, 8, true, false]
  ] as const)(
    'executes bounded reusable dispatch for %s %s %s %s/%s batch=%s',
    (os, runner, kind, shard, total, batch, valid) => {
      const directory = mkdtempSync(join(tmpdir(), 'earthnano-cohort-dispatch-'))
      try {
        const capture = join(directory, 'args')
        let command = readWorkflow('source').jobs.source.steps!.find(
          (step) => step.name === 'Full selected original source shard on exact pinned source'
        )!.run!
        for (const [key, value] of Object.entries({ os, kind, shard, total, batch }))
          command = command.replaceAll('${{ inputs.' + key + ' }}', String(value))
        const result = spawnSync(
          'bash',
          [
            '-eu',
            '-c',
            'node() { printf "%s\\n" "$@" > "$CAPTURE"; }\nxvfb-run() { [[ "$1" == -a ]]; shift; "$@"; }\n' +
              command
          ],
          {
            env: {
              ...process.env,
              RUNNER_OS: runner,
              RUNNER_TEMP: `${directory}/.`,
              CAPTURE: capture
            },
            encoding: 'utf8'
          }
        )
        expect(result.status, result.stderr).toBe(valid ? 0 : 1)
        if (valid) {
          const args = readFileSync(capture, 'utf8').trim().split('\n')
          // Bash retains mixed separators (and redundant /.); compare the exact Node path identity.
          expect([...args.slice(0, -1), resolve(args.at(-1)!)]).toEqual([
            'scripts/ci/earthnano-source.mjs',
            ...(batch
              ? ['source-batch']
              : ['source', '--kind', kind, '--shard', String(shard), '--total', String(total)]),
            '--out',
            join(directory, 'source-report')
          ])
        } else expect(readdirSync(directory)).not.toContain('args')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
  it('retains all five upstream native tuples, including its exact Linux ARM64 runner and resources', () => {
    const pinnedBuild = spawnSync(
      'git',
      ['show', '9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5:.github/workflows/build.yml'],
      { encoding: 'utf8' }
    )
    expect(pinnedBuild.status, pinnedBuild.stderr).toBe(0)
    const original = load(pinnedBuild.stdout) as Workflow
    const matrix = Object.values(original.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.id === 'set' && step.run?.includes('linux-aarch64'))
    expect(matrix).toHaveLength(1)
    const arrays = [...matrix[0].run!.matchAll(/\b(?:mac|rest)='(\[[\s\S]*?\])'/g)]
    expect(arrays).toHaveLength(2)
    const upstream = arrays.flatMap((match) => JSON.parse(match[1])) as Array<{
      os: string
      platform: string
      bin_arch: string
      subdir: string
      engine_keep: string
    }>
    expect(upstream).toHaveLength(5)
    const targets = ['native_unix', 'native_windows'].flatMap(
      (name) => (workflow.jobs[name].strategy!.matrix as { include: unknown[] }).include
    )
    // Preserve the existing x64 Linux/Windows image pins; the added ARM64 tuple is byte-for-byte upstream.
    const existingRunnerPins: Record<string, string> = {
      'linux-x64': 'ubuntu-24.04',
      'win-x64': 'windows-2022'
    }
    expect(targets).toEqual(
      upstream.map((target) => ({
        os: existingRunnerPins[`${target.platform}-${target.bin_arch}`] ?? target.os,
        platform: target.platform,
        arch: target.bin_arch,
        subdir: target.subdir
      }))
    )
    const arm = upstream.find(
      (target) => target.platform === 'linux' && target.bin_arch === 'arm64'
    )!
    expect(arm).toMatchObject({
      os: 'ubuntu-24.04-arm',
      platform: 'linux',
      bin_arch: 'arm64',
      subdir: 'linux-aarch64',
      engine_keep: 'linux-arm64-openssl-3.0.x.so.node'
    })
    const pruning = readWorkflow('native').jobs.native.steps!.find(
      (step) => step.name === 'Original target Prisma engine pruning'
    )!
    expect(pruning.run).toContain(`linux-arm64) keep='${arm.engine_keep}' ;;`)
  })
  it.each([true, false])(
    'runs original ARM64 Prisma pruning and fails without its target engine (present=%s)',
    (present) => {
      const root = mkdtempSync(join(tmpdir(), 'earthnano-native-arm64-'))
      try {
        const directory = join(root, 'node_modules/.prisma/client')
        mkdirSync(directory, { recursive: true })
        const target = 'libquery_engine-linux-arm64-openssl-3.0.x.so.node'
        const foreign = [
          'libquery_engine-debian-openssl-3.0.x.so.node',
          'query_engine-windows.dll.node',
          'libquery_engine-darwin-arm64.dylib.node'
        ]
        for (const name of [...foreign, ...(present ? [target] : [])])
          writeFileSync(join(directory, name), 'synthetic engine identity fixture')
        const pruning = readWorkflow('native').jobs.native.steps!.find(
          (step) => step.name === 'Original target Prisma engine pruning'
        )!
        const result = spawnSync(
          'bash',
          [
            '-eu',
            '-c',
            pruning
              .run!.replaceAll('${{ inputs.platform }}', 'linux')
              .replaceAll('${{ inputs.arch }}', 'arm64')
          ],
          { cwd: root, encoding: 'utf8' }
        )
        expect(result.status, result.stderr).toBe(present ? 0 : 1)
        expect(readdirSync(directory)).toEqual(present ? [target] : [])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
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
              ? ['os', 'kind', 'shard', 'total', 'batch']
              : ['os', 'platform', 'arch', 'subdir']
            ).map((key) => [key, '${{ matrix.' + key + ' }}'])
          )
        )
      }
      const shared = recipe(kind)
      expect(Object.keys(shared.on)).toEqual(['workflow_call'])
      expect(shared.permissions).toEqual({ contents: 'read' })
      expect(Object.keys(shared.jobs)).toEqual([kind])
      // Original d4b20667d inventories plus the reviewed exact Python and Node inputs:
      // Python 3.12.13 → canonical version file (hosted macOS arm64 has no 3.12.13 asset);
      // floating Node 24 → one exact version file (runner caches resolved different patches).
      // Restore only these inputs, the original packaging heap ceiling and exact Linux ARM64
      // pruning case and Linux-only bounded cohort dispatch below to prove all other steps still match d4. No pin, condition, command
      // or artifact waiver.
      const originalSteps = structuredClone(shared.jobs[kind].steps!)
      if (kind === 'native') {
        // The separately verified optional observation must not change any original recipe step.
        const probe = originalSteps.findIndex(
          (step) => step.name === 'Observe original NSIS argument parsing (diagnostic only)'
        )
        expect(probe).toBeGreaterThan(-1)
        originalSteps.splice(probe, 1)
      }
      expect(digest(originalSteps)).toBe(
        kind === 'source'
          ? 'd6168ae5600395d53c2b70c35625bbc0ef20fa20430e20c2346e40f625ec61a5'
          : 'eeaf802903b62b7084a9f48db22fb6d976e710c59fe30b5114aaf7f669c20c68'
      )
      const python = originalSteps.filter((step) => step.uses?.startsWith('actions/setup-python@'))
      expect(python).toHaveLength(1)
      expect(python[0].uses).toBe('actions/setup-python@e797f83bcb11b83ae66e0230d6156d7c80228e7c')
      expect(python[0].with).toEqual({ 'python-version-file': '.github/earthnano-python-version' })
      python[0].with = { 'python-version': '3.12.13' }
      const node = originalSteps.filter((step) => step.uses?.startsWith('actions/setup-node@'))
      expect(node).toHaveLength(1)
      expect(node[0].uses).toBe('actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1')
      expect(node[0].with).toEqual({
        'node-version-file': '.github/earthnano-node-version',
        cache: 'npm'
      })
      node[0].with = { 'node-version': 24, cache: 'npm' }
      if (kind === 'source') {
        expect(shared.jobs.source['timeout-minutes']).toBe('${{ matrix.batch && 360 || 90 }}')
        const dispatch = originalSteps.filter(
          (step) => step.name === 'Full selected original source shard on exact pinned source'
        )
        expect(dispatch).toHaveLength(1)
        const lines = dispatch[0].run!.split('\n')
        expect(lines).toHaveLength(8)
        expect(lines[0]).toBe("if [[ '${{ matrix.batch }}' == true ]]; then")
        expect(lines[1]).toBe(
          "  [[ \"$RUNNER_OS\" == Linux && '${{ matrix.os }}' == ubuntu-24.04 && '${{ matrix.kind }}' == cohort && '${{ matrix.shard }}' == 1 && '${{ matrix.total }}' == 4 ]] || exit 1"
        )
        expect(lines[2]).toBe(
          '  args=(node scripts/ci/earthnano-source.mjs source-batch --out "$RUNNER_TEMP/source-report")'
        )
        expect(lines[3]).toBe('else')
        expect(lines[5]).toBe('fi')
        dispatch[0].run = lines[4].slice(2) + '\n' + lines[6] + '\n'
      }
      if (kind === 'native') {
        const pinnedBuild = spawnSync(
          'git',
          ['show', '9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5:.github/workflows/build.yml'],
          { encoding: 'utf8' }
        )
        expect(pinnedBuild.status, pinnedBuild.stderr).toBe(0)
        const original = load(pinnedBuild.stdout) as Workflow
        const packaging = Object.values(original.jobs)
          .flatMap((job) => job.steps ?? [])
          .filter((step) => step.run?.includes('npm run build:e2e'))
        expect(packaging).toHaveLength(1)
        expect(packaging[0].env?.NODE_OPTIONS).toBe('--max-old-space-size=8192')
        const build = originalSteps.filter(
          (step) => step.name === 'Original full application build'
        )
        expect(build).toHaveLength(1)
        expect(build[0].run).toBe('npm run build')
        expect(build[0].env).toEqual({ NODE_OPTIONS: packaging[0].env!.NODE_OPTIONS })
        // Only the exact, separately verified upstream additions are removed for the d4 inventory.
        delete build[0].env
        const pruning = originalSteps.filter(
          (step) => step.name === 'Original target Prisma engine pruning'
        )
        expect(pruning).toHaveLength(1)
        const addedCase = "  linux-arm64) keep='linux-arm64-openssl-3.0.x.so.node' ;;\n"
        expect(pruning[0].run!.split(addedCase)).toHaveLength(2)
        pruning[0].run = pruning[0].run!.replace(addedCase, '')
      }

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

  it('retains the actual floating-Node failure evidence without treating an unavailable install as a test result', () => {
    const observed = JSON.parse(
      readFileSync('scripts/ci/fixtures/earthnano-node-drift.json', 'utf8')
    )
    expect(observed.runId).toBe(39456512139)
    expect(observed.baseline.node).toBe('v24.21.0')
    expect(observed.candidate.node).toBe('v24.22.0')
    expect(observed.baseline.image).not.toBe(observed.candidate.image)
    expect(observed.baseline).toMatchObject({
      stage: 'tests',
      status: 0,
      passed: 18953,
      skipped: 295,
      failed: 0
    })
    expect(observed.candidate).toMatchObject({
      stage: 'npm-ci',
      status: 1,
      testsStarted: false,
      unavailable: 'Dependency installation unavailable'
    })
    expect(observed.candidate).not.toHaveProperty('passed')
    expect(observed.candidate).not.toHaveProperty('failed')
  })
  it('pins the same exact host Node across original source/native, Windows runtime and report helpers', () => {
    expect(readFileSync('.github/earthnano-node-version', 'utf8')).toBe('24.22.0\n')
    const selected = [
      readWorkflow('source').jobs.source,
      readWorkflow('native').jobs.native,
      workflow.jobs.windows_runtime,
      workflow.jobs.comparison,
      workflow.jobs.harness
    ]
    for (const job of selected) {
      const node = job.steps!.filter((step) => step.uses?.startsWith('actions/setup-node@'))
      expect(node).toHaveLength(1)
      expect(node[0].uses).toBe('actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1')
      expect(node[0].with).toEqual({
        'node-version-file': '.github/earthnano-node-version',
        ...('cache' in node[0].with! ? { cache: 'npm' } : {})
      })
      expect(
        job.steps!.findIndex((step) => step.uses?.startsWith('actions/checkout@'))
      ).toBeLessThan(job.steps!.indexOf(node[0]))
    }
    const steps = workflow.jobs.windows_runtime.steps!
    expect(steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'))).toBeLessThan(
      steps.findIndex((step) => step.uses === './.github/actions/windows-notebook-runtime')
    )
    // The patched AppContainer binary has its own original source pin; changing the host tool
    // must not change the compiled Notebook runtime or its integrity/catalog inputs.
    const bundled = JSON.parse(
      readFileSync('packages/notebook-network-sandbox/vendor/windows-runtime/sources.json', 'utf8')
    )
    expect(bundled.node).toEqual({
      version: '24.21.0',
      url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0.tar.xz',
      sha256: 'a6f54defb6fd7c84f41dba13d61e78e9b4e0961712cf61f29715c05f5ced94fc'
    })
    const original = spawnSync(
      'git',
      ['show', '9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5:.github/workflows/native-components.yml'],
      { encoding: 'utf8' }
    )
    expect(original.status, original.stderr).toBe(0)
    expect(readFileSync('.github/workflows/native-components.yml', 'utf8')).toBe(original.stdout)
  })
  it('bounds Linux cohort at 360 minutes and retains other source/native and cold-build deadlines', () => {
    expect(workflow.jobs.windows_runtime['timeout-minutes']).toBe(150)
    expect(readWorkflow('source').jobs.source['timeout-minutes']).toBe(
      '${{ inputs.batch && 360 || 90 }}'
    )
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
    const originalTrigger =
      "(github.event_name == 'workflow_dispatch' && inputs.native) || " +
      "(github.event_name == 'push' && github.ref == 'refs/heads/ci/earthnano-native')"
    expect(workflow.jobs.native_windows.if).toBe(originalTrigger)
    expect(workflow.jobs.native_unix.if).toBe(
      `(${originalTrigger}) && ` +
        "(github.event_name != 'workflow_dispatch' || inputs.nativeTargets != 'windows')"
    )
  })
})
