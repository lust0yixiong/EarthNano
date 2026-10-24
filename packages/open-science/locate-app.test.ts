import { beforeEach, expect, it, vi } from 'vitest'

const existing = vi.hoisted(() => new Set<string>())
vi.mock('node:fs/promises', () => ({
  access: vi.fn(async (path: string) => {
    if (!existing.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  }),
  readFile: vi.fn(async () => {
    throw new Error('no packaged manifest')
  }),
  realpath: vi.fn(async (path: string) => path)
}))

import { locateApp } from './locate-app.mjs'

beforeEach(() => existing.clear())

// Discovery only: no native binary is launched or package created.
it.each(['OneEarth', 'EarthNano', 'Open-Science'])(
  'finds an installed %s application without changing its location',
  async (name) => {
    const path =
      process.platform === 'darwin'
        ? `/Applications/${name}.app/Contents/MacOS/${name}`
        : process.platform === 'win32'
          ? `C:\\Apps\\${name}\\open-science.exe`
          : `/opt/${name}/open-science`
    existing.add(path)
    expect(await locateApp({ env: { PROGRAMFILES: 'C:\\Apps' } })).toMatchObject({
      command: path,
      packaged: true
    })
  }
)

it('honors an explicit old or custom executable path', async () => {
  const path =
    process.platform === 'win32'
      ? 'C:\\Research\\open-science.exe'
      : '/Research/Open-Science/custom'
  existing.add(path)
  expect(await locateApp({ appPath: path })).toMatchObject({ command: path })
})

it('uses OneEarth in the missing-installation guidance', async () => {
  await expect(locateApp({ env: {} })).rejects.toThrow('Could not locate OneEarth.')
})
