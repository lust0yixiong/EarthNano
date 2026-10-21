/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Generate version.json: the single manifest that powers the website's download page and the
// in-app update prompt (sub-project 2). Pure Node ESM, zero network — input is a local directory of
// release installers plus SHA256SUMS.txt, output is the manifest object / a version.json file.
//
// CLI (executed directly), inputs from argv + env:
//   node scripts/generate-version-manifest.mjs [dir] [outputPath]
//     dir         positional or env DIST_DIR   directory holding installers + SHA256SUMS.txt
//                 (default: dist-assets)
//     outputPath  positional or env OUTPUT      where to write version.json (default: <dir>/version.json)
//     VERSION       required  release version without a leading 'v' (e.g. 0.1.2)
//     UPDATE_CHANNEL optional latest (default) or alpha; alpha requires matching alpha.N version
//     --platforms mac,linux  explicit Alpha native scope (default mac,linux,win)
//     ASSET_BASE_URL required for alpha: exact EarthNano /releases/download/v<VERSION> URL
//     CDN_BASE_URL  stable only required  public base URL used to build each download url
//     S3_PREFIX     stable only required  path prefix inside the bucket (e.g. open-science)
//     NOTES         optional  legacy release notes input (GitHub Release body)
//     NOTES_DIR     optional  directory of already-condensed <locale>.md release notes; en.md required
//     RELEASE_DATE  optional  ISO timestamp (GitHub Release published_at)

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import {
  artifactHash,
  assertReleaseArtifactScope,
  validateReleasePlatforms,
  validateArtifactName,
  validateReleaseVersion,
  validateUpdateFeed
} from './release-artifact-validation.mjs'

// Filename -> downloads key. Explicit regex table so an unexpected artifact name fails loudly (as a
// warning) rather than being silently misfiled. deb uses the dpkg convention (underscores + amd64).
const KEY_RULES = [
  { platform: 'mac', key: 'mac-arm64', pattern: /-mac-arm64\.dmg$/ },
  { platform: 'mac', key: 'mac-x64', pattern: /-mac-x64\.dmg$/ },
  { platform: 'win', key: 'win-x64', pattern: /-win-x64-setup\.exe$/ },
  { platform: 'linux', key: 'linux-x64-appimage', pattern: /-linux-(?:x64|x86_64)\.AppImage$/ },
  { platform: 'linux', key: 'linux-x64-deb', pattern: /_amd64\.deb$/ },
  { platform: 'linux', key: 'linux-arm64-appimage', pattern: /-linux-arm64\.AppImage$/ },
  { platform: 'linux', key: 'linux-arm64-deb', pattern: /_arm64\.deb$/ }
]

// Non-installer files that legitimately live in the release dir; skipped without a warning.
const IGNORED = [/\.zip$/, /^SHA256SUMS\.txt$/, /^version\.json$/, /\.ya?ml$/, /\.blockmap$/]

const LOCALIZED_NOTE_LOCALES = ['zh-Hans', 'zh-Hant', 'ja', 'ko', 'fr', 'ru', 'de', 'es']
const NOTE_LOCALES = new Set(['en', ...LOCALIZED_NOTE_LOCALES])

// Read the repository-owned, already-condensed notes for one release. English is the stable fallback
// consumed by old clients and updater feeds, so it is required; translated files are optional.
export function readReleaseNotes(notesDir) {
  const files = readdirSync(notesDir)
  const notesByLocale = {}

  for (const filename of files) {
    const match = /^(.+)\.md$/.exec(filename)
    if (!match || !NOTE_LOCALES.has(match[1])) {
      throw new Error(`[version-manifest] unsupported release-note file: ${filename}`)
    }
    const content = readFileSync(join(notesDir, filename), 'utf8').trim()
    if (!content) throw new Error(`[version-manifest] empty release-note file: ${filename}`)
    notesByLocale[match[1]] = content
  }

  if (!notesByLocale.en) throw new Error('[version-manifest] release notes require en.md')
  const localizedNotes = Object.fromEntries(
    LOCALIZED_NOTE_LOCALES.flatMap((locale) =>
      notesByLocale[locale] ? [[locale, notesByLocale[locale]]] : []
    )
  )
  return { notes: notesByLocale.en, localizedNotes }
}

// Parse a `<hex>  <filename>` per-line SHA256SUMS.txt into { filename: hex }. Tolerates 1+ spaces
// and an optional leading '*' binary marker that some sha256sum variants emit.
export function parseSha256Sums(content) {
  const map = {}
  for (const line of content.split('\n')) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (match) {
      if (Object.hasOwn(map, match[2])) throw new Error(`Duplicate SHA256 entry: ${match[2]}`)
      map[match[2]] = match[1].toLowerCase()
    }
  }
  return map
}

