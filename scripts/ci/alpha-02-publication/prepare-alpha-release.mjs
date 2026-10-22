// Temporary publication operation only; never imported by the application or merged into product.
// Adapted from the prior prepare-patch-release.mjs, with no Linux waiver.
// HOLD: source/PR29/Unix bindings are updated to reviewed ca96; Windows native ID is not yet bound.
// Both merged PRs and all same-head successful original runs remain mandatory; see NOTES.md.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

export const configuration = Object.freeze({
  repository: 'lust0yixiong/EarthNano', version: '0.2.0-alpha.1', tag: 'v0.2.0-alpha.1',
  source: 'ca96faed10916edde870aae47da6d70f31e55300', sourceTree: 'b95c300ffd15dd71dc116fa9de1ba721036b1377', unixRun: '39746583897',
  sourceRuns: [
    { id: '39734082630', pr: 28, head: '585485e10d5f90a01d1b71c4fb6a77c3a74b5a5b' },
    { id: '39744881823', pr: 29, head: 'ca96faed10916edde870aae47da6d70f31e55300' }
  ]
})
export const targets = [
  ['macos-26', 'macos-arm64', 'darwin', 'arm64'],
  ['macos-26-intel', 'macos-x64', 'darwin', 'x64'],
  ['ubuntu-24.04', 'linux-x64', 'linux', 'x64'],
  ['ubuntu-24.04-arm', 'linux-arm64', 'linux', 'arm64'],
  ['windows-2022', 'windows-x64', 'win32', 'x64']
]
export function installerNames(platform, arch) {
  const v = configuration.version
  return platform === 'darwin'
    ? [`EarthNano-${v}-mac-${arch}.dmg`, `EarthNano-${v}-mac-${arch}.zip`]
    : platform === 'linux'
      ? [`EarthNano-${v}-linux-${arch === 'x64' ? 'x86_64' : arch}.AppImage`, `EarthNano_${v}_${arch === 'x64' ? 'amd64' : 'arm64'}.deb`]
      : [`EarthNano-${v}-win-x64-setup.exe`]
}
const expectedInstallers = targets.flatMap(([, , platform, arch]) => installerNames(platform, arch)).sort()
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const save = async (path, value) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n')
}
export async function fileRecord(path) {
  const info = await lstat(path)
  assert(info.isFile() && !info.isSymbolicLink() && info.size > 0, `Not a nonempty regular file: ${path}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { bytes: info.size, sha256: hash.digest('hex') }
}
const command = (program, args, options = {}) => execFileSync(program, args, {
  encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, ...options
})
const git = (source, ...args) => command('git', args, { cwd: source }).trim()
const api = path => JSON.parse(command('gh', ['api', '--method', 'GET', `repos/${configuration.repository}/${path}`]))
const pages = (path, key) => JSON.parse(command('gh', [
  'api', '--method', 'GET', '--paginate', '--slurp', `repos/${configuration.repository}/${path}`
])).flatMap(page => page[key])
const post = (path, payload) => JSON.parse(command('gh', [
  'api', '--method', 'POST', `repos/${configuration.repository}/${path}`, '--input', '-'
], { input: JSON.stringify(payload) }))
const matchesJob = (job, name) => job.name.split(' / ').includes(name)
const requireJob = (jobs, name) => {
  const selected = jobs.filter(job => matchesJob(job, name))
  assert.equal(selected.length, 1, `Exactly one required job: ${name}`)
  assert.equal(selected[0].status, 'completed', name)
  assert.equal(selected[0].conclusion, 'success', name)
  return selected[0]
}
export function requireSuccessfulRun(run, head, event) {
  assert.equal(run.head_sha, head)
  assert.equal(run.path, '.github/workflows/earthnano-ci.yml')
  assert.equal(run.event, event)
  assert.equal(run.status, 'completed', `Run ${run.id} is not complete`)
  assert.equal(run.conclusion, 'success', `Run ${run.id} did not succeed`)
  assert(Number.isSafeInteger(run.run_attempt) && run.run_attempt >= 1)
  assert.equal(run.repository.full_name, configuration.repository)
}
const stableRelease = release => ({
  ...Object.fromEntries(['id', 'tag_name', 'target_commitish', 'name', 'body', 'draft', 'prerelease', 'published_at']
    .map(key => [key, release[key] ?? null])),
  assets: release.assets.map(asset => Object.fromEntries(
    ['id', 'name', 'size', 'digest', 'content_type', 'created_at'].map(key => [key, asset[key] ?? null])
  )).sort((a, b) => a.name.localeCompare(b.name))
})
async function preserve(operation, evidence, label) {
  const observations = []
  for (const tag of ['v0.1.0-alpha.1', 'v0.1.1-alpha.1', 'alpha']) {
    const prior = await readJson(join(operation, `preserved-${tag}.json`))
    const release = api(`releases/${prior.release.id}`)
    const ref = api(`git/ref/tags/${tag}`)
    assert.deepEqual(stableRelease(release), stableRelease(prior.release), `Existing release changed: ${tag}`)
    assert.deepEqual(ref.object, prior.ref.object, `Existing tag changed: ${tag}`)
    observations.push({ tag, release, ref })
  }
  await save(join(evidence, `old-releases-${label}.json`), observations)
}
async function stablePublisherGuard(evidence, label) {
  const workflow = api('actions/workflows/390127771')
  assert.equal(workflow.path, '.github/workflows/release.yml')
  assert.equal(workflow.state, 'disabled_manually', 'Original stable publisher must remain disabled')
  const runs = pages('actions/workflows/390127771/runs?per_page=100', 'workflow_runs')
  assert.equal(runs.filter(run => run.status !== 'completed').length, 0, 'An active stable Release run exists')
  await save(join(evidence, `stable-publisher-${label}.json`), { workflow, runs })
}
async function inspectRun(id, evidence) {
  const run = api(`actions/runs/${id}`)
  const jobs = pages(`actions/runs/${id}/attempts/${run.run_attempt}/jobs?per_page=100`, 'jobs')
  const artifacts = pages(`actions/runs/${id}/artifacts?per_page=100`, 'artifacts')
  await save(join(evidence, `run-${id}.json`), { run, jobs, artifacts })
  return { run, jobs, artifacts }
}
function requireArtifact(record, name, job) {
  const found = record.artifacts.filter(artifact => artifact.name === name)
  assert.equal(found.length, 1, `Exactly one original artifact: ${name}`)
  assert.equal(found[0].expired, false, `Expired artifact: ${name}`)
  assert.match(found[0].digest, /^sha256:[a-f0-9]{64}$/)
  if (job) {
    const created = Date.parse(found[0].created_at)
    assert(created >= Date.parse(job.started_at) && created <= Date.parse(job.completed_at), `Artifact outside successful current-attempt job: ${name}`)
  }
}
async function gates(source, root, operation, windowsRun) {
  assert.equal(git(source, 'rev-parse', 'HEAD'), configuration.source)
  assert.equal(git(source, 'rev-parse', 'HEAD^{tree}'), configuration.sourceTree)
  assert.equal(git(source, 'status', '--porcelain', '--untracked-files=no'), '')
  assert.equal((await readJson(join(source, 'package.json'))).version, configuration.version)
  assert.match(windowsRun, /^[1-9][0-9]*$/)
  assert(![configuration.unixRun, ...configuration.sourceRuns.map(item => item.id)].includes(windowsRun))
  const evidence = join(root, 'evidence')
  await preserve(operation, evidence, 'before')
  await stablePublisherGuard(evidence, 'prepare')
  // Both PRs must be merged at the exact reviewed heads. No pending Linux exception.
  for (const expected of configuration.sourceRuns) {
    const pr = api(`pulls/${expected.pr}`)
    assert.equal(pr.merged, true, `PR${expected.pr} must be merged`)
    assert.equal(pr.head.sha, expected.head)
    assert.equal(pr.base.ref, 'main')
    assert.equal(pr.head.repo.full_name, configuration.repository)
    assert.equal(pr.base.repo.full_name, configuration.repository)
    await save(join(evidence, `pr-${expected.pr}.json`), pr)
    const record = await inspectRun(expected.id, evidence)
    requireSuccessfulRun(record.run, expected.head, 'pull_request')
    assert(record.run.pull_requests.some(item => item.number === expected.pr && item.head.sha === expected.head))
    requireJob(record.jobs, 'Resolve original platform sharding')
    requireJob(record.jobs, 'Enforce pinned original source comparison')
    requireJob(record.jobs, 'Pinned Harness source and original unittest comparison (Python 3.12)')
    requireJob(record.jobs, 'Source ubuntu-24.04 cohort 1/4')
    for (const kind of ['baseline', 'candidate']) for (let shard = 1; shard <= 4; shard++) {
      requireJob(record.jobs, `Source macos-15 ${kind} ${shard}/4`)
      requireArtifact(record, `earthnano-source-macos-15-${kind}-${shard}`)
    }
    requireArtifact(record, 'earthnano-source-ubuntu-24.04-cohort-1')
    requireArtifact(record, 'earthnano-harness-comparison')
    requireArtifact(record, 'earthnano-source-comparison')
  }
  // Ensure the exact reviewed source is in merged main; tag stays at exact reviewed source, not a moving branch.
  const main = api('commits/main')
  assert.equal(command('git', ['merge-base', '--is-ancestor', configuration.source, main.sha], { cwd: source }), '')
  await save(join(evidence, 'merged-main.json'), main)
  const unix = await inspectRun(configuration.unixRun, evidence)
  requireSuccessfulRun(unix.run, configuration.source, 'push')
  assert.equal(unix.run.head_branch, 'ci/earthnano-native')
  const windows = await inspectRun(windowsRun, evidence)
  requireSuccessfulRun(windows.run, configuration.source, 'workflow_dispatch')
  assert.equal(windows.run.head_branch, 'ci/earthnano-native')
  requireJob(windows.jobs, 'Original pinned Windows Notebook runtime')
  for (const [os, target, platform] of targets) {
    const record = platform === 'win32' ? windows : unix
    const job = requireJob(record.jobs, `Unsigned native build and original launch ${os}`)
    const smokeName = platform === 'win32'
      ? 'Original Windows installed resource, RPC and launch smoke'
      : platform === 'darwin'
        ? 'Original macOS DMG/ZIP resource, catalog/fallback and launch smoke'
        : 'Original Linux DEB lifecycle, AppImage resources and installed launch smoke'
    assert.equal(job.steps.filter(step => step.name === smokeName && step.conclusion === 'success').length, 1)
    requireArtifact(record, `earthnano-unsigned-${os}`, job)
    requireArtifact(record, `earthnano-native-evidence-${os}`, job)
    const log = command('gh', ['api', `repos/${configuration.repository}/actions/jobs/${job.id}/logs`], { encoding: null })
    await writeFile(join(evidence, `native-${target}-job.log.gz`), gzipSync(log))
  }
  await save(join(evidence, 'gates.json'), {
    verified: true, source: configuration.source, sourceTree: configuration.sourceTree, version: configuration.version, windowsRun,
    unixRun: configuration.unixRun, sourceRuns: configuration.sourceRuns,
    limitation: 'Original comparison admits inherited failures/skips; success is not all tests passing. No deferred required CI, signed-package, model-quality, previous-Windows-upgrade or Windows-optimization claim.'
  })
}
async function walkReports(directory) {
  const records = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    assert(!entry.isSymbolicLink(), path)
    if (entry.isDirectory()) records.push(...await walkReports(path))
    else if (entry.name === 'source-report.json') records.push(await readJson(path))
  }
  return records
}
async function compare(source, root) {
  // Original scripts only, same bytes at both reviewed PR heads (version/retention and localized title metadata only in ca96).
  for (const path of ['scripts/ci/earthnano-source.mjs', 'scripts/ci/earthnano-harness-compare.mjs'])
    for (const expected of configuration.sourceRuns)
      assert.equal(command('git', ['show', `${expected.head}:${path}`], { cwd: source }), await readFile(join(source, path), 'utf8'))
  const { compareReports } = await import(pathToFileURL(join(source, 'scripts/ci/earthnano-source.mjs')))
  const { compareHarnessReports } = await import(pathToFileURL(join(source, 'scripts/ci/earthnano-harness-compare.mjs')))
  for (const expected of configuration.sourceRuns) {
    const inputs = join(root, 'inputs', `source-${expected.id}`)
    const reports = await walkReports(join(inputs, 'reports'))
    assert.equal(reports.length, 16, `Full original 16 reports required for ${expected.id}`)
    const candidates = reports.filter(report => report.kind === 'candidate')
    assert.equal(candidates.length, 8)
    const candidateSources = [...new Set(candidates.map(report => report.source))]
    assert.equal(candidateSources.length, 1)
    const candidate = api(`commits/${candidateSources[0]}`)
    const head = api(`commits/${expected.head}`)
    assert.equal(candidate.commit.tree.sha, head.commit.tree.sha, 'Actual PR merge checkout tree must equal reviewed PR head tree')
    const out = join(root, 'evidence', `source-${expected.id}-comparison`)
    await compareReports(join(inputs, 'reports'), out, ['darwin', 'linux'])
    const original = await readJson(join(inputs, 'comparison', 'comparison.json'))
    assert.deepEqual(await readJson(join(out, 'comparison.json')), original, 'Replayed comparison differs from original CI output')
    const harnessRoot = join(inputs, 'harness')
    const baseline = await readJson(join(harnessRoot, 'harness-baseline.json'))
    const harnessCandidate = await readJson(join(harnessRoot, 'harness-candidate.json'))
    assert.equal(harnessCandidate.source.commit, candidateSources[0])
    const result = compareHarnessReports(baseline, harnessCandidate)
    assert.equal(result.regressions.length, 0)
    const originalHarness = await readJson(join(harnessRoot, 'harness-comparison.json'))
    assert.deepEqual({ schemaVersion: 1, python: baseline.python, ...result }, originalHarness)
    await save(join(out, 'actual-checkout-and-harness.json'), {
      pr: expected.pr, reviewedHead: expected.head, actualCheckout: candidateSources[0],
      actualTree: candidate.commit.tree.sha, originalRun: expected.id, harness: result
    })
  }
}
export async function verifyManifestFile(manifest, file, name) {
  const records = manifest.files.filter(item => item.path === `dist/${name}`)
  assert.equal(records.length, 1, `Exactly one original manifest entry: ${name}`)
  const actual = await fileRecord(file)
  assert.equal(actual.bytes, records[0].bytes, `Source manifest size mismatch: ${name}`)
  assert.equal(actual.sha256, records[0].sha256, `Source manifest SHA mismatch: ${name}`)
  return actual
}
async function collect(source, root) {
  const gatesReceipt = await readJson(join(root, 'evidence/gates.json'))
  assert.equal(gatesReceipt.verified, true)
  const tree = git(source, 'rev-parse', 'HEAD^{tree}')
  assert.equal(tree, configuration.sourceTree)
  const upstreams = await readJson(join(source, 'UPSTREAMS.json'))
  const lock = await readJson(join(source, 'package-lock.json'))
  const assets = join(root, 'assets')
  await mkdir(assets) // Never overwrite or reuse a partially staged set.
  const origins = []
  const { writePlatformEvidence } = await import(pathToFileURL(join(source, 'scripts/ci/release-certification-evidence.mjs')))
  for (const [os, target, platform, arch] of targets) {
    const packages = join(root, 'inputs/packages', `earthnano-unsigned-${os}`)
    const evidence = join(root, 'inputs/native', `earthnano-native-evidence-${os}`)
    const manifestPath = join(evidence, 'test-results/native-evidence/artifact-manifest.json')
    const manifest = await readJson(manifestPath)
    const runId = platform === 'win32' ? gatesReceipt.windowsRun : configuration.unixRun
    const originalRun = (await readJson(join(root, 'evidence', `run-${runId}.json`))).run
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.source, configuration.source)
    assert.equal(manifest.sourceTree, tree)
    assert.equal(manifest.sourceDirty, false)
    assert.equal(manifest.version, configuration.version)
    assert.equal(manifest.productName, 'EarthNano')
    assert.equal(manifest.platform, platform)
    assert.equal(manifest.arch, arch)
    assert.equal(manifest.distribution, 'unsigned-ci')
    const installers = installerNames(platform, arch)
    assert.equal(manifest.packageArtifactCount, installers.length)
    assert.deepEqual(manifest.upstreams, upstreams)
    const electronVersion = lock.packages['node_modules/electron'].version
    assert.deepEqual(manifest.electron, { expected: electronVersion, installed: electronVersion, binary: electronVersion, status: 0 })
    // Also bind lock/pins/build metadata to the exact checkout, beyond manifest self-declarations.
    for (const name of ['package.json', 'package-lock.json', 'UPSTREAMS.json', 'electron-builder.yml']) {
      const records = manifest.files.filter(item => item.path === name)
      assert.equal(records.length, 1, name)
      assert.deepEqual(await fileRecord(join(source, name)), { bytes: records[0].bytes, sha256: records[0].sha256 })
    }
    await save(join(root, 'evidence', `source-manifest-${target}.json`), manifest)
    await fileRecord(manifestPath)
    await link(manifestPath, join(assets, `source-manifest-${target}.json`))
    const feed = platform === 'darwin' ? 'alpha-mac.yml' : platform === 'win32' ? 'alpha.yml' : arch === 'arm64' ? 'alpha-linux-arm64.yml' : 'alpha-linux.yml'
    const allowed = new Set([...installers, ...installers.map(name => `${name}.blockmap`), feed])
    const names = (await readdir(packages)).sort()
    const expected = manifest.files.filter(item => /^dist\/[^/]+$/u.test(item.path))
      .map(item => item.path.slice(5))
      .filter(name => /\.(dmg|zip|exe|AppImage|deb|blockmap)$/u.test(name) || /^alpha.*\.yml$/u.test(name)).sort()
    assert.deepEqual(names, expected, `Retain every original package/feed/blockmap for ${target}`)
    for (const name of names) assert(allowed.has(name), `Unexpected target artifact: ${name}`)
    for (const name of [...installers, feed, ...(platform === 'win32' ? [`${installers[0]}.blockmap`] : [])]) assert(names.includes(name), `Missing ${name}`)
    const stage = async (path, name, destination = name) => {
      const actual = await verifyManifestFile(manifest, path, name)
      await link(path, join(assets, destination)) // Same filesystem, no re-encode, no fallback copy, no clobber.
      origins.push({ target, name: destination, originalName: name, source: manifest.source, sourceTree: tree, runId, ...actual })
    }
    for (const name of names) await stage(join(packages, name), name, name === 'alpha-mac.yml' ? `${arch}-mac.yml` : name)
    const dbName = platform === 'win32' ? 'database-migration-certification.json' : `database-migration-certification-${target}.json`
    await stage(join(evidence, 'dist', dbName), dbName, `database-migration-certification-${target}.json`)
    if (platform === 'win32') {
      // The original native workflow emits DB evidence only. This cert is explicitly runner-derived.
      const output = join(assets, 'certification-windows-x64.json')
      const argv = ['--platform', target, '--artifact-dir', packages, '--output', output,
        '--electron-p0', 'not-applicable', '--visual-regression', 'not-applicable',
        '--package-smoke', 'passed', '--database-migration-certification', join(evidence, 'dist', dbName), '--authenticode', 'not-required']
      const environment = { GITHUB_SHA: originalRun.head_sha, GITHUB_RUN_ID: String(originalRun.id),
        GITHUB_RUN_ATTEMPT: String(originalRun.run_attempt), GITHUB_REPOSITORY: originalRun.repository.full_name,
        GITHUB_REF: `refs/heads/${originalRun.head_branch}` }
      await writePlatformEvidence({ argv, environment })
      await save(join(root, 'evidence/windows-certification-derivation.json'), {
        kind: 'publication-runner-derived-from-original-successful-native-smoke',
        emittedByOriginalNativeWorkflow: false, writer: 'scripts/ci/release-certification-evidence.mjs',
        writerSha256: (await fileRecord(join(source, 'scripts/ci/release-certification-evidence.mjs'))).sha256,
        environment, argv, certificate: await fileRecord(output), originalRun: originalRun.html_url,
        limitation: 'Unsigned Alpha. No Authenticode, previous-version upgrade, WSL authorization, paid model task or Windows optimization certification.'
      })
      await link(join(root, 'evidence/windows-certification-derivation.json'), join(assets, 'windows-certification-derivation.json'))
    } else {
      const name = `certification-${target}.json`
      await stage(join(evidence, 'dist', name), name)
      const cert = await readJson(join(assets, name))
      assert.equal(cert.source.sha, configuration.source)
      assert.equal(cert.source.runId, runId)
      assert.equal(cert.source.runAttempt, String(originalRun.run_attempt))
      assert.equal(cert.source.repository, configuration.repository)
    }
  }
  const actualInstallers = origins.filter(item => /\.(dmg|zip|exe|AppImage|deb)$/u.test(item.name))
  assert.deepEqual(actualInstallers.map(item => item.name).sort(), expectedInstallers)
  await save(join(root, 'evidence/staging-origins.json'), origins)
  await writeFile(join(assets, 'SHA256SUMS.txt'), actualInstallers.sort((a, b) => a.name.localeCompare(b.name))
    .map(item => `${item.sha256}  ${item.name}\n`).join(''))
}
async function finalize(root) {
  const assets = join(root, 'assets')
  for (const name of ['RELEASE-CERTIFICATION.json', 'alpha-mac.yml', 'version.json']) await fileRecord(join(assets, name))
  const manifest = await readJson(join(assets, 'version.json'))
  assert.equal(manifest.version, configuration.version)
  const origins = await readJson(join(root, 'evidence/staging-origins.json'))
  const expected = [...origins.map(item => item.name),
    ...targets.map(([, target]) => `source-manifest-${target}.json`),
    'certification-windows-x64.json', 'windows-certification-derivation.json',
    'RELEASE-CERTIFICATION.json', 'alpha-mac.yml', 'version.json', 'SHA256SUMS.txt'].sort()
  const names = (await readdir(assets)).sort()
  assert.deepEqual(names, expected, 'Unexpected/missing asset outside the complete staged set')
  const records = []
  for (const name of names) records.push({ name, ...await fileRecord(join(assets, name)) })
  assert.deepEqual(records.filter(item => /\.(dmg|zip|exe|AppImage|deb)$/u.test(item.name)).map(item => item.name).sort(), expectedInstallers)
  await save(join(root, 'evidence/prepared-file-digests.json'), { verified: true, source: configuration.source, version: configuration.version, files: records })
}
async function requireMissing(path) {
  try {
    command('gh', ['api', '--include', `repos/${configuration.repository}/${path}`])
  } catch (error) {
    // Only an actual HTTP404 is absence; auth, rate limit, network and5xx all fail closed.
    assert.match(String(error.stdout), /^HTTP\/[\d.]+ 404 /m, `${path} must return HTTP404`)
    return
  }
  throw new Error(`Refusing existing resource: ${path}`)
}
async function draft(root, operation) {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/ci/earthnano-0.2-publication')
  const evidence = join(root, 'evidence')
  const assets = join(root, 'assets')
  const prepared = await readJson(join(evidence, 'prepared-file-digests.json'))
  assert.equal(prepared.source, configuration.source)
  assert.equal(prepared.version, configuration.version)
  assert.equal(prepared.verified, true)
  assert.deepEqual((await readdir(assets)).sort(), prepared.files.map(file => file.name).sort())
  for (const file of prepared.files) assert.deepEqual(await fileRecord(join(assets, file.name)), { bytes: file.bytes, sha256: file.sha256 })
  // Recheck mutable GitHub gates immediately before the only mutation job creates a tag/draft.
  // A read-only exact checkout is also supplied to this job for the same original gate evaluation.
  await gates(resolve(process.env.ALPHA_SOURCE_ROOT), root, operation, process.env.ALPHA_WINDOWS_RUN)
  await preserve(operation, evidence, 'immediately-before-tag')
  await requireMissing(`releases/tags/${configuration.tag}`)
}

// A release-list helper is separate because the REST endpoint returns an array, unlike Actions.
const releaseList = () => JSON.parse(command('gh', [
  'api', '--method', 'GET', '--paginate', '--slurp', `repos/${configuration.repository}/releases?per_page=100`
])).flat()
async function createDraft(root, operation) {
  // All preflight reads/re-hashes run before tag creation. No retries or overwrite on mutation.
  await draft(root, operation)
  assert(!releaseList().some(release => release.tag_name === configuration.tag), 'A draft with this tag already exists')
  await requireMissing(`git/ref/tags/${configuration.tag}`)
  await stablePublisherGuard(join(root, 'evidence'), 'immediately-before-tag')
  const ref = post('git/refs', { ref: `refs/tags/${configuration.tag}`, sha: configuration.source })
  await save(join(root, 'evidence/new-tag-created.json'), ref)
  assert.equal(ref.object.sha, configuration.source)
  const notes = await readFile(join(operation, 'release-notes.md'), 'utf8')
  const release = post('releases', {
    tag_name: configuration.tag, target_commitish: configuration.source,
    name: 'EarthNano 0.2-Alpha — Windows installation repair', body: notes,
    draft: true, prerelease: true, make_latest: 'false'
  })
  await save(join(root, 'evidence/draft-created.json'), release) // Persist exact ID before uploads.
  assert(Number.isSafeInteger(release.id))
  assert.equal(release.draft, true)
  assert.equal(release.prerelease, true)
  assert.equal(release.tag_name, configuration.tag)
  const assets = join(root, 'assets')
  const prepared = await readJson(join(root, 'evidence/prepared-file-digests.json'))
  for (const file of prepared.files) {
    const uploadUrl = new URL(release.upload_url.replace(/\{.*\}$/, ''))
    assert.equal(uploadUrl.origin, 'https://uploads.github.com')
    assert.equal(uploadUrl.pathname, `/repos/${configuration.repository}/releases/${release.id}/assets`)
    uploadUrl.searchParams.set('name', file.name)
    const uploaded = JSON.parse(command('gh', ['api', '--method', 'POST', uploadUrl.href,
      '-H', 'Content-Type: application/octet-stream', '--input', join(assets, file.name)], { timeout: 20 * 60_000 }))
    assert.equal(uploaded.name, file.name)
    assert.equal(uploaded.size, file.bytes)
    assert.equal(uploaded.digest, `sha256:${file.sha256}`)
    await save(join(root, 'evidence', `uploaded-${uploaded.id}.json`), uploaded)
  }
  // Draft tag lookup can404: only use the ID returned from POST /releases.
  const observed = api(`releases/${release.id}`)
  const tag = api(`git/ref/tags/${configuration.tag}`)
  assert.equal(observed.id, release.id)
  assert.equal(observed.tag_name, configuration.tag)
  assert.equal(observed.target_commitish, configuration.source)
  assert.equal(observed.draft, true)
  assert.equal(observed.prerelease, true)
  assert.equal(observed.body, notes)
  assert.equal(observed.name, release.name)
  assert.equal(tag.object.sha, configuration.source)
  assert.deepEqual(observed.assets.map(file => file.name).sort(), prepared.files.map(file => file.name).sort())
  const verified = []
  for (const file of prepared.files) {
    assert.deepEqual(await fileRecord(join(assets, file.name)), { bytes: file.bytes, sha256: file.sha256 })
    const remote = observed.assets.find(asset => asset.name === file.name)
    assert.equal(remote.size, file.bytes)
    assert.equal(remote.digest, `sha256:${file.sha256}`)
    assert.equal(remote.state, 'uploaded')
    verified.push({ ...file, assetId: remote.id, apiDigest: remote.digest })
  }
  await save(join(root, 'evidence/draft.json'), observed)
  await save(join(root, 'evidence/tag.json'), tag)
  await preserve(operation, join(root, 'evidence'), 'after-draft')
  await stablePublisherGuard(join(root, 'evidence'), 'after-draft')
  await save(join(root, 'evidence/draft-verified.json'), {
    verified: true, source: configuration.source, releaseId: release.id, tag: configuration.tag,
    draft: true, prerelease: true, published: false, files: verified,
    limitation: 'Draft only. Separate main-agent review and explicit publish of this exact ID still required. No existing channel/release/tag modified.'
  })
}
export async function main(mode) {
  const root = resolve(process.env.ALPHA_ROOT)
  const source = resolve(process.env.ALPHA_SOURCE_ROOT)
  const operation = resolve(process.env.ALPHA_OPERATION_ROOT)
  assert.equal(process.env.GITHUB_REPOSITORY, configuration.repository)
  assert.equal(process.env.GITHUB_REF, 'refs/heads/ci/earthnano-0.2-publication')
  assert.equal(process.env.ALPHA_SOURCE_SHA, configuration.source)
  await mkdir(join(root, 'evidence'), { recursive: true })
  if (mode === 'gates') await gates(source, root, operation, process.env.ALPHA_WINDOWS_RUN)
  else if (mode === 'compare') await compare(source, root)
  else if (mode === 'collect') await collect(source, root)
  else if (mode === 'finalize') await finalize(root)
  else if (mode === 'draft') await createDraft(root, operation)
  else throw new Error('Expected gates, compare, collect, finalize or draft')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1 })
}
