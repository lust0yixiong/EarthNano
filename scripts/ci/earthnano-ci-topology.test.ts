import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
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
// Run the original CLI at its real filename: its import.meta/argv entry guard intentionally
// does not execute through a symlink. Only the output fixture directory is substituted.
const originalWriter = `'${resolve('scripts/ci/release-certification-evidence.mjs').replaceAll("'", "'\\''")}'`
const databaseCertification = {
  schemaVersion: 1,
  compatibilityFloor: {
    migrationId: '0001_runtime_schema_baseline',
    migrationChecksum: 'e29d0483786c3ed2e1c9cd358369b254a54ccf54213931c5ef71a8fd4e161525',
    sqliteVersion: '3.46.0'
  },
  checks: {
    freshInstall: 'passed',
    legacyAdoption: 'passed',
    reopen: 'passed',
    specialPath: 'passed'
  }
}

describe('EarthNano 0.1 Unix CI scope', () => {
  it('plans one Linux cohort plus eight macOS jobs covering all selected original shards', () => {
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
      expect(Object.keys(plans)).toEqual(['unix_matrix'])
      expect(plans.unix_matrix.include).toHaveLength(9)
      expect(plans.unix_matrix.include.every((row) => !row.os.startsWith('windows-'))).toBe(true)
      expect(plans.unix_matrix.include.filter((row) => row.os === 'ubuntu-24.04')).toEqual([
        { os: 'ubuntu-24.04', kind: 'cohort', shard: 1, total: 4, batch: true }
      ])
      expect(plans.unix_matrix.include.filter((row) => row.os === 'macos-15')).toHaveLength(8)
      expect(plans.unix_matrix.include.filter((row) => !row.batch)).toHaveLength(8)
      const expected = []
      for (const [os, total] of [
        ['ubuntu-24.04', 4],
        ['macos-15', 4]
      ] as const)
        for (const kind of ['baseline', 'candidate'])
          for (let shard = 1; shard <= total; shard++) expected.push({ os, kind, shard, total })
      const rows = plans.unix_matrix.include.flatMap((row) =>
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
      expect(new Set(rows.map((row) => `${row.os}/${row.kind}/${row.shard}`)).size).toBe(16)
      expect(workflow.jobs.plan.outputs).toEqual({
        unix_matrix: '${{ steps.matrix.outputs.unix_matrix }}'
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('requires only Unix source/native jobs and no Windows dependency', () => {
    expect(needs(workflow.jobs.source_unix)).toEqual(['plan'])
    expect(needs(workflow.jobs.native_unix)).toEqual([])
    expect(needs(workflow.jobs.plan)).toEqual([])
    expect(Object.keys(workflow.jobs)).toEqual([
      'plan',
      'source_unix',
      'comparison',
      'harness',
      'native_unix'
    ])
    expect(Object.values(workflow.jobs).flatMap(needs)).not.toContain('windows_runtime')
    for (const [name, output] of [['source_unix', 'unix_matrix']])
      expect(workflow.jobs[name].strategy).toEqual({
        'fail-fast': false,
        matrix: '${{ fromJSON(needs.plan.outputs.' + output + ') }}'
      })
    const targets = ['native_unix'].flatMap((name) => {
      expect(workflow.jobs[name].strategy!['fail-fast']).toBe(false)
      return (workflow.jobs[name].strategy!.matrix as { include: unknown[] }).include
    })
    expect(targets).toEqual([
      { os: 'macos-26', platform: 'mac', arch: 'arm64', subdir: 'osx-arm64' },
      { os: 'macos-26-intel', platform: 'mac', arch: 'x64', subdir: 'osx-64' },
      { os: 'ubuntu-24.04', platform: 'linux', arch: 'x64', subdir: 'linux-64' },
      { os: 'ubuntu-24.04-arm', platform: 'linux', arch: 'arm64', subdir: 'linux-aarch64' }
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
  it('retains the four selected upstream Unix native tuples, including exact Linux ARM64 resources', () => {
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
    const targets = ['native_unix'].flatMap(
      (name) => (workflow.jobs[name].strategy!.matrix as { include: unknown[] }).include
    )
    // Preserve the existing x64 Linux image pin and exact original Unix target architectures/resources.
    const existingRunnerPins: Record<string, string> = {
      'linux-x64': 'ubuntu-24.04'
    }
    expect(targets).toEqual(
      upstream
        .filter((target) => ['mac', 'linux'].includes(target.platform))
        .map((target) => ({
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
      for (const platform of ['unix']) {
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
      // pruning case, Unix certification/feed retention and Linux-only bounded cohort dispatch
      // below to prove all other steps still match d4. No pin, condition, command
      // or artifact waiver.
      expect(digest(shared.jobs[kind].steps)).toBe(
        kind === 'source'
          ? 'd6168ae5600395d53c2b70c35625bbc0ef20fa20430e20c2346e40f625ec61a5'
          : '08ac1443440367a085a27392c3c707cd3f05fc14ff47c0491746cd17a768483f'
      )
      const originalSteps = structuredClone(shared.jobs[kind].steps!)
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
        // The actual commands and fail-closed feed/DB behavior are exercised below against the
        // original writer. Remove only these reviewed retention additions for the d4 comparison.
        const certification = originalSteps.filter(
          (step) => step.name === 'Original Unix package certification evidence'
        )
        expect(certification).toHaveLength(1)
        originalSteps.splice(originalSteps.indexOf(certification[0]), 1)
        const packages = originalSteps.find(
          (step) =>
            step.name ===
            'Retain validated unsigned packages (CI artifacts, no release publication)'
        )!
        const retained =
          'dist/alpha-mac.yml\ndist/alpha-linux.yml\ndist/alpha-linux-arm64.yml\ndist/*.blockmap\n'
        expect(String(packages.with!.path).split(retained)).toHaveLength(2)
        packages.with!.path = String(packages.with!.path).replace(retained, '')
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

  it('records Unix certification only after original smoke and retains isolated target artifacts', () => {
    const steps = readWorkflow('native').jobs.native.steps!
    const certification = steps.find(
      (step) => step.name === 'Original Unix package certification evidence'
    )
    expect(certification).toBeDefined()
    // GitHub implicitly applies success() when the condition contains no status-check function.
    expect(certification!.if).toBe("runner.os == 'macOS' || runner.os == 'Linux'")
    expect(certification).not.toHaveProperty('continue-on-error')
    expect(certification!.env).toBeUndefined()
    for (const smoke of ['scripts/macos-package-smoke.mjs', 'scripts/linux-package-smoke.mjs']) {
      const index = steps.findIndex((step) => step.run?.includes(smoke))
      expect(index).toBeGreaterThan(-1)
      expect(index).toBeLessThan(steps.indexOf(certification!))
    }
    const upload = steps.find(
      (step) =>
        step.name === 'Retain validated unsigned packages (CI artifacts, no release publication)'
    )!
    expect(steps.indexOf(certification!)).toBeLessThan(steps.indexOf(upload))
    expect(upload.with!.name).toBe('earthnano-unsigned-${{ inputs.os }}')
    const evidence = steps.find(
      (step) => step.with?.name === 'earthnano-native-evidence-${{ inputs.os }}'
    )!
    expect(evidence.if).toBe('always()')
    expect(String(evidence.with!.path).split('\n')).toContain('dist/*certification*.json')
  })

  it.each([
    [
      'mac',
      'arm64',
      'macos-arm64',
      'alpha-mac.yml',
      ['EarthNano-0.1.0-alpha.1-mac-arm64.dmg', 'EarthNano-0.1.0-alpha.1-mac-arm64.zip']
    ],
    [
      'mac',
      'x64',
      'macos-x64',
      'alpha-mac.yml',
      ['EarthNano-0.1.0-alpha.1-mac-x64.dmg', 'EarthNano-0.1.0-alpha.1-mac-x64.zip']
    ],
    [
      'linux',
      'x64',
      'linux-x64',
      'alpha-linux.yml',
      ['EarthNano-0.1.0-alpha.1-linux-x86_64.AppImage', 'EarthNano_0.1.0-alpha.1_amd64.deb']
    ],
    [
      'linux',
      'arm64',
      'linux-arm64',
      'alpha-linux-arm64.yml',
      ['EarthNano-0.1.0-alpha.1-linux-arm64.AppImage', 'EarthNano_0.1.0-alpha.1_arm64.deb']
    ]
  ] as const)(
    'retains generated feed/sidecars and writes original evidence for %s-%s',
    (platform, arch, target, feed, packages) => {
      const root = mkdtempSync(join(tmpdir(), 'earthnano-native-release-'))
      try {
        mkdirSync(join(root, 'dist'))
        // These are bounded file fixtures, not package-smoke or database-migration pass claims.
        // The original Mac builder emits external DMG and ZIP blockmaps; the Linux inventory
        // has no external blockmap, so retaining sidecars must not make one mandatory there.
        const sidecars = platform === 'mac' ? packages.map((name) => `${name}.blockmap`) : []
        const produced = [...packages, feed, ...sidecars]
        for (const name of produced)
          writeFileSync(join(root, 'dist', name), `fixture bytes for ${name}`)
        writeFileSync(
          join(root, 'dist/database-migration-certification.json'),
          JSON.stringify(databaseCertification)
        )
        const steps = readWorkflow('native').jobs.native.steps!
        const upload = steps.find(
          (step) =>
            step.name ===
            'Retain validated unsigned packages (CI artifacts, no release publication)'
        )!
        const retained = globSync(String(upload.with!.path).trim().split('\n'), { cwd: root })
        expect(retained.sort()).toEqual(produced.map((name) => `dist/${name}`).sort())
        const record = steps.find(
          (step) => step.name === 'Original Unix package certification evidence'
        )!
        expect(record).toBeDefined()
        const environment = {
          GITHUB_REPOSITORY: 'lust0yixiong/EarthNano',
          GITHUB_REF: 'refs/heads/ci/earthnano-native',
          GITHUB_SHA: 'fixture-source-sha',
          GITHUB_RUN_ID: 'fixture-run',
          GITHUB_RUN_ATTEMPT: '2'
        }
        const result = spawnSync(
          'bash',
          [
            '-e',
            '-o',
            'pipefail',
            '-c',
            record
              .run!.replaceAll('${{ inputs.platform }}', platform)
              .replaceAll('${{ inputs.arch }}', arch)
              .replace('scripts/ci/release-certification-evidence.mjs', originalWriter)
          ],
          { cwd: root, env: { ...process.env, ...environment }, encoding: 'utf8' }
        )
        expect(result.status, result.stderr).toBe(0)
        expect(existsSync(join(root, 'dist/database-migration-certification.json'))).toBe(false)
        expect(
          JSON.parse(
            readFileSync(join(root, `dist/database-migration-certification-${target}.json`), 'utf8')
          )
        ).toEqual(databaseCertification)
        const evidence = JSON.parse(
          readFileSync(join(root, `dist/certification-${target}.json`), 'utf8')
        )
        expect(evidence).toMatchObject({
          platform: target,
          source: {
            repository: environment.GITHUB_REPOSITORY,
            ref: environment.GITHUB_REF,
            sha: environment.GITHUB_SHA,
            runId: environment.GITHUB_RUN_ID,
            runAttempt: environment.GITHUB_RUN_ATTEMPT
          },
          checks: {
            electronP0: 'not-applicable',
            visualRegression: 'not-applicable',
            packageSmoke: 'passed',
            authenticode: 'not-applicable'
          },
          databaseMigration: databaseCertification
        })
        expect(evidence.artifacts).toEqual(
          [...packages].sort().map((name) => ({
            name,
            sha256: createHash('sha256')
              .update(readFileSync(join(root, 'dist', name)))
              .digest('hex')
          }))
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.each(['missing-feed', 'empty-feed', 'missing-database', 'failed-database'] as const)(
    'does not certify native packages with %s even when distributables exist',
    (failure) => {
      const root = mkdtempSync(join(tmpdir(), 'earthnano-native-release-reject-'))
      try {
        mkdirSync(join(root, 'dist'))
        writeFileSync(join(root, 'dist/EarthNano.AppImage'), 'fixture artifact bytes')
        if (failure !== 'missing-feed')
          writeFileSync(
            join(root, 'dist/alpha-linux.yml'),
            failure === 'empty-feed' ? '' : 'fixture feed bytes'
          )
        if (failure !== 'missing-database') {
          const database = structuredClone(databaseCertification)
          if (failure === 'failed-database') database.checks.reopen = 'failed'
          writeFileSync(
            join(root, 'dist/database-migration-certification.json'),
            JSON.stringify(database)
          )
        }
        const record = readWorkflow('native').jobs.native.steps!.find(
          (step) => step.name === 'Original Unix package certification evidence'
        )
        expect(record).toBeDefined()
        const result = spawnSync(
          'bash',
          [
            '-e',
            '-o',
            'pipefail',
            '-c',
            record!
              .run!.replaceAll('${{ inputs.platform }}', 'linux')
              .replaceAll('${{ inputs.arch }}', 'x64')
              .replace('scripts/ci/release-certification-evidence.mjs', originalWriter)
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              GITHUB_SHA: 'fixture-source-sha',
              GITHUB_RUN_ID: 'fixture-run',
              GITHUB_RUN_ATTEMPT: '1'
            },
            encoding: 'utf8'
          }
        )
        expect(result.status).not.toBe(0)
        expect(existsSync(join(root, 'dist/certification-linux-x64.json'))).toBe(false)
        if (failure === 'missing-feed' || failure === 'empty-feed')
          expect(existsSync(join(root, 'dist/database-migration-certification.json'))).toBe(true)
        if (failure === 'failed-database')
          expect(result.stderr).toContain('Invalid packaged database migration certification')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

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
  it('pins the same exact host Node across selected source/native and report helpers', () => {
    expect(readFileSync('.github/earthnano-node-version', 'utf8')).toBe('24.22.0\n')
    const selected = [
      readWorkflow('source').jobs.source,
      readWorkflow('native').jobs.native,
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
  it('bounds Linux cohort at 360 minutes and retains other selected source/native deadlines', () => {
    expect(readWorkflow('source').jobs.source['timeout-minutes']).toBe(
      '${{ inputs.batch && 360 || 90 }}'
    )
    expect(readWorkflow('native').jobs.native['timeout-minutes']).toBe(90)
    expect(workflow.jobs.comparison['timeout-minutes']).toBe(10)
    expect(workflow.jobs.harness['timeout-minutes']).toBe(15)
  })
  it('runs comparison even when source dependencies fail or skip, except the explicit native-only branch', () => {
    const job = workflow.jobs.comparison
    expect(job).not.toHaveProperty('continue-on-error')
    expect(needs(job)).toEqual(['source_unix'])
    expect(job.if).toBe("always() && github.ref != 'refs/heads/ci/earthnano-native'")
    const check = job.steps!.findIndex(
      (step) => step.name === 'Require complete Unix source matrix'
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
      SOURCE_UNIX_RESULT: '${{ needs.source_unix.result }}'
    })
    expect(job.steps![compare].run).toBe(
      'node scripts/ci/earthnano-source.mjs compare --platforms darwin,linux --reports source-reports --out test-results/earthnano-ci'
    )
  })
  it.each([undefined, '', 'skipped', 'failure', 'cancelled', 'neutral'])(
    'rejects missing or non-success matrix status %s before report comparison',
    (status) => {
      const check = workflow.jobs.comparison.steps!.find(
        (step) => step.name === 'Require complete Unix source matrix'
      )!
      for (const failed of ['SOURCE_UNIX_RESULT']) {
        const env: Record<string, string> = {
          SOURCE_UNIX_RESULT: 'success'
        }
        if (status === undefined) delete env[failed]
        else env[failed] = status
        const result = spawnSync(process.execPath, ['-e', check.run!], { env, encoding: 'utf8' })
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain(`Required source matrix did not succeed: ${failed}`)
      }
    }
  )
  it('accepts the successful Unix matrix while leaving report inventory validation mandatory', () => {
    const check = workflow.jobs.comparison.steps!.find(
      (step) => step.name === 'Require complete Unix source matrix'
    )!
    expect(
      spawnSync(process.execPath, ['-e', check.run!], {
        env: { SOURCE_UNIX_RESULT: 'success' }
      }).status
    ).toBe(0)
  })
  it('runs stacked Alpha PRs without widening permissions, push or automatic native triggers', () => {
    expect(workflow.on.pull_request.branches).toEqual(['main', 'feat/alpha-*', 'fix/alpha-*'])
    expect(workflow.on.push.branches).toEqual(['main', 'ci/earthnano-native'])
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.on.pull_request_target).toBeUndefined()
    for (const name of ['native_unix'])
      expect(workflow.jobs[name].if).toBe(
        "(github.event_name == 'workflow_dispatch' && inputs.native) || " +
          "(github.event_name == 'push' && github.ref == 'refs/heads/ci/earthnano-native')"
      )
  })
})
