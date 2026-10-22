import { createHash } from 'node:crypto'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { dump, load } from 'js-yaml'
import { buildManifest } from './generate-version-manifest.mjs'
import { validateReleasePlatforms } from './release-artifact-validation.mjs'

const repo = process.cwd()
const version = '0.1.0-alpha.1'
const assetBaseUrl = `https://github.com/lust0yixiong/EarthNano/releases/download/v${version}`
const roots: string[] = []
const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'earthnano-alpha-feed-'))
  roots.push(root)
  return root
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const hash = (bytes: string, algorithm = 'sha256', encoding: 'hex' | 'base64' = 'hex'): string =>
  createHash(algorithm).update(bytes).digest(encoding)

type Feed = { version: string; files: Array<{ url: string; size: number; sha512: string }> }
type ReleaseFixture = {
  dir: string
  names: string[]
  bytes: (name: string) => string
  feed: (selected: string[]) => Feed
}
type AlphaOptions = {
  dir: string
  version: string
  channel: string
  assetBaseUrl: string
  requireComplete: boolean
}

// Synthetic bytes exercise publication transforms, not native signing or installation acceptance.
const release = (v = version, channel = 'alpha'): ReleaseFixture => {
  const dir = fixture()
  const names = [
    `EarthNano-${v}-mac-arm64.dmg`,
    `EarthNano-${v}-mac-x64.dmg`,
    `EarthNano-${v}-win-x64-setup.exe`,
    `EarthNano-${v}-linux-x64.AppImage`,
    `EarthNano_${v}_amd64.deb`,
    `EarthNano-${v}-linux-arm64.AppImage`,
    `EarthNano_${v}_arm64.deb`,
    `EarthNano-${v}-mac-arm64.zip`,
    `EarthNano-${v}-mac-x64.zip`
  ]
  const bytes = (name: string): string => `synthetic final bytes for ${name}`
  for (const name of names) writeFileSync(join(dir, name), bytes(name))
  writeFileSync(
    join(dir, 'SHA256SUMS.txt'),
    names.map((name) => `${hash(bytes(name))}  ${name}\n`).join('')
  )
  const feed = (selected: string[]): Feed => ({
    version: v,
    files: selected.map((url) => ({
      url,
      size: Buffer.byteLength(bytes(url)),
      sha512: hash(bytes(url), 'sha512', 'base64')
    }))
  })
  for (const [name, selected] of [
    [`${channel}.yml`, names.slice(2, 3)],
    [`${channel}-linux.yml`, names.slice(3, 5)],
    [`${channel}-linux-arm64.yml`, names.slice(5, 7)],
    [`${channel}-mac.yml`, names.slice(7)]
  ] as Array<[string, string[]]>)
    writeFileSync(join(dir, name), dump(feed(selected)))
  return { dir, names, bytes, feed }
}
const options = (dir: string): AlphaOptions => ({
  dir,
  version,
  channel: 'alpha',
  assetBaseUrl,
  requireComplete: true
})

const unixRelease = (): ReleaseFixture => {
  const fixture = release()
  const names = fixture.names.filter((name) => !name.endsWith('.exe'))
  rmSync(join(fixture.dir, fixture.names[2]))
  rmSync(join(fixture.dir, 'alpha.yml'))
  writeFileSync(
    join(fixture.dir, 'SHA256SUMS.txt'),
    names.map((name) => `${hash(fixture.bytes(name))}  ${name}\n`).join('')
  )
  return { ...fixture, names }
}
const unixOptions = (dir: string): AlphaOptions & { platforms: string } => ({
  ...options(dir),
  platforms: 'mac,linux'
})

