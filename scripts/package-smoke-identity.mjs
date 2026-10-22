/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import plist from 'plist'
export const ORIGINAL_SMOKE_IDENTITY = Object.freeze({
  name: 'open-science',
  productName: 'Open-Science',
  appId: 'com.aipoch.open-science',
  windowsExecutable: 'open-science.exe',
  linuxExecutable: 'open-science',
  macExecutable: 'Open-Science',
  artifacts: {
    mac: 'aipoch-${name}-${version}-mac-${arch}.${ext}',
    linux: 'aipoch-${name}-${version}-linux-${arch}.${ext}',
    win: 'aipoch-${name}-${version}-win-${arch}-setup.${ext}'
  }
})
let current = ORIGINAL_SMOKE_IDENTITY
/** A finite smoke command initializes its expected identity from trusted source metadata once.
 * The original identity remains the default for upstream-compatible reusable helper consumers. */
export const configurePackageSmokeIdentity = (identity = ORIGINAL_SMOKE_IDENTITY) => {
  current = Object.freeze({ ...identity })
}
export const packageSmokeIdentity = () => current
export async function loadPackageSmokeIdentity(
  root = resolve(fileURLToPath(new URL('..', import.meta.url)))
) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const builder = load(await readFile(join(root, 'electron-builder.yml'), 'utf8'))
  if (
    !pkg.name ||
    !pkg.productName ||
    pkg.productName !== builder.productName ||
    !pkg.version ||
    !builder.appId
  )
    throw new Error('Package and builder identity disagree')
  const harness = builder.extraResources?.find((entry) => entry.from === 'vendor/harness2')
  const licenses = (builder.extraResources ?? [])
    .filter(
      (entry) =>
        typeof entry.from === 'string' && /(?:^|[-/])LICENSE(?:\.[^/]+)?$/iu.test(entry.from)
    )
    .map((entry) => ({ source: join(root, entry.from), target: entry.to }))
  if (harness)
    licenses.push({
      source: join(root, 'vendor/harness2/LICENSE'),
      target: harness.to + '/LICENSE'
    })
  const identity = {
    licenses,
    name: pkg.name,
    productName: builder.productName,
    version: pkg.version,
    appId: builder.appId,
    macExecutable: builder.mac?.executableName ?? builder.productName,
    windowsExecutable: (builder.win?.executableName ?? pkg.name) + '.exe',
    linuxExecutable: builder.linux?.executableName ?? pkg.name,
    artifacts: {
      mac: builder.mac?.artifactName,
      win: builder.nsis?.artifactName ?? builder.win?.artifactName,
      linux: builder.appImage?.artifactName ?? builder.linux?.artifactName
    }
  }
  if (Object.values(identity.artifacts).some((value) => typeof value !== 'string'))
    throw new Error('Exact builder artifact templates unavailable')
  return identity
}
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function packageArtifactPattern(platform, extension, identity = current) {
  const template = identity.artifacts[platform]
  if (!template) throw new Error('Unsupported artifact platform')
  const variables = {
    name: escape(identity.name),
    productName: escape(identity.productName),
    version: '(?<version>[^/\\\\]+)',
    arch: platform === 'linux' ? '(?:x64|x86_64|arm64)' : '(?:x64|arm64)',
    ext: escape(extension)
  }
  let pattern = '',
    offset = 0
  for (const match of template.matchAll(/\$\{([^}]+)\}/g)) {
    pattern += escape(template.slice(offset, match.index))
    if (!variables[match[1]]) throw new Error(`Unsupported artifact macro: ${match[1]}`)
    pattern += variables[match[1]]
    offset = match.index + match[0].length
  }
  return new RegExp('^' + pattern + escape(template.slice(offset)) + '$', 'u')
}
export function packageArtifactVersion(path, platform, extension, identity = current) {
  const match = basename(path).match(packageArtifactPattern(platform, extension, identity))
  if (!match?.groups?.version)
    throw new Error(`Artifact does not match expected builder template: ${path}`)
  return match.groups.version
}
export function validateMacBundleInfo(info, identity = current) {
  if (
    info.CFBundleIdentifier !== identity.appId ||
    info.CFBundleName !== identity.productName ||
    info.CFBundleDisplayName !== identity.productName ||
    info.CFBundleExecutable !== identity.macExecutable ||
    (identity.version && info.CFBundleShortVersionString !== identity.version)
  )
    throw new Error('Packaged Info.plist differs from expected builder identity')
  if (basename(info.CFBundleExecutable) !== info.CFBundleExecutable)
    throw new Error('Unsafe CFBundleExecutable')
  return info.CFBundleExecutable
}
export const readMacBundleExecutable = async (appBundle, identity = current) =>
  validateMacBundleInfo(
    plist.parse(await readFile(join(appBundle, 'Contents', 'Info.plist'), 'utf8')),
    identity
  )
export function validateWindowsVersionInfo(info, identity = current) {
  // The locked builder preserves full SemVer in FileVersion; ProductVersion is numeric.
  if (
    info.FileDescription !== identity.productName ||
    info.ProductName !== identity.productName ||
    (identity.version && info.FileVersion !== identity.version)
  )
    throw new Error('Windows executable version metadata differs from expected builder identity')
}

export async function assertPackagedLicenses(resources, identity = current) {
  for (const license of identity.licenses ?? []) {
    if (
      typeof license.target !== 'string' ||
      license.target.startsWith('/') ||
      license.target.split(/[\\/]/).includes('..')
    )
      throw new Error('Unsafe packaged license target')
    const source = await readFile(license.source),
      packaged = await readFile(join(resources, license.target))
    if (!source.equals(packaged))
      throw new Error(`Packaged license differs from original source: ${license.target}`)
  }
}