// Match a filename to its downloads key, or null when no rule applies.
function keyForFile(filename) {
  return KEY_RULES.find((rule) => rule.pattern.test(filename))?.key ?? null
}

// Build the version.json manifest object from a directory of installers + SHA256SUMS.txt.
// Pure: reads the filesystem but performs no network I/O. Only keys whose installer actually exists
// are emitted; each present installer must have a matching version, size and real checksum.
export function buildManifest({
  dir,
  version,
  notes,
  localizedNotes,
  releaseDate,
  cdnBase,
  prefix,
  channel = 'latest',
  assetBaseUrl,
  platforms,
  metadataOnly = false,
  requireComplete = false,
  allowLegacyNames = false
}) {
  validateReleaseVersion(version, channel)
  const selectedPlatforms = validateReleasePlatforms(platforms)
  if (channel !== 'alpha' && selectedPlatforms.length !== 3)
    throw new Error('Stable releases require all mac,linux,win platforms')
  // Alpha assets belong to this repository's immutable version tag, never the rolling channel or
  // upstream stable CDN. Require the caller to name that destination; do not guess a URL.
  if (channel === 'alpha') {
    if (!requireComplete || metadataOnly || allowLegacyNames) {
      throw new Error(
        'Alpha manifests require complete, byte-verified artifacts without legacy backfill'
      )
    }
    if (
      assetBaseUrl !== `https://github.com/lust0yixiong/EarthNano/releases/download/v${version}`
    ) {
      throw new Error('Alpha assets require the exact EarthNano versioned release URL')
    }
  } else if (assetBaseUrl !== undefined) {
    throw new Error('Explicit asset base URLs are only supported for the Alpha channel')
  }
  const sums = parseSha256Sums(readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8'))
  for (const name of Object.keys(sums)) assertReleaseArtifactScope(name, selectedPlatforms)
  const base = assetBaseUrl ?? `${cdnBase}/${prefix}/releases/${version}`
  const feedNames = [
    ...(selectedPlatforms.includes('win') ? [`${channel}.yml`] : []),
    ...(selectedPlatforms.includes('linux')
      ? [`${channel}-linux.yml`, `${channel}-linux-arm64.yml`]
      : []),
    ...(selectedPlatforms.includes('mac') ? [`${channel}-mac.yml`] : [])
  ]
  const readFeed = (filename) => {
    const feed = load(readFileSync(join(dir, filename), 'utf8'))
    if (Array.isArray(feed?.files))
      for (const file of feed.files) assertReleaseArtifactScope(file?.url, selectedPlatforms)
    return feed
  }

  const downloads = {}
  for (const filename of readdirSync(dir)) {
    assertReleaseArtifactScope(filename, selectedPlatforms)
    const key = keyForFile(filename)
    if (!key && !filename.endsWith('.zip')) {
      // Warn only for genuinely unexpected files, not known non-manifest artifacts (zips, sums, ...).
      if (!IGNORED.some((pattern) => pattern.test(filename))) {
        console.warn(`[version-manifest] unrecognized file, ignoring: ${filename}`)
      }
      continue
    }
    validateArtifactName(filename, version, allowLegacyNames)
    const sha256 = sums[filename]
    if (!sha256) throw new Error(`[version-manifest] no sha256 in SHA256SUMS.txt: ${filename}`)
    const stat = statSync(join(dir, filename))
    if (!stat.isFile() || stat.size <= 0) throw new Error(`Empty or invalid installer: ${filename}`)
    if (!metadataOnly && artifactHash(join(dir, filename), 'sha256') !== sha256) {
      throw new Error(`Installer SHA256 mismatch: ${filename}`)
    }
    if (!key) continue // mac ZIPs are update artifacts, not website download keys.
    if (downloads[key]) throw new Error(`Duplicate installer for ${key}`)
    downloads[key] = { url: `${base}/${filename}`, size: stat.size, sha256 }
  }
  for (const filename of readdirSync(dir).filter(
    (name) => feedNames.includes(name) || /-mac\.yml$/.test(name)
  )) {
    const feed = validateUpdateFeed(
      readFeed(filename),
      dir,
      version,
      metadataOnly,
      allowLegacyNames
    )
    if (filename === `${channel}-linux.yml` || filename === `${channel}-linux-arm64.yml`) {
      const arch = filename === `${channel}-linux-arm64.yml` ? 'arm64' : 'x64'
      if (feed.files.some((file) => !keyForFile(file.url)?.startsWith(`linux-${arch}-`))) {
        throw new Error(`Wrong architecture in ${filename}`)
      }
    }
  }
  if (requireComplete) {
    for (const { key, platform } of KEY_RULES) {
      if (!selectedPlatforms.includes(platform)) continue
      if (!downloads[key])
        throw new Error(
          `Missing ${channel === 'latest' ? 'stable' : channel} release installer: ${key}`
        )
    }
    for (const name of feedNames) {
      const feed = validateUpdateFeed(readFeed(name), dir, version, metadataOnly)
      const required =
        name === `${channel}-mac.yml`
          ? ['-mac-arm64.zip', '-mac-x64.zip']
          : name === `${channel}.yml`
            ? ['-win-x64-setup.exe']
            : name === `${channel}-linux-arm64.yml`
              ? ['-linux-arm64.AppImage', '_arm64.deb']
              : ['.AppImage', '_amd64.deb']
      for (const suffix of required) {
        if (!feed.files.some((file) => file.url.endsWith(suffix)))
          throw new Error(`Missing ${suffix} in ${name}`)
      }
    }
  }

  return {
    version,
    releaseDate,
    notes,
    ...(localizedNotes && Object.keys(localizedNotes).length > 0 ? { localizedNotes } : {}),
    downloads
  }
}

// --- Release-notes condensation -----------------------------------------------------------------

// H2 sections kept in the in-app "what's new" notes, matched case-insensitively by heading text with
// emoji/punctuation stripped. Everything else in a release body (install steps, maturity notes,
// acknowledgements, the auto-generated "What's Changed"/contributors) is dropped.
const NOTE_SECTIONS = new Set(['highlights', 'new features', 'improvements', 'bug fixes'])

// Normalize a `## …` heading to its comparable label: drop the leading #'s and any emoji/punctuation,
// collapse whitespace, lowercase. `## 🐛 Bug Fixes` -> `bug fixes`.
function headingLabel(line) {
  return line
    .replace(/^#+\s*/, '')
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// Condense a full GitHub release body into concise "what's new" notes: keep only the allowlisted H2
// sections, in document order. Falls back to the preamble (text before the first H2, minus the H1
// title) when no allowlisted section is present, and to '' for an empty body.
export function extractHighlights(body) {
  if (!body || !body.trim()) return ''

  const sections = []
  let current = { label: null, lines: [] } // label null = preamble before the first H2
  for (const line of body.split('\n')) {
    if (/^##\s+/.test(line)) {
      sections.push(current)
      current = { label: headingLabel(line), lines: [line] }
    } else {
      current.lines.push(line)
    }
  }
  sections.push(current)

  const kept = sections
    .filter((section) => section.label && NOTE_SECTIONS.has(section.label))
    .map((section) => section.lines.join('\n').trim())
    .filter(Boolean)
  if (kept.length > 0) return kept.join('\n\n')

  // Fallback: the preamble before the first H2, without the H1 title line.
  return (sections[0]?.lines ?? [])
    .filter((line) => !/^#\s+/.test(line))
    .join('\n')
    .trim()
}

// CLI entry: only runs when the file is executed directly, not when imported by the test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] || process.env.DIST_DIR || 'dist-assets'
  const outputPath = process.argv[3] || process.env.OUTPUT || join(dir, 'version.json')

  const version = process.env.VERSION
  const cdnBase = process.env.CDN_BASE_URL
  const prefix = process.env.S3_PREFIX
  const channel = process.env.UPDATE_CHANNEL ?? 'latest'
  const assetBaseUrl = process.env.ASSET_BASE_URL
  const platformIndex = process.argv.indexOf('--platforms')
  if (
    process.argv.filter((value) => value === '--platforms').length > 1 ||
    (platformIndex !== -1 && !process.argv[platformIndex + 1])
  )
    throw new Error('Expected one explicit --platforms value')
  const platforms = platformIndex === -1 ? undefined : process.argv[platformIndex + 1]
  if (!version || (channel === 'latest' && (!cdnBase || !prefix))) {
    console.error(
      '[version-manifest] VERSION is required; latest also requires CDN_BASE_URL and S3_PREFIX'
    )
    process.exit(1)
  }

  const releaseNotes = process.env.NOTES_DIR
    ? readReleaseNotes(process.env.NOTES_DIR)
    : { notes: extractHighlights(process.env.NOTES ?? ''), localizedNotes: undefined }

  const manifest = buildManifest({
    dir,
    version,
    ...releaseNotes,
    releaseDate: process.env.RELEASE_DATE ?? '',
    cdnBase,
    prefix,
    channel,
    assetBaseUrl,
    platforms,
    metadataOnly: process.argv.includes('--metadata-only'),
    requireComplete: process.argv.includes('--require-complete'),
    allowLegacyNames: process.argv.includes('--backfill')
  })

  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(outputPath)
}