it('requires an explicit known unique release scope without changing the full default', () => {
  expect(validateReleasePlatforms()).toEqual(['mac', 'linux', 'win'])
  expect(validateReleasePlatforms('mac,linux')).toEqual(['mac', 'linux'])
  for (const value of ['', 'mac,', 'mac,mac', 'mac,unknown', 'darwin,linux', 'mac, linux'])
    expect(() => validateReleasePlatforms(value), value).toThrow(/platform/)
})
it('requires six original Unix installer keys, both byte-verified Mac ZIPs and three feeds', () => {
  const { dir, names } = unixRelease()
  const manifest = buildManifest(unixOptions(dir))
  expect(Object.keys(manifest.downloads).sort()).toEqual([
    'linux-arm64-appimage',
    'linux-arm64-deb',
    'linux-x64-appimage',
    'linux-x64-deb',
    'mac-arm64',
    'mac-x64'
  ])
  expect(names.filter((name) => name.endsWith('.zip'))).toHaveLength(2)
  expect(manifest.downloads).not.toHaveProperty('win-x64')
  expect(
    Object.values(manifest.downloads).every((entry: { url: string }) =>
      entry.url.startsWith(assetBaseUrl + '/')
    )
  ).toBe(true)
  // An omitted scope still requires Windows; directory contents never infer a smaller release.
  expect(() => buildManifest(options(dir))).toThrow(/win-x64/)
})
it.each(Array.from({ length: 8 }, (_, index) => index))(
  'rejects a missing or tampered selected Unix installer/update ZIP at index %s',
  (index) => {
    const { dir, names, bytes } = unixRelease()
    const path = join(dir, names[index])
    rmSync(path)
    expect(() => buildManifest(unixOptions(dir))).toThrow()
    writeFileSync(path, bytes(names[index]) + 'changed bytes')
    expect(() => buildManifest(unixOptions(dir))).toThrow(/SHA256 mismatch/)
  }
)
it.each(['alpha-mac.yml', 'alpha-linux.yml', 'alpha-linux-arm64.yml'])(
  'retains version, size and real hash validation for the selected feed %s',
  (name) => {
    const { dir } = unixRelease()
    const path = join(dir, name)
    const feed = load(readFileSync(path, 'utf8')) as Feed
    rmSync(path)
    expect(() => buildManifest(unixOptions(dir))).toThrow()
    writeFileSync(path, dump({ ...feed, version: '0.1.0-alpha.2' }))
    expect(() => buildManifest(unixOptions(dir))).toThrow(/Invalid update feed/)
    const size = structuredClone(feed)
    size.files[0].size++
    writeFileSync(path, dump(size))
    expect(() => buildManifest(unixOptions(dir))).toThrow(/size mismatch/)
    const digest = structuredClone(feed)
    digest.files[0].sha512 = 'A'.repeat(86) + '=='
    writeFileSync(path, dump(digest))
    expect(() => buildManifest(unixOptions(dir))).toThrow(/SHA512 mismatch/)
  }
)
it.each(['installer', 'blockmap', 'feed', 'feed-reference', 'checksum-reference'])(
  'rejects out-of-scope Windows %s rather than dropping it from Unix output',
  (kind) => {
    const { dir } = unixRelease()
    const name = `EarthNano-${version}-win-x64-setup.exe`
    if (kind === 'installer' || kind === 'blockmap')
      writeFileSync(
        join(dir, name + (kind === 'blockmap' ? '.blockmap' : '')),
        'out-of-scope bytes'
      )
    else if (kind === 'feed') writeFileSync(join(dir, 'alpha.yml'), 'out-of-scope Windows feed')
    else if (kind === 'checksum-reference')
      writeFileSync(
        join(dir, 'SHA256SUMS.txt'),
        readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8') + `${'a'.repeat(64)}  ${name}\n`
      )
    else
      writeFileSync(
        join(dir, 'alpha-mac.yml'),
        dump({ version, files: [{ url: name, size: 1, sha512: 'A'.repeat(86) + '==' }] })
      )
    expect(() => buildManifest(unixOptions(dir))).toThrow(/outside selected platforms/)
  }
)
it('cannot narrow stable publication or bypass Alpha verification using a scope', () => {
  expect(() =>
    buildManifest({
      ...unixOptions('/unused'),
      channel: 'latest',
      version: '0.1.2',
      assetBaseUrl: undefined
    })
  ).toThrow(/Stable releases require all/)
  for (const override of [
    { requireComplete: false },
    { metadataOnly: true },
    { allowLegacyNames: true }
  ])
    expect(() => buildManifest({ ...unixOptions('/unused'), ...override })).toThrow(
      /complete, byte-verified/
    )
})

