import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertPackagedLicenses,
  configurePackageSmokeIdentity,
  ORIGINAL_SMOKE_IDENTITY,
  packageArtifactPattern,
  packageArtifactVersion,
  loadPackageSmokeIdentity,
  readMacBundleExecutable,
  validateMacBundleInfo,
  validateWindowsVersionInfo
} from './package-smoke-identity.mjs'
import { debianSmokePaths } from './deb-package-lifecycle-smoke.mjs'
import { appImageVersion } from './linux-package-smoke.mjs'
import { artifactVersion } from './macos-package-smoke.mjs'
import {
  assertInstalledWindowsIdentity,
  installerVersion,
  readPackagedAppConfigRoot
} from './windows-installer-smoke.mjs'
const roots: string[] = []
afterEach(async () => {
  configurePackageSmokeIdentity()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
describe('source-driven package smoke identity', () => {
  it.each(['Open-Science', 'EarthNano'])(
    'retains strict artifact, bundle and installed metadata assertions for %s',
    async (productName) => {
      const identity = {
        ...ORIGINAL_SMOKE_IDENTITY,
        productName,
        macExecutable: productName,
        version: '0.1.0-alpha.1'
      }
      configurePackageSmokeIdentity(identity)
      expect(debianSmokePaths(identity)).toMatchObject({
        appRoot: '/opt/' + productName,
        legacyRoot: '/opt/Open-Science',
        legacyTarget: '/opt/Open-Science/open-science',
        cliTarget: '/opt/' + productName + '/resources/open-science-cli'
      })
      for (const [platform, ext, name] of [
        ['mac', 'dmg', 'aipoch-open-science-0.1.0-alpha.1-mac-arm64.dmg'],
        ['linux', 'AppImage', 'aipoch-open-science-0.1.0-alpha.1-linux-x64.AppImage'],
        ['win', 'exe', 'aipoch-open-science-0.1.0-alpha.1-win-x64-setup.exe']
      ] as const) {
        expect(packageArtifactVersion(name, platform, ext)).toBe(identity.version)
        expect(packageArtifactPattern(platform, ext).test('other-' + name)).toBe(false)
      }
      expect(artifactVersion('aipoch-open-science-0.1.0-alpha.1-mac-arm64.dmg')).toBe(
        identity.version
      )
      expect(appImageVersion('aipoch-open-science-0.1.0-alpha.1-linux-x64.AppImage')).toBe(
        identity.version
      )
      expect(installerVersion('aipoch-open-science-0.1.0-alpha.1-win-x64-setup.exe')).toBe(
        identity.version
      )
      const info = {
        CFBundleIdentifier: identity.appId,
        CFBundleName: productName,
        CFBundleDisplayName: productName,
        CFBundleExecutable: productName,
        CFBundleShortVersionString: identity.version
      }
      expect(validateMacBundleInfo(info)).toBe(productName)
      expect(() =>
        validateMacBundleInfo({ ...info, CFBundleExecutable: '../../foreign' })
      ).toThrow()
      expect(() => validateMacBundleInfo({ ...info, CFBundleIdentifier: 'foreign' })).toThrow()
      const version = {
        FileDescription: productName,
        ProductName: productName,
        ProductVersion: '0.1.0.0',
        FileVersion: identity.version
      }
      expect(() => validateWindowsVersionInfo(version)).not.toThrow()
      const run = vi.fn(async () => ({ stdout: JSON.stringify(version) }))
      await assertInstalledWindowsIdentity({
        installDirectory: '/fixture/installed app',
        env: {},
        expectedVersion: identity.version,
        run
      })
      expect(run).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining(['-NoProfile']),
        expect.objectContaining({
          env: expect.objectContaining({
            OPEN_SCIENCE_SMOKE_EXECUTABLE: join(
              '/fixture/installed app',
              identity.windowsExecutable
            )
          })
        })
      )

      expect(() => validateWindowsVersionInfo({ ...version, FileDescription: 'Foreign' })).toThrow()
      expect(() => validateWindowsVersionInfo({ ...version, ProductName: 'Foreign' })).toThrow()
      await expect(
        readPackagedAppConfigRoot(
          {
            appName: productName,
            appVersion: identity.version,
            platform: 'win32',
            configRoot: 'C:\\profile\\.open-science'
          },
          identity.version
        )
      ).resolves.toBe('C:\\profile\\.open-science')
      await expect(
        readPackagedAppConfigRoot(
          {
            appName: 'Foreign',
            appVersion: identity.version,
            platform: 'win32',
            configRoot: 'C:\\profile\\.open-science'
          },
          identity.version
        )
      ).rejects.toThrow('Unexpected installed app bootstrap')
      await expect(
        readPackagedAppConfigRoot(
          {
            appName: productName,
            appVersion: '0.1.0-alpha.2',
            platform: 'win32',
            configRoot: 'C:\\profile\\.open-science'
          },
          identity.version
        )
      ).rejects.toThrow('Unexpected installed app bootstrap')
    }
  )
  it('accepts the actual Windows PE fields while checking the full FileVersion', () => {
    expect(() =>
      validateWindowsVersionInfo(
        {
          FileDescription: 'EarthNano',
          ProductName: 'EarthNano',
          ProductVersion: '0.1.1.0',
          FileVersion: '0.1.1-alpha.1'
        },
        {
          ...ORIGINAL_SMOKE_IDENTITY,
          productName: 'EarthNano',
          version: '0.1.1-alpha.1'
        }
      )
    ).not.toThrow()
  })
  it.each(['0.1.1-alpha.2', '0.1.1', '0.1.1.0', undefined])(
    'rejects FileVersion %s even when ProductVersion matches the full expected version',
    (fileVersion) => {
      expect(() =>
        validateWindowsVersionInfo(
          {
            FileDescription: 'EarthNano',
            ProductName: 'EarthNano',
            ProductVersion: '0.1.1-alpha.1',
            FileVersion: fileVersion
          },
          {
            ...ORIGINAL_SMOKE_IDENTITY,
            productName: 'EarthNano',
            version: '0.1.1-alpha.1'
          }
        )
      ).toThrow('Windows executable version metadata differs')
    }
  )
  it('derives exact artifact templates from trusted source metadata and rejects package/builder drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'earthnano-smoke-identity-'))
    roots.push(root)
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'retained-name', productName: 'EarthNano', version: '0.1.0-alpha.1' })
    )
    await writeFile(
      join(root, 'electron-builder.yml'),
      `appId: com.aipoch.open-science\nproductName: EarthNano\nmac:\n  artifactName: custom-\${name}-\${version}-mac-\${arch}.\${ext}\nwin:\n  executableName: retained-launcher\nnsis:\n  artifactName: custom-\${name}-\${version}-win-\${arch}-setup.\${ext}\nappImage:\n  artifactName: custom-\${name}-\${version}-linux-\${arch}.\${ext}\n`
    )
    const identity = await loadPackageSmokeIdentity(root)
    expect(identity.windowsExecutable).toBe('retained-launcher.exe')
    expect(
      packageArtifactPattern('mac', 'dmg', identity).test(
        'custom-retained-name-0.1.0-alpha.1-mac-arm64.dmg'
      )
    ).toBe(true)
    expect(
      packageArtifactPattern('mac', 'dmg', identity).test(
        'aipoch-open-science-0.1.0-alpha.1-mac-arm64.dmg'
      )
    ).toBe(false)
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'retained-name', productName: 'Foreign', version: '0.1.0-alpha.1' })
    )
    await expect(loadPackageSmokeIdentity(root)).rejects.toThrow('identity disagree')
  })
  it('reads the actual Info.plist executable and validates it before constructing a launch path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'earthnano-bundle-info-'))
    roots.push(root)
    await mkdir(join(root, 'Contents'))
    await writeFile(
      join(root, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.aipoch.open-science</string><key>CFBundleName</key><string>EarthNano</string><key>CFBundleDisplayName</key><string>EarthNano</string><key>CFBundleExecutable</key><string>EarthNano</string><key>CFBundleShortVersionString</key><string>0.1.0-alpha.1</string></dict></plist>`
    )
    expect(
      await readMacBundleExecutable(root, {
        ...ORIGINAL_SMOKE_IDENTITY,
        productName: 'EarthNano',
        macExecutable: 'EarthNano',
        version: '0.1.0-alpha.1'
      })
    ).toBe('EarthNano')
    await expect(readMacBundleExecutable(root)).rejects.toThrow('Info.plist')
  })
  it.each(['Open-Science', 'EarthNano'])(
    'requires byte-identical original packaged licenses for %s',
    async (productName) => {
      const root = await mkdtemp(join(tmpdir(), 'earthnano-package-license-'))
      roots.push(root)
      await mkdir(join(root, 'resources'))
      await writeFile(join(root, 'LICENSE'), 'original Apache license bytes\n')
      await writeFile(join(root, 'resources', 'LICENSE.txt'), 'original Apache license bytes\n')
      const identity = {
        ...ORIGINAL_SMOKE_IDENTITY,
        productName,
        licenses: [{ source: join(root, 'LICENSE'), target: 'LICENSE.txt' }]
      }
      await expect(
        assertPackagedLicenses(join(root, 'resources'), identity)
      ).resolves.toBeUndefined()
      await writeFile(join(root, 'resources', 'LICENSE.txt'), 'changed license')
      await expect(assertPackagedLicenses(join(root, 'resources'), identity)).rejects.toThrow(
        'license differs'
      )
    }
  )
  it('requires Icon Composer catalog packaging and retains the legacy ICNS fallback', async () => {
    const builder = await readFile('electron-builder.yml', 'utf8')
    expect(builder).toContain('icon: build/icon.icon')
    expect(builder).toContain('icon: build/icon.icns')
  })
})
