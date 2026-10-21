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

it('builds the complete Alpha manifest from actual bytes and the explicit immutable GitHub asset base', () => {
  const { dir, names } = release()
  const manifest = buildManifest(options(dir))
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