it.each(['#tail', '?tail', '%23tail', '%3Ftail'])(
  'rejects URL metadata on a scope-disguised installer with valid local bytes: %s',
  (suffix) => {
    const { dir } = unixRelease()
    expect(Object.keys(buildManifest(unixOptions(dir)).downloads)).toHaveLength(6)
    const filename = `EarthNano-${version}-win-x64-setup.exe`
    const name = filename + suffix
    const bytes = 'synthetic forbidden installer bytes'
    // Keep real bytes under a literal basename on every host. The forbidden checksum/feed name
    // must fail before artifact lookup; Windows cannot create a physical basename containing '?'.
    writeFileSync(join(dir, filename), bytes)
    writeFileSync(
      join(dir, 'SHA256SUMS.txt'),
      readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8') + `${hash(bytes)}  ${name}\n`
    )
    const path = join(dir, 'alpha-mac.yml')
    const feed = load(readFileSync(path, 'utf8')) as Feed
    feed.files.push({
      url: name,
      size: Buffer.byteLength(bytes),
      sha512: hash(bytes, 'sha512', 'base64')
    })
    writeFileSync(path, dump(feed))
    expect(() => buildManifest(unixOptions(dir))).toThrow(/URL metadata/)
  }
)
it('passes the explicit Unix scope through the original generator CLI without a Windows feed', () => {
  const { dir } = unixRelease()
  const output = join(dir, 'version.json')
  const invoke = (flags: string[]): SpawnSyncReturns<string> =>
    spawnSync(
      process.execPath,
      [
        join(repo, 'scripts/generate-version-manifest.mjs'),
        dir,
        output,
        '--require-complete',
        ...flags
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          VERSION: version,
          UPDATE_CHANNEL: 'alpha',
          ASSET_BASE_URL: assetBaseUrl
        }
      }
    )
  const result = invoke(['--platforms', 'mac,linux'])
  expect(result.status, result.stderr).toBe(0)
  expect(Object.keys(JSON.parse(readFileSync(output, 'utf8')).downloads)).toHaveLength(6)
  expect(invoke([]).status).not.toBe(0)
  for (const flags of [
    ['--platforms'],
    ['--platforms', ''],
    ['--platforms', 'mac,mac'],
    ['--platforms', 'mac,linux', '--platforms', 'win']
  ])
    expect(invoke(flags).status).not.toBe(0)
})

it('builds the complete Alpha manifest from actual bytes and the explicit immutable GitHub asset base', () => {
  const { dir, names } = release()
  const manifest = buildManifest(options(dir))
  expect(buildManifest({ ...options(dir), platforms: 'mac,linux,win' })).toEqual(manifest)
  expect(Object.keys(manifest.downloads)).toHaveLength(7)
  expect(manifest.downloads['linux-arm64-deb'].url).toBe(`${assetBaseUrl}/${names[6]}`)
  expect(manifest.downloads['mac-arm64'].url).toBe(`${assetBaseUrl}/${names[0]}`)
  expect(
    Object.values(manifest.downloads).some((entry: { url: string }) => entry.url.endsWith('.zip'))
  ).toBe(false)
})

it('keeps the default stable S3 layout and all seven platform keys', () => {
  const { dir, names } = release('0.1.2', 'latest')
  const manifest = buildManifest({
    dir,
    version: '0.1.2',
    cdnBase: 'https://cdn.example',
    prefix: 'open-science',
    requireComplete: true
  })
  expect(Object.keys(manifest.downloads)).toHaveLength(7)
  expect(manifest.downloads['win-x64'].url).toBe(
    `https://cdn.example/open-science/releases/0.1.2/${names[2]}`
  )
})

