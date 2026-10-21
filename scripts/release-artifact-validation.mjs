/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

// A caller must select its release scope; never infer it from whichever files arrived.
export function validateReleasePlatforms(value = 'mac,linux,win') {
  if (typeof value !== 'string') throw new Error('Invalid release platforms')
  const platforms = value.split(',')
  if (
    platforms.some((platform) => !['mac', 'linux', 'win'].includes(platform)) ||
    new Set(platforms).size !== platforms.length
  )
    throw new Error('Unknown, empty or duplicate release platform')
  return platforms
}

// Classify only existing native artifact/feed families, including sidecars and legacy names.
// Artifact names, versions, bytes and feed metadata still pass their original strict validators.
export function assertReleaseArtifactScope(name, platforms) {
  if (typeof name !== 'string') return
  const platform =
    /\.exe(?:\.blockmap)?$/i.test(name) ||
    /(?:win|windows)-(?:x64|arm64)(?:-setup)?\.zip$/i.test(name) ||
    /^(?:alpha|latest)\.ya?ml$/.test(name)
      ? 'win'
      : /\.dmg(?:\.blockmap)?$/i.test(name) ||
          /(?:mac|macos)-(?:x64|arm64)\.zip$/i.test(name) ||
          /-mac\.ya?ml$/.test(name)
        ? 'mac'
        : /\.(?:AppImage|deb)(?:\.blockmap)?$/i.test(name) ||
            /linux-(?:x64|arm64)\.zip$/i.test(name) ||
            /-linux(?:-arm64)?\.ya?ml$/.test(name)
          ? 'linux'
          : undefined
  if (platform && !platforms.includes(platform))
    throw new Error(`Release artifact outside selected platforms: ${name}`)
}

// Release installers can exceed a gigabyte. Keep hashing bounded without changing the synchronous
// manifest API used by the CLI and its consumers.
export function artifactHash(file, algorithm, encoding = 'hex') {
  const fd = openSync(file, 'r')
  try {
    const hash = createHash(algorithm)
    const buffer = Buffer.alloc(1024 * 1024)
    let length
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, length))
    }
    return hash.digest(encoding)
  } finally {
    closeSync(fd)
  }
}

// Stable tooling keeps its original default. Alpha publication requires an explicitly numbered
// release matching the selected channel; unordered Nightlies are not published Alpha versions.
export function validateReleaseVersion(version, channel = 'latest') {
  if (!['latest', 'alpha'].includes(channel))
    throw new Error(`Unsupported release channel: ${channel}`)
  const pattern =
    channel === 'alpha'
      ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.(0|[1-9]\d*)$/
      : /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
  const match = typeof version === 'string' ? pattern.exec(version) : null
  if (
    !match ||
    (channel === 'alpha' && !match.slice(1).every((part) => Number.isSafeInteger(Number(part))))
  ) {
    throw new Error(
      `Invalid ${channel === 'latest' ? 'stable' : channel} release version: ${version}`
    )
  }
}

export function validateArtifactName(name, version, allowLegacyNames = false) {
  // EarthNano changes the published product filename. Retain the original release family for
  // historical manifests and upstream tooling; both families use the same version/path checks.
  const productPrefixes = ['aipoch-open-science', 'EarthNano']
  if (
    typeof name !== 'string' ||
    /[/\\\r\n]/.test(name) ||
    !(
      productPrefixes.some(
        (prefix) =>
          name.startsWith(`${prefix}-${version}-`) || name.startsWith(`${prefix}_${version}_`)
      ) ||
      (allowLegacyNames &&
        (name.startsWith(`open-science-${version}-`) ||
          name.startsWith(`open-science_${version}_`)))
    )
  ) {
    throw new Error(`Artifact name does not match release ${version}: ${name}`)
  }
}

export function validateUpdateFeed(
  feed,
  dir,
  version,
  metadataOnly = false,
  allowLegacyNames = false
) {
  if (feed?.version !== version || !Array.isArray(feed.files) || feed.files.length === 0) {
    throw new Error(`Invalid update feed for release ${version}`)
  }
  const seen = new Set()
  for (const file of feed.files) {
    validateArtifactName(file.url, version, allowLegacyNames)
    if (seen.has(file.url)) throw new Error(`Duplicate feed artifact: ${file.url}`)
    seen.add(file.url)
    const stat = statSync(join(dir, file.url))
    if (
      !stat.isFile() ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.size !== stat.size
    ) {
      throw new Error(`Feed artifact size mismatch: ${file.url}`)
    }
    if (typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) {
      throw new Error(`Invalid feed SHA512: ${file.url}`)
    }
    if (!metadataOnly && artifactHash(join(dir, file.url), 'sha512', 'base64') !== file.sha512) {
      throw new Error(`Feed artifact SHA512 mismatch: ${file.url}`)
    }
  }
  if (feed.path !== undefined || feed.sha512 !== undefined) {
    const legacy = feed.files.find((file) => file.url === feed.path)
    if (!legacy || legacy.sha512 !== feed.sha512)
      throw new Error('Legacy feed fields disagree with files')
  }
  return feed
}
