/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { closeSync, createReadStream, openSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const OPEN_SCIENCE_PIN = '9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5'
export const HARNESS_PIN = '1cfe254e8d25b15f37048c3730134686abe60335'
export const HARNESS_TREE = 'edc756a4d03a2826a248115482084a176e60e751'
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))
const run = (command, args, cwd, options = {}) =>
  spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
const commandResult = (result) => ({
  status: result.status,
  signal: result.signal,
  error: result.error?.message
})

export function exactElectronVersion(lock, installed, binaryOutput, status = 0) {
  const expected = lock.packages?.['node_modules/electron']?.version
  if (
    status !== 0 ||
    !expected ||
    installed.version !== expected ||
    binaryOutput.trim().replace(/^v/u, '') !== expected
  )
    throw new Error(
      `Electron identity mismatch: lock=${expected}; installed=${installed.version}; binary=${binaryOutput.trim()}`
    )
  return expected
}
export function normalizeVitest(report, root) {
  if (!Array.isArray(report.testResults) || !report.testResults.length)
    throw new Error('No test suite report; validation unavailable')
  const tests = [],
    duplicates = new Map()
  for (const suite of report.testResults) {
    const path = relative(root, suite.name).replaceAll('\\', '/')
    if (
      !path ||
      path.startsWith('../') ||
      !Array.isArray(suite.assertionResults) ||
      (suite.status === 'failed' &&
        !suite.assertionResults.some((entry) => entry.status === 'failed'))
    )
      throw new Error(`Test collection/runtime failure: ${path || suite.name}`)
    for (const assertion of suite.assertionResults) {
      const name = (
        assertion.fullName ?? [...(assertion.ancestorTitles ?? []), assertion.title].join(' ')
      ).replaceAll(root, '<SOURCE>')
      const key = `${path} :: ${name}`,
        ordinal = duplicates.get(key) ?? 0
      duplicates.set(key, ordinal + 1)
      if (
        !['passed', 'failed', 'pending', 'todo', 'skipped', 'disabled'].includes(assertion.status)
      )
        throw new Error(`Unknown test status ${assertion.status}`)
      tests.push({
        id: `${key} :: ${ordinal}`,
        path,
        name,
        status: assertion.status,
        failureMessages: assertion.failureMessages ?? []
      })
    }
  }
  if (!tests.length || tests.length !== report.numTotalTests)
    throw new Error('Incomplete Vitest assertion inventory')
  return tests
}
export function compareInventories(baseline, candidate) {
  // These five names changed only with the user-requested product/artwork replacement. Preserve
  // raw reports and require the corresponding renamed assertion to pass; no arbitrary fuzzy match,
  // removed assertion waiver or exception for an actual failed/skipped candidate is allowed.
  const names = [
    [
      'src/main/app-branding.test.ts',
      'app display branding uses the Open-Science display name in shell and workspace surfaces',
      'app display branding uses the EarthNano display name in shell and workspace surfaces'
    ],
    [
      'src/main/windows-icon-assets.test.ts',
      'Windows icon assets keeps the packaged default synchronized with the V3 light icon',
      'Windows icon assets keeps the packaged default synchronized with the EarthNano light icon'
    ],
    ...['build/icon.ico', 'resources/icon-light.ico', 'resources/icon-dark.ico'].map((path) => [
      'src/main/windows-icon-assets.test.ts',
      `Windows icon assets keeps the V3 ring recognizable in the small frames of '${path}'`,
      `Windows icon assets keeps the EarthNano mark recognizable in the small frames of '${path}'`
    ])
  ]
  const reviewedTestRenames = []
  baseline = baseline.map((test) => {
    for (const [path, before, after] of names) {
      const prefix = `${path} :: ${before} :: `
      if (test.path === path && test.name === before && test.id.startsWith(prefix)) {
        const id = `${path} :: ${after} :: ${test.id.slice(prefix.length)}`
        reviewedTestRenames.push({
          originalId: test.id,
          id,
          reason: 'approved-product-artwork-replacement'
        })
        return { ...test, id, originalId: test.id }
      }
    }
    return test
  })
  const old = new Map(baseline.map((test) => [test.id, test]))
  const current = new Map(candidate.map((test) => [test.id, test]))
  if (old.size !== baseline.length || current.size !== candidate.length)
    throw new Error('Duplicate report identities/shards')
  const regressions = [],
    baselineFailures = [],
    baselineSkips = [],
    candidateFailures = [],
    candidateSkips = []
  for (const test of baseline) {
    if (test.status === 'failed') baselineFailures.push(test)
    else if (test.status !== 'passed') baselineSkips.push(test)
    const now = current.get(test.id)
    if (!now) regressions.push({ id: test.id, reason: 'baseline-test-missing' })
    else if (test.status === 'passed' && now.status !== 'passed')
      regressions.push({ id: test.id, reason: `passed-to-${now.status}` })
  }
  for (const test of candidate) {
    if (test.status === 'failed') {
      candidateFailures.push(test)
      if (old.get(test.id)?.status !== 'failed')
        regressions.push({ id: test.id, reason: 'new-failure' })
    } else if (test.status !== 'passed') {
      candidateSkips.push(test)
    }
  }
  return {
    reviewedTestRenames,
    conclusion: regressions.length ? 'new-regressions' : 'no-new-regressions',
    regressions,
    baselineFailures,
    baselineSkips,
    newSkips: candidateSkips.filter((test) => !old.has(test.id)),
    candidateFailures,
    candidateSkips,
    limitation:
      'Baseline failures/skips remain unresolved evidence, not full acceptance. Equal failing statuses do not prove an identical cause.',
    counts: {
      baseline: baseline.length,
      candidate: candidate.length,
      added: candidate.filter((test) => !old.has(test.id)).length
    }
  }
}
export async function verifyPins(root) {
  const manifest = await json(join(root, 'UPSTREAMS.json'))
  const science = manifest.upstreams.find((entry) => entry.name === 'OpenScience')
  const harness = manifest.upstreams.find((entry) => entry.name === 'Harness²')
  if (
    science?.commit !== OPEN_SCIENCE_PIN ||
    harness?.commit !== HARNESS_PIN ||
    harness?.tree !== HARNESS_TREE
  )
    throw new Error('Upstream pins differ from the independently reviewed CI baseline')
  const originalLicense = run('git', ['show', `${OPEN_SCIENCE_PIN}:LICENSE`], root)
  if (
    originalLicense.status !== 0 ||
    digest(await readFile(join(root, 'LICENSE'))) !== digest(originalLicense.stdout)
  )
    throw new Error('Original OpenScience license differs or cannot be verified')
  return manifest
}
export async function sourceShard({ root, kind, shard, total, out }) {
  if (
    !['baseline', 'candidate'].includes(kind) ||
    !Number.isSafeInteger(shard) ||
    !Number.isSafeInteger(total) ||
    shard < 1 ||
    shard > total
  )
    throw new Error('Invalid source shard')
  await verifyPins(root)
  await mkdir(out, { recursive: true })
  const selected = kind === 'candidate' ? root : join(dirname(root), `earthnano-upstream-${shard}`)
  if (kind === 'baseline') {
    const prepared = run('git', ['worktree', 'add', '--detach', selected, OPEN_SCIENCE_PIN], root)
    if (prepared.status !== 0)
      throw new Error(prepared.stderr || 'Pinned baseline checkout unavailable')
  }
  if (kind === 'baseline' && process.platform === 'win32') {
    const recipe = run(
      'git',
      [
        'diff',
        '--quiet',
        OPEN_SCIENCE_PIN,
        '--',
        'packages/notebook-network-sandbox/vendor/windows-runtime'
      ],
      root
    )
    if (recipe.status !== 0)
      throw new Error('Windows runtime recipes differ; baseline must build its own pinned runtime')
    await cp(
      join(root, 'packages/notebook-network-sandbox/vendor/windows-runtime/x64'),
      join(selected, 'packages/notebook-network-sandbox/vendor/windows-runtime/x64'),
      { recursive: true }
    )
  }
  const metadata = {
    schemaVersion: 1,
    kind,
    shard,
    total,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    image: `${process.env.ImageOS ?? 'local'}:${process.env.ImageVersion ?? 'unknown'}`,
    lockDigest: digest(await readFile(join(selected, 'package-lock.json'))),
    source: run('git', ['rev-parse', 'HEAD'], selected).stdout.trim(),
    stages: [],
    profile: process.platform === 'win32' ? 'original-windows-full' : 'original-full',
    exclusions: [
      'Original platform/test skipIf conditions and explicit opt-in model tests; all are retained in raw inventories'
    ],
    pins: { openScience: OPEN_SCIENCE_PIN, harness: HARNESS_PIN, harnessTree: HARNESS_TREE }
  }
  const env = {
    ...process.env,
    OPEN_SCIENCE_TEST_MAX_WORKERS: '2',
    VITEST_DEFER_COVERAGE_THRESHOLDS: '1',
    VITEST_PORTABLE_CI: '0',
    VITEST_WINDOWS_FULL_TEST: process.platform === 'win32' ? '1' : '0',
    OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS: '[]',
    OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS: '[]'
  }
  // Never inherit opt-in credentials or model-test toggles from the caller's machine.
  for (const name of Object.keys(env))
    if (/(^|_)LIVE($|_)|API_KEY|KEY_FILE/u.test(name)) delete env[name]
  const stage = async (name, command, args, extra = {}) => {
    const state = { name, status: 'running' }
    metadata.stages.push(state)
    await writeFile(join(out, 'source-report.json'), JSON.stringify(metadata, null, 2) + '\n')
    const fd = openSync(join(out, `${name}.log`), 'w')
    let result
    try {
      result = run(command, args, selected, { env, stdio: ['ignore', fd, fd], ...extra })
    } finally {
      closeSync(fd)
    }
    Object.assign(state, commandResult(result))
    await writeFile(join(out, 'source-report.json'), JSON.stringify(metadata, null, 2) + '\n')
    return result.status === 0
  }
  try {
    if (!(await stage('npm-ci', process.execPath, ['scripts/ci/npm-ci.mjs'])))
      throw new Error('Dependency installation unavailable')
    const expected = await json(join(selected, 'package-lock.json')),
      installed = await json(join(selected, 'node_modules/electron/package.json'))
    const probe = run(
      process.execPath,
      ['node_modules/electron/cli.js', '-p', 'process.versions.electron'],
      selected,
      { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
    )
    metadata.electron = exactElectronVersion(expected, installed, probe.stdout ?? '', probe.status)
    await stage('pretest', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'pretest'], {
      shell: process.platform === 'win32'
    })
    await stage(
      'typecheck',
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'typecheck:compiled'],
      { shell: process.platform === 'win32' }
    )
    await stage('tests', process.execPath, [
      'node_modules/vitest/vitest.mjs',
      'run',
      `--shard=${shard}/${total}`,
      '--maxWorkers=2',
      '--testTimeout=30000',
      '--hookTimeout=60000',
      '--reporter=json',
      `--outputFile=${join(out, 'vitest.json')}`
    ])
    metadata.tests = normalizeVitest(await json(join(out, 'vitest.json')), selected)
  } catch (error) {
    metadata.unavailable = error.message
  }
  await writeFile(join(out, 'source-report.json'), JSON.stringify(metadata, null, 2) + '\n')
  if (metadata.unavailable) throw new Error(metadata.unavailable)
}
export async function compareReports(root, out) {
  const reports = []
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name === 'source-report.json') reports.push(await json(path))
    }
  }
  await walk(root)
  const results = []
  for (const platform of ['darwin', 'linux', 'win32']) {
    const expectedTotal = platform === 'win32' ? 8 : 4
    const sets = {}
    for (const kind of ['baseline', 'candidate']) {
      const selected = reports.filter(
        (report) => report.platform === platform && report.kind === kind
      )
      if (
        selected.length !== expectedTotal ||
        selected.some(
          (report) =>
            report.total !== expectedTotal ||
            report.unavailable ||
            !Array.isArray(report.tests) ||
            !report.tests.length
        ) ||
        new Set(selected.map((report) => report.shard)).size !== expectedTotal
      )
        throw new Error(`Missing/unavailable ${platform} ${kind} shards`)
      sets[kind] = selected
    }
    const baseline = sets.baseline,
      candidate = sets.candidate
    if (
      [...baseline, ...candidate].some(
        (report) =>
          report.node !== baseline[0].node ||
          report.arch !== baseline[0].arch ||
          report.electron !== baseline[0].electron ||
          report.profile !== baseline[0].profile ||
          report.image !== baseline[0].image
      )
    )
      throw new Error(`Unmatched baseline environment: ${platform}`)
    if (baseline.some((report) => report.source !== OPEN_SCIENCE_PIN))
      throw new Error('Wrong baseline source')
    if (
      candidate.some((report) => !/^[a-f0-9]{40}$/u.test(report.source)) ||
      new Set(candidate.map((report) => report.source)).size !== 1
    )
      throw new Error('Candidate source identity differs between shards')
    const comparison = compareInventories(
      baseline.flatMap((report) => report.tests),
      candidate.flatMap((report) => report.tests)
    )
    comparison.stageRegressions = candidate.flatMap((report) =>
      report.stages
        .filter(
          (stage) =>
            stage.name !== 'tests' &&
            stage.status !== 0 &&
            !baseline
              .find((entry) => entry.shard === report.shard)
              .stages.some((old) => old.name === stage.name && old.status !== 0)
        )
        .map((stage) => ({ shard: report.shard, ...stage }))
    )
    results.push({
      platform,
      environment: {
        node: baseline[0].node,
        arch: baseline[0].arch,
        electron: baseline[0].electron
      },
      ...comparison
    })
  }
  await mkdir(out, { recursive: true })
  await writeFile(
    join(out, 'comparison.json'),
    JSON.stringify({ schemaVersion: 1, results }, null, 2) + '\n'
  )
  const markdown = [
    '# EarthNano pinned source comparison',
    '',
    ...results.flatMap((result) => [
      `## ${result.platform}`,
      `- Outcome: ${result.conclusion}`,
      `- Baseline tests: ${result.counts.baseline}; candidate: ${result.counts.candidate}; added: ${result.counts.added}`,
      `- Baseline failures: ${result.baselineFailures.length}; skips: ${result.baselineSkips.length}; candidate failures: ${result.candidateFailures.length}; skips: ${result.candidateSkips.length}`,
      `- New test regressions: ${result.regressions.length}; stage regressions: ${result.stageRegressions.length}`,
      `- ${result.limitation}`,
      ''
    ])
  ].join('\n')
  await writeFile(join(out, 'comparison.md'), markdown)
  if (process.env.GITHUB_STEP_SUMMARY)
    await writeFile(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: 'a' })
  if (results.some((result) => result.regressions.length || result.stageRegressions.length))
    throw new Error(
      'EarthNano introduces source regressions; inspect comparison.json and original logs'
    )
}
export async function artifactManifest(root, out) {
  const upstreams = await verifyPins(root)
  const tracked = run('git', ['status', '--porcelain', '--untracked-files=no'], root)
  const sourceDirty = tracked.status !== 0 || Boolean(tracked.stdout.trim())
  let electron
  try {
    const lock = await json(join(root, 'package-lock.json')),
      installed = await json(join(root, 'node_modules/electron/package.json'))
    const probe = run(
      process.execPath,
      ['node_modules/electron/cli.js', '-p', 'process.versions.electron'],
      root,
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    )
    electron = {
      expected: lock.packages['node_modules/electron'].version,
      installed: installed.version,
      binary: probe.stdout.trim(),
      status: probe.status
    }
  } catch (error) {
    electron = { unavailable: error.message }
  }
  const paths = [
    'package.json',
    'package-lock.json',
    'UPSTREAMS.json',
    'LICENSE',
    'vendor/harness2/LICENSE',
    'src/renderer/src/assets/provider-icons/LobeHub-icons-LICENSE',
    'electron-builder.yml',
    'build/icon.icns',
    'build/icon.ico',
    'build/icon.png'
  ]
  const files = []
  for (const path of paths) {
    const bytes = await readFile(join(root, path))
    files.push({ path, bytes: bytes.length, sha256: digest(bytes) })
  }
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await walk(path)
      else {
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(path)) hash.update(chunk)
        files.push({
          path: relative(root, path).replaceAll('\\', '/'),
          bytes: (await stat(path)).size,
          sha256: hash.digest('hex')
        })
      }
    }
  }
  try {
    await walk(join(root, 'build/icon.icon'))
    await walk(join(root, 'dist'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(out, { recursive: true })
  const pkg = await json(join(root, 'package.json'))
  await writeFile(
    join(out, 'artifact-manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        source: run('git', ['rev-parse', 'HEAD'], root).stdout.trim(),
        sourceTree: run('git', ['rev-parse', 'HEAD^{tree}'], root).stdout.trim(),
        sourceDirty,
        upstreams,
        electron,
        distribution: 'unsigned-ci',
        packageArtifactCount: files.filter((file) =>
          /^dist\/[^/]+\.(dmg|zip|exe|AppImage|deb)$/u.test(file.path)
        ).length,
        version: pkg.version,
        productName: pkg.productName,
        platform: process.platform,
        arch: process.arch,
        files
      },
      null,
      2
    ) + '\n'
  )
  if (sourceDirty)
    throw new Error(
      'Tracked source changed after checkout; manifest cannot attest the reviewed commit'
    )
}
const args = process.argv.slice(2),
  value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(value('--root') ?? '.'),
    out = resolve(value('--out') ?? 'test-results/earthnano-ci')
  try {
    if (args[0] === 'source')
      await sourceShard({
        root,
        kind: value('--kind'),
        shard: Number(value('--shard')),
        total: Number(value('--total') ?? 4),
        out
      })
    else if (args[0] === 'compare') await compareReports(resolve(value('--reports')), out)
    else if (args[0] === 'manifest') await artifactManifest(root, out)
    else if (args[0] === 'pins') await verifyPins(root)
    else if (args[0] === 'electron') {
      const probe = run(
        process.execPath,
        ['node_modules/electron/cli.js', '-p', 'process.versions.electron'],
        root,
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
      )
      exactElectronVersion(
        await json(join(root, 'package-lock.json')),
        await json(join(root, 'node_modules/electron/package.json')),
        probe.stdout ?? '',
        probe.status
      )
    } else throw new Error('Expected source, compare, manifest or pins')
  } catch (error) {
    await mkdir(out, { recursive: true })
    await writeFile(
      join(out, 'validation-unavailable.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          command: args[0],
          platform: process.platform,
          node: process.version,
          error: error.message
        },
        null,
        2
      ) + '\n'
    )
    throw error
  }
}
