/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { closeSync, createReadStream, openSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'
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
function inheritedSkippedTaskIds(runtime, tests, assertions, root, platform, report) {
  if (runtime?.taskInventory === undefined) return new Set()
  const inventory = runtime.taskInventory
  if (
    runtime.schemaVersion !== 1 ||
    !['passed', 'failed'].includes(runtime.reason) ||
    !Array.isArray(runtime.unhandledErrors) ||
    runtime.unhandledErrors.length ||
    inventory?.schemaVersion !== 1 ||
    !Array.isArray(inventory.leaves) ||
    inventory.leaves.length !== tests.length
  )
    throw new Error('Incomplete or global/runtime task observation')
  const modes = ['run', 'skip', 'only', 'todo', 'queued']
  const states = [...modes, 'pass', 'fail']
  const validState = (task) =>
    task &&
    modes.includes(task.mode) &&
    typeof task.hasResult === 'boolean' &&
    (task.hasResult ? states.includes(task.resultState) : task.resultState === null)
  const statusMap = {
    pass: 'passed',
    fail: 'failed',
    skip: 'skipped',
    todo: 'todo',
    run: 'pending',
    queued: 'pending',
    only: 'pending'
  }
  const duplicates = new Map()
  const observed = new Map()
  for (const leaf of inventory.leaves) {
    if (
      !validState(leaf) ||
      typeof leaf.file !== 'string' ||
      typeof leaf.name !== 'string' ||
      typeof leaf.fullName !== 'string' ||
      !Array.isArray(leaf.ancestors) ||
      leaf.ancestors.some((ancestor) => !validState(ancestor) || typeof ancestor.name !== 'string')
    )
      throw new Error('Malformed task observation')
    const path = (platform === 'win32' ? win32.relative : relative)(root, leaf.file).replaceAll(
      '\\',
      '/'
    )
    if (!path || path.startsWith('../') || isAbsolute(path) || win32.isAbsolute(path))
      throw new Error('Task observation is outside the source root')
    const names = leaf.ancestors.map((ancestor) => ancestor.name)
    if (leaf.fullName !== (leaf.name ? [...names, leaf.name].join(' ') : names.join(' ')))
      throw new Error('Task observation ancestry differs from its identity')
    const name = leaf.fullName.replaceAll(root, '<SOURCE>')
    const key = `${path} :: ${name}`
    const ordinal = duplicates.get(key) ?? 0
    duplicates.set(key, ordinal + 1)
    observed.set(`${key} :: ${ordinal}`, {
      leaf,
      names,
      status: statusMap[leaf.resultState ?? leaf.mode]
    })
  }
  // Check the pinned JSON reporter's actual leaf-counter predicates, not a tolerated difference.
  const leaves = inventory.leaves
  const observedCounters = {
    numTotalTests: leaves.length,
    numPassedTests: leaves.filter((leaf) => leaf.resultState === 'pass').length,
    numFailedTests: leaves.filter((leaf) => leaf.resultState === 'fail').length,
    numPendingTests: leaves.filter(
      (leaf) =>
        ['run', 'queued'].includes(leaf.resultState) ||
        leaf.mode === 'skip' ||
        leaf.resultState === 'skip'
    ).length,
    numTodoTests: leaves.filter((leaf) => leaf.mode === 'todo').length
  }
  if (Object.entries(observedCounters).some(([key, value]) => report[key] !== value))
    throw new Error('Raw assertion counters differ from actual task observations')
  const inheritedSkips = new Set()
  for (let index = 0; index < tests.length; index++) {
    const test = tests[index],
      assertion = assertions[index],
      evidence = observed.get(test.id)
    if (
      !evidence ||
      evidence.status !== test.status ||
      assertion.title !== evidence.leaf.name ||
      JSON.stringify(assertion.ancestorTitles ?? []) !== JSON.stringify(evidence.names)
    )
      throw new Error('Raw assertion inventory differs from task observations')
    const { leaf } = evidence
    const inheritedSkip =
      test.status === 'pending' &&
      leaf.mode === 'run' &&
      !leaf.hasResult &&
      leaf.resultState === null &&
      assertion.duration === undefined &&
      test.failureMessages.length === 0 &&
      leaf.ancestors.some(
        (ancestor) =>
          ancestor.resultState === 'skip' || (ancestor.mode === 'skip' && !ancestor.hasResult)
      ) &&
      !leaf.ancestors.some((ancestor) => ['run', 'queued'].includes(ancestor.resultState))
    if (test.status === 'pending' && !inheritedSkip)
      throw new Error('Pending task has no complete inherited skip witness')
    if (inheritedSkip) inheritedSkips.add(test.id)
  }
  return inheritedSkips
}
export function normalizeVitest(report, root, platform = process.platform, runtime) {
  if (!report || !Array.isArray(report.testResults) || !report.testResults.length)
    throw new Error('No test suite report; validation unavailable')
  const counters = [
    'numTotalTests',
    'numPassedTests',
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
    'numTotalTestSuites',
    'numPassedTestSuites',
    'numFailedTestSuites',
    'numPendingTestSuites'
  ]
  if (
    counters.some((key) => !Number.isSafeInteger(report[key]) || report[key] < 0) ||
    typeof report.success !== 'boolean' ||
    report.wasInterrupted === true ||
    (report.numRuntimeErrorTestSuites !== undefined && report.numRuntimeErrorTestSuites !== 0) ||
    ['unhandledErrors', 'errors'].some(
      (key) => report[key] !== undefined && (!Array.isArray(report[key]) || report[key].length)
    )
  )
    throw new Error('Malformed or global/runtime Vitest failure')
  const tests = [],
    assertions = [],
    duplicates = new Map()
  for (const suite of report.testResults) {
    if (!suite || typeof suite.name !== 'string') throw new Error('Malformed Vitest suite')
    const path = (platform === 'win32' ? win32.relative : relative)(root, suite.name).replaceAll(
      '\\',
      '/'
    )
    if (
      !path ||
      path.startsWith('../') ||
      isAbsolute(path) ||
      win32.isAbsolute(path) ||
      (suite.message !== undefined && suite.message !== '') ||
      !['passed', 'failed'].includes(suite.status) ||
      !Array.isArray(suite.assertionResults) ||
      (suite.status === 'failed' &&
        !suite.assertionResults.some((entry) => entry.status === 'failed')) ||
      (suite.status === 'passed' &&
        suite.assertionResults.some((entry) => entry.status === 'failed'))
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
      assertions.push(assertion)
      tests.push({
        id: `${key} :: ${ordinal}`,
        path,
        name,
        status: assertion.status,
        failureMessages: assertion.failureMessages ?? []
      })
    }
  }
  const count = (status) => tests.filter((test) => status.includes(test.status)).length
  const inheritedSkips = inheritedSkippedTaskIds(runtime, tests, assertions, root, platform, report)
  const pendingCount = count(['pending', 'skipped', 'disabled'])
  // Vitest 4.1.11 omits unexecuted mode=run leaves under nested skipped suites from this counter.
  // Only a complete, matching actual task observation can account for those specific leaves.
  const omittedInheritedSkips = pendingCount === report.numPendingTests ? 0 : inheritedSkips.size
  if (
    !tests.length ||
    report.numTotalTestSuites < report.testResults.length ||
    tests.length !== report.numTotalTests ||
    count(['passed']) !== report.numPassedTests ||
    count(['failed']) !== report.numFailedTests ||
    pendingCount !== report.numPendingTests + omittedInheritedSkips ||
    report.numTotalTests !==
      report.numPassedTests +
        report.numFailedTests +
        report.numPendingTests +
        report.numTodoTests +
        omittedInheritedSkips ||
    count(['todo']) !== report.numTodoTests ||
    report.numTotalTestSuites !==
      report.numPassedTestSuites + report.numFailedTestSuites + report.numPendingTestSuites ||
    report.success !== (report.numFailedTests === 0 && report.numFailedTestSuites === 0) ||
    (!report.success && report.numFailedTests === 0)
  )
    throw new Error('Incomplete Vitest assertion inventory')
  return tests.map((test) =>
    inheritedSkips.has(test.id) ? { ...test, inheritedSkip: true } : test
  )
}
export function validateSourceExecution(report, runtime) {
  const names = ['npm-ci', 'pretest', 'typecheck', 'tests']
  if (
    !Array.isArray(report.stages) ||
    report.stages.length !== names.length ||
    report.stages.some(
      (stage, index) =>
        !stage ||
        stage.name !== names[index] ||
        !Number.isSafeInteger(stage.status) ||
        stage.status < 0 ||
        stage.status > 255 ||
        stage.signal !== null ||
        (stage.error !== undefined && stage.error !== null)
    ) ||
    report.stages[0].status !== 0
  )
    throw new Error('Missing, interrupted or malformed source stages')
  if (
    !runtime ||
    runtime.schemaVersion !== 1 ||
    !Array.isArray(runtime.unhandledErrors) ||
    runtime.unhandledErrors.length ||
    !['passed', 'failed'].includes(runtime.reason)
  )
    throw new Error('Missing or global/runtime Vitest failure')
  const failed = report.tests.some((test) => test.status === 'failed')
  const stage = report.stages.at(-1)
  if (stage.status !== (failed ? 1 : 0) || runtime.reason !== (failed ? 'failed' : 'passed'))
    throw new Error('Test process outcome is not explained by assertion inventory')
}
export function compareInventories(baseline, candidate) {
  // These exact names changed only with user-requested branding/About changes. Preserve
  // raw reports and require the corresponding renamed assertion to pass; no arbitrary fuzzy match,
  // removed assertion waiver or exception for an actual failed/skipped candidate is allowed.
  const names = [
    [
      'src/renderer/src/pages/settings/AppVersionSection.render.test.tsx',
      'AppVersionSection shows the app name, version, and copyright',
      'AppVersionSection shows the app name and version without the promotional copyright line',
      'approved-about-copyright-line-removal'
    ],
    [
      'src/main/app-branding.test.ts',
      'app display branding uses the Open-Science display name in shell and workspace surfaces',
      'app display branding uses the OneEarth display name in shell and workspace surfaces'
    ],
    [
      'src/main/windows-icon-assets.test.ts',
      'Windows icon assets keeps the packaged default synchronized with the V3 light icon',
      'Windows icon assets keeps the packaged default synchronized with the EarthNano light icon'
    ],
    // Exact display/default-folder test renames only. Every candidate assertion is still required.
    ...[
      ['dataFolderName is Open-Science when packaged', 'dataFolderName is OneEarth when packaged'],
      [
        'dataFolderName is Open-Science-DEV in dev (not packaged)',
        'dataFolderName is OneEarth-DEV in dev (not packaged)'
      ],
      [
        'computeDefaultDataRoot defaults to <home>/Open-Science for a fresh config root',
        'computeDefaultDataRoot defaults to <home>/OneEarth for a fresh config root'
      ],
      [
        'computeDefaultDataRoot does not treat a config root with an Open-Science subdir as legacy',
        'computeDefaultDataRoot does not treat a config root with a OneEarth subdir as legacy'
      ],
      [
        'computeDefaultDataRoot treats an explicitly configured <home>/Open-Science as the committed default',
        'computeDefaultDataRoot treats an explicitly configured <home>/OneEarth as the committed default'
      ],
      [
        'computeDefaultDataRoot (dev mode) defaults to <home>/Open-Science-DEV for a fresh (dev) config root',
        'computeDefaultDataRoot (dev mode) defaults to <home>/OneEarth-DEV for a fresh (dev) config root'
      ],
      [
        'computeDefaultDataRoot (dev mode) prefers an explicitly configured <home>/Open-Science-DEV over legacy data',
        'computeDefaultDataRoot (dev mode) prefers an explicitly configured <home>/OneEarth-DEV over legacy data'
      ]
    ].map(([before, after]) => [
      'src/main/storage-root.test.ts',
      before,
      after,
      'approved-oneearth-display-and-new-folder-name'
    ]),
    [
      'src/renderer/src/components/LegacyDataMoveDialog.render.test.tsx',
      'LegacyDataMoveDialog "Move to Open-Science" hands off to the migration flow (detects sessions first)',
      'LegacyDataMoveDialog "Move to OneEarth" hands off to the migration flow (detects sessions first)',
      'approved-oneearth-display-and-new-folder-name'
    ],
    ...['build/icon.ico', 'resources/icon-light.ico', 'resources/icon-dark.ico'].map((path) => [
      'src/main/windows-icon-assets.test.ts',
      `Windows icon assets keeps the V3 ring recognizable in the small frames of '${path}'`,
      `Windows icon assets keeps the EarthNano mark recognizable in the small frames of '${path}'`
    ])
  ]
  const reviewedTestRenames = []
  baseline = baseline.map((test) => {
    for (const [path, before, after, reason] of names) {
      const prefix = `${path} :: ${before} :: `
      if (test.path === path && test.name === before && test.id.startsWith(prefix)) {
        const id = `${path} :: ${after} :: ${test.id.slice(prefix.length)}`
        reviewedTestRenames.push({
          originalId: test.id,
          id,
          reason: reason ?? 'approved-product-artwork-replacement'
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
export function sourceTestInvocation(args, platform = process.platform) {
  // pretest has its own recorded stage. npm still supplies the original test lifecycle environment.
  return {
    command: platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['--ignore-scripts', 'test', '--', ...args],
    shell: platform === 'win32'
  }
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
    testRoot: selected,
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
  env.EARTHNANO_CI_RUNTIME_REPORT = join(out, 'runtime.json')
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
    const testInvocation = sourceTestInvocation([
      `--shard=${shard}/${total}`,
      '--maxWorkers=2',
      '--testTimeout=30000',
      '--hookTimeout=60000',
      '--reporter=json',
      `--reporter=${fileURLToPath(new URL('./earthnano-runtime-reporter.mjs', import.meta.url))}`,
      `--outputFile=${join(out, 'vitest.json')}`
    ])
    await stage('tests', testInvocation.command, testInvocation.args, {
      shell: testInvocation.shell
    })
    const runtime = await json(join(out, 'runtime.json'))
    metadata.tests = normalizeVitest(
      await json(join(out, 'vitest.json')),
      selected,
      process.platform,
      runtime
    )
    validateSourceExecution(metadata, runtime)
  } catch (error) {
    metadata.unavailable = error.message
  }
  await writeFile(join(out, 'source-report.json'), JSON.stringify(metadata, null, 2) + '\n')
  if (metadata.unavailable) throw new Error(metadata.unavailable)
}
const exists = async (path) => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export function registeredWorktreeMatches(output, selected, platform = process.platform) {
  const absolute = platform === 'win32' ? win32.isAbsolute : isAbsolute
  const key = platform === 'win32' ? win32.normalize : (path) => path
  if (!absolute(selected)) return false
  return output.split('\0').some((field) => {
    if (!field.startsWith('worktree ')) return false
    const registered = field.slice('worktree '.length)
    return absolute(registered) && key(registered) === key(selected)
  })
}

export async function sourceBatch({ root, out }, execute = sourceShard) {
  if (await exists(out)) throw new Error('Source cohort output already exists')
  await mkdir(out, { recursive: true })
  const receipts = []
  for (const kind of ['baseline', 'candidate']) {
    for (let shard = 1; shard <= 4; shard++) {
      const directory = join(out, `${kind}-${shard}`)
      const selected = join(dirname(root), `earthnano-upstream-${shard}`)
      const receipt = { kind, shard, total: 4 }
      if (kind === 'baseline' && (await exists(selected)))
        throw new Error(`Refusing existing baseline checkout: ${selected}`)
      try {
        // Retain the original installer, pretest, types, sequencer, flags and report semantics.
        await execute({ root, kind, shard, total: 4, out: directory })
      } catch (error) {
        receipt.error = error.message
      }
      receipts.push(receipt)
      if (kind === 'baseline' && (await exists(selected))) {
        try {
          // Only remove this batch's previously absent, registered checkout after its own report
          // has been exported. Never recursively delete a guessed path or suppress cleanup errors.
          const report = await json(join(directory, 'source-report.json'))
          const registered = run('git', ['worktree', 'list', '--porcelain', '-z'], root)
          const head = run('git', ['rev-parse', 'HEAD'], selected)
          if (
            report.kind !== kind ||
            report.shard !== shard ||
            report.total !== 4 ||
            report.testRoot !== selected ||
            report.source !== OPEN_SCIENCE_PIN ||
            registered.status !== 0 ||
            !registeredWorktreeMatches(registered.stdout, await realpath(selected)) ||
            head.status !== 0 ||
            head.stdout.trim() !== OPEN_SCIENCE_PIN
          )
            throw new Error('Baseline checkout ownership/report mismatch')
          const removed = run('git', ['worktree', 'remove', '--force', selected], root)
          if (removed.status !== 0 || (await exists(selected)))
            throw new Error(removed.stderr || 'Baseline checkout removal incomplete')
          receipt.cleanup = 'removed-owned-baseline'
        } catch (error) {
          receipt.cleanupError = error.message
          await writeFile(join(out, 'batch-receipt.json'), JSON.stringify(receipts, null, 2) + '\n')
          throw new Error(`Source cohort cleanup failed: ${error.message}`)
        }
      }
      await writeFile(join(out, 'batch-receipt.json'), JSON.stringify(receipts, null, 2) + '\n')
    }
  }
  if (receipts.some((receipt) => receipt.error))
    throw new Error('Source cohort contains unavailable shards; inspect original reports')
}

export function comparisonPlatforms(value = 'darwin,linux,win32') {
  if (typeof value !== 'string') throw new Error('Invalid comparison platforms')
  const platforms = value.split(',')
  if (
    !platforms.length ||
    platforms.some((platform) => !['darwin', 'linux', 'win32'].includes(platform)) ||
    new Set(platforms).size !== platforms.length
  )
    throw new Error('Unknown, empty or duplicate comparison platform')
  return platforms
}
export async function compareReports(root, out, platforms = comparisonPlatforms()) {
  if (
    !Array.isArray(platforms) ||
    platforms.some((platform) => !['darwin', 'linux', 'win32'].includes(platform))
  )
    throw new Error('Invalid comparison platforms')
  platforms = comparisonPlatforms(platforms.join(','))
  const reports = []
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name === 'source-report.json') {
        const report = await json(path)
        if (
          !report ||
          report.schemaVersion !== 1 ||
          typeof report.testRoot !== 'string' ||
          !report.testRoot ||
          !(report.platform === 'win32' ? win32.isAbsolute : isAbsolute)(report.testRoot) ||
          !['darwin', 'linux', 'win32'].includes(report.platform) ||
          !['baseline', 'candidate'].includes(report.kind) ||
          ['node', 'arch', 'electron', 'image'].some(
            (key) => typeof report[key] !== 'string' || !report[key]
          ) ||
          report.profile !==
            (report.platform === 'win32' ? 'original-windows-full' : 'original-full') ||
          !/^[a-f0-9]{64}$/u.test(report.lockDigest) ||
          report.pins?.openScience !== OPEN_SCIENCE_PIN ||
          report.pins?.harness !== HARNESS_PIN ||
          report.pins?.harnessTree !== HARNESS_TREE
        )
          throw new Error('Malformed source report identity')
        if (!platforms.includes(report.platform))
          throw new Error(`Source report outside selected platforms: ${report.platform}`)
        const runtime = await json(join(directory, 'runtime.json'))
        const rawTests = normalizeVitest(
          await json(join(directory, 'vitest.json')),
          report.testRoot,
          report.platform,
          runtime
        )
        if (JSON.stringify(rawTests) !== JSON.stringify(report.tests))
          throw new Error('Source inventory differs from original raw report')
        validateSourceExecution(report, runtime)
        reports.push(report)
      }
    }
  }
  await walk(root)
  if (
    new Set(reports.filter((report) => report.kind === 'candidate').map((report) => report.source))
      .size !== 1
  )
    throw new Error('Candidate source identity differs across platforms')
  for (const kind of ['baseline', 'candidate'])
    if (
      new Set(reports.filter((report) => report.kind === kind).map((report) => report.lockDigest))
        .size !== 1
    )
      throw new Error('Source lockfile identity differs across platforms')
  const results = []
  for (const platform of platforms) {
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
            !Number.isSafeInteger(report.shard) ||
            report.shard < 1 ||
            report.shard > expectedTotal ||
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
      [baseline, candidate].some(
        (reports) => new Set(reports.map((report) => report.lockDigest)).size !== 1
      )
    )
      throw new Error('Source lockfile identity differs between shards')
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
    else if (args[0] === 'source-batch') {
      if (process.platform !== 'linux') throw new Error('Source cohort requires one Linux runner')
      await sourceBatch({ root, out })
    } else if (args[0] === 'compare') {
      if (
        args.filter((arg) => arg === '--platforms').length > 1 ||
        (args.includes('--platforms') && !value('--platforms'))
      )
        throw new Error('Expected one explicit --platforms value')
      await compareReports(
        resolve(value('--reports')),
        out,
        comparisonPlatforms(value('--platforms'))
      )
    } else if (args[0] === 'manifest') await artifactManifest(root, out)
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
    } else throw new Error('Expected source, source-batch, compare, manifest or pins')
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