it.each([
  '0.1.0',
  '0.1.0-alpha',
  '0.1.0-alpha.01',
  '01.1.0-alpha.1',
  '0.1.0-beta.1',
  '0.1.0-nightly.g123',
  '0.1.0-alpha.1+build',
  '0.1.0-alpha.9007199254740992'
])('rejects a version outside the canonical Alpha channel: %s', (invalid) => {
  expect(() => buildManifest({ ...options('/unused'), version: invalid })).toThrow(
    /Invalid alpha release version/
  )
})
it.each(['../alpha', 'beta', '', undefined])(
  'requires an explicit supported channel for previews: %s',
  (channel) => {
    expect(() => buildManifest({ ...options('/unused'), channel })).toThrow(
      /release (channel|version)/
    )
  }
)
it.each([
  undefined,
  'http://github.com/lust0yixiong/EarthNano/releases/download/v0.1.0-alpha.1',
  'https://github.com/lust0yixiong/EarthNano/releases/download/alpha',
  'https://github.com/lust0yixiong/EarthNano/releases/download/v0.1.0-alpha.2',
  'https://github.com/AIPOCH/OpenScience/releases/download/v0.1.0-alpha.1',
  `${assetBaseUrl}?token=example`,
  `${assetBaseUrl}/../v0.1.0-alpha.1`,
  `${assetBaseUrl}#fragment`
])('rejects an absent or unrelated Alpha asset base: %s', (base) => {
  expect(() => buildManifest({ ...options('/unused'), assetBaseUrl: base })).toThrow(
    /exact EarthNano versioned release URL/
  )
})
it.each([{ requireComplete: false }, { metadataOnly: true }, { allowLegacyNames: true }])(
  'does not turn a partial or metadata-only Alpha into a publishable manifest: %j',
  (override) => {
    expect(() => buildManifest({ ...options('/unused'), ...override })).toThrow(
      /complete, byte-verified/
    )
  }
)
it('keeps the missing Linux arm64 CI target visible as an incomplete Alpha release', () => {
  const { dir, names } = release()
  rmSync(join(dir, names[5]))
  rmSync(join(dir, names[6]))
  rmSync(join(dir, 'alpha-linux-arm64.yml'))
  expect(() => buildManifest(options(dir))).toThrow(
    /Missing alpha release installer: linux-arm64-appimage/
  )
})
it.each(['alpha.yml', 'alpha-linux.yml', 'alpha-linux-arm64.yml', 'alpha-mac.yml'])(
  'requires the real channel feed %s',
  (name) => {
    const { dir } = release()
    rmSync(join(dir, name))
    expect(() => buildManifest(options(dir))).toThrow()
  }
)
it('retains ZIP byte and feed size/hash/architecture verification for Alpha', () => {
  const { dir, names, feed, bytes } = release()
  writeFileSync(join(dir, names[8]), 'tampered final ZIP')
  expect(() => buildManifest(options(dir))).toThrow(/SHA256 mismatch/)
  writeFileSync(join(dir, names[8]), bytes(names[8]))
  const path = join(dir, 'alpha-linux.yml')
  writeFileSync(path, dump(feed(names.slice(5, 7))))
  expect(() => buildManifest(options(dir))).toThrow(/Wrong architecture/)
  const corrupt = feed(names.slice(3, 5))
  corrupt.files[0].size++
  writeFileSync(path, dump(corrupt))
  expect(() => buildManifest(options(dir))).toThrow(/size mismatch/)
  corrupt.files[0].size--
  corrupt.files[0].sha512 = 'A'.repeat(86) + '=='
  writeFileSync(path, dump(corrupt))
  expect(() => buildManifest(options(dir))).toThrow(/SHA512 mismatch/)
})
it('passes the explicit Alpha destination through the original generator CLI', () => {
  const { dir } = release()
  const output = join(dir, 'version.json')
  const result = spawnSync(
    process.execPath,
    [join(repo, 'scripts/generate-version-manifest.mjs'), dir, output, '--require-complete'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        VERSION: version,
        UPDATE_CHANNEL: 'alpha',
        ASSET_BASE_URL: assetBaseUrl
      }
    }
  )
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(readFileSync(output, 'utf8')).downloads['win-x64'].url).toContain(
    `${assetBaseUrl}/EarthNano-`
  )
})
it('merges both Alpha architectures without creating a latest feed, and rejects stale ZIPs or channels', () => {
  const { dir, names, feed } = release()
  rmSync(join(dir, 'alpha-mac.yml'))
  for (const [index, arch] of ['arm64', 'x64'].entries())
    writeFileSync(join(dir, `${arch}-mac.yml`), dump(feed([names[7 + index]])))
  const merge = (channel = 'alpha'): SpawnSyncReturns<string> =>
    spawnSync(
      process.execPath,
      [join(repo, 'scripts/merge-mac-feed.mjs'), dir, '--channel', channel],
      { encoding: 'utf8' }
    )
  expect(merge().status).toBe(0)
  expect(
    (load(readFileSync(join(dir, 'alpha-mac.yml'), 'utf8')) as { files: unknown[] }).files
  ).toHaveLength(2)
  expect(existsSync(join(dir, 'latest-mac.yml'))).toBe(false)
  writeFileSync(join(dir, names[8]), 'stale zip')
  expect(merge().status).not.toBe(0)
  expect(merge('../other').status).not.toBe(0)
})

type WorkflowStep = { name?: string; run?: string; with?: { path?: string } }
const step = (workflow: string, job: string, name: string): WorkflowStep => {
  const doc = load(readFileSync(join(repo, '.github/workflows', workflow), 'utf8')) as {
    jobs: Record<string, { steps: WorkflowStep[] }>
  }
  const found = doc.jobs[job].steps.find((candidate) => candidate.name === name)
  if (!found?.run && !found?.with) throw new Error(`Missing workflow step ${name}`)
  return found
}
const run = (
  script: string,
  cwd: string,
  env: Record<string, string> = {}
): SpawnSyncReturns<string> =>
  spawnSync('bash', ['-eu', '-c', script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  })

