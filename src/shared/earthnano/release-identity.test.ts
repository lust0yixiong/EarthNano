import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'
import { APP } from '../app-config'
import { isPublishedReleaseVersion } from '../update'

it('keeps EarthNano preview discovery and packaged updater on one independent channel', () => {
  const builder = load(readFileSync('electron-builder.yml', 'utf8')) as {
    appId: string
    productName: string
    publish: { provider: string; url: string; channel: string }
    [key: string]: unknown
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  expect(pkg.productName).toBe(APP.name)
  expect(builder.productName).toBe(APP.name)
  expect(pkg.version).toBe('0.2.0-alpha.1')
  expect(isPublishedReleaseVersion(pkg.version)).toBe(true)
  expect(lock.version).toBe(pkg.version)
  expect(lock.packages[''].version).toBe(pkg.version)
  expect(builder.publish).toEqual({
    provider: 'generic',
    url: `${APP.links.githubRepo}/releases/download/alpha`,
    channel: 'alpha'
  })
  expect(APP.update.manifestUrl).toBe(`${builder.publish.url}/version.json`)
  expect(APP.update.downloadPage).toBe(APP.links.githubReleases)
  // Display/installer branding never silently migrates stored paths or protocol/CLI identities.
  expect(builder.appId).toBe('com.aipoch.open-science')
  expect(pkg.name).toBe('open-science')
  expect(pkg.bin['open-science']).toBe('cli/index.mjs')
  for (const target of ['win', 'nsis', 'mac', 'dmg', 'appImage', 'deb']) {
    const config = builder[target] as { artifactName: string }
    expect(config.artifactName).toContain('${productName}')
    expect(config.artifactName).toContain('${version}')
  }
})