it.each(['alpha', 'latest', undefined])(
  'collects the feed actually embedded by the builder (%s)',
  (channel) => {
    const dir = fixture(),
      output = join(dir, 'outputs')
    mkdirSync(join(dir, 'dist'))
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir')
    writeFileSync(
      join(dir, 'electron-builder.yml'),
      dump({ publish: { provider: 'generic', ...(channel ? { channel } : {}) } })
    )
    const selected = channel ?? 'latest'
    writeFileSync(join(dir, 'dist', `${selected}-mac.yml`), 'actual native feed')
    const resolved = run(step('build.yml', 'build', 'Resolve update feed channel').run!, dir, {
      GITHUB_OUTPUT: output,
      FEED_PLATFORM: 'mac',
      FEED_ARCH: 'arm64',
      FEED_NIGHTLY: 'false'
    })
    expect(resolved.status, resolved.stderr).toBe(0)
    expect(readFileSync(output, 'utf8')).toBe(`channel=${selected}\n`)
    const preserved = run(
      step('build.yml', 'build', 'Preserve architecture-specific mac update feed').run!.replaceAll(
        '${{ inputs.nightly }}',
        'false'
      ),
      dir,
      { ARCH: 'arm64', UPDATE_CHANNEL: selected }
    )
    expect(preserved.status, preserved.stderr).toBe(0)
    expect(readFileSync(join(dir, 'dist/arm64-mac.yml'), 'utf8')).toBe('actual native feed')
    expect(existsSync(join(dir, 'dist', `${selected}-mac.yml`))).toBe(false)
    expect(step('build.yml', 'build', 'Upload build artifacts').with?.path).toContain(
      'dist/${{ steps.update_feed.outputs.channel }}*.yml'
    )
  }
)
it.each(['alpha', 'latest'])(
  'regenerates %s mac feed from final stapled ZIP bytes and drops stale channel metadata',
  (channel) => {
    const dir = fixture(),
      v = channel === 'alpha' ? version : '0.1.2'
    mkdirSync(join(dir, 'mac'))
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir')
    writeFileSync(join(dir, 'electron-builder.yml'), dump({ publish: { channel } }))
    const zip = `EarthNano-${v}-mac-arm64.zip`,
      bytes = 'synthetic final stapled ZIP bytes'
    writeFileSync(join(dir, 'mac', zip), bytes)
    writeFileSync(join(dir, 'mac', `${channel}-mac.yml`), 'stale pre-staple metadata')
    const result = run(
      step('notarize-mac.yml', 'notarize', 'Regenerate mac update feed').run!,
      dir,
      { ARCH: 'arm64' }
    )
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(dir, 'mac', `${channel}-mac.yml`))).toBe(false)
    const regenerated = load(readFileSync(join(dir, 'mac/arm64-mac.yml'), 'utf8')) as {
      version: string
      files: unknown[]
    }
    expect(regenerated.version).toBe(v)
    expect(regenerated.files).toEqual([
      { url: zip, size: Buffer.byteLength(bytes), sha512: hash(bytes, 'sha512', 'base64') }
    ])
  }
)

it.each([
  ['win', 'x64', 'alpha.yml'],
  ['linux', 'x64', 'alpha-linux.yml'],
  ['linux', 'arm64', 'alpha-linux-arm64.yml']
])('fails collection when the actual %s %s Alpha feed is missing', (platform, arch, name) => {
  const dir = fixture(),
    output = join(dir, 'outputs')
  mkdirSync(join(dir, 'dist'))
  symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir')
  writeFileSync(join(dir, 'electron-builder.yml'), dump({ publish: { channel: 'alpha' } }))
  const env = {
    GITHUB_OUTPUT: output,
    FEED_PLATFORM: platform,
    FEED_ARCH: arch,
    FEED_NIGHTLY: 'false'
  }
  const script = step('build.yml', 'build', 'Resolve update feed channel').run!
  const missing = run(script, dir, env)
  expect(missing.status).not.toBe(0)
  expect(missing.stderr).toContain(`Missing native update feed: ${name}`)
  writeFileSync(join(dir, 'dist', name), 'actual native feed')
  const present = run(script, dir, env)
  expect(present.status, present.stderr).toBe(0)
})
