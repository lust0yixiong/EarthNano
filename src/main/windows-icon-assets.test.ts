import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const projectRoot = process.env['WINDOWS_ICON_TEST_ROOT']
  ? resolve(process.env['WINDOWS_ICON_TEST_ROOT'])
  : resolve(__dirname, '../..')

type IcoEntry = {
  width: number
  height: number
  bitCount: number
  byteSize: number
  imageOffset: number
}

const APP_ICON_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256]
const TRAY_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
const LIGHT_SMALL_FRAME_HASHES = {
  16: '6a96e54c3f0fcfb8da6dc4aec6f38fa89718a6539d563cab8a74dd331bfa490b',
  20: 'acaf758b3baf594ff52d8d45598f94b3d5de90a9b9cd2676a9010f8e3d3e4ae7',
  24: '4b09ac208997f36902b1f002120b0f0671615affc61ed260c052519c862c5d2e'
}
const DARK_SMALL_FRAME_HASHES = {
  16: '6a96e54c3f0fcfb8da6dc4aec6f38fa89718a6539d563cab8a74dd331bfa490b',
  20: 'acaf758b3baf594ff52d8d45598f94b3d5de90a9b9cd2676a9010f8e3d3e4ae7',
  24: '4b09ac208997f36902b1f002120b0f0671615affc61ed260c052519c862c5d2e'
}
const ICON_ASSETS = [
  {
    relativePath: 'build/icon.ico',
    expectedSizes: APP_ICON_SIZES,
    expectedSha256: 'dd2f1e02a4b286bbccd1ed61ffba321a3dcfe56daf1c10517bd16290791f946e'
  },
  {
    relativePath: 'resources/icon-light.ico',
    expectedSizes: APP_ICON_SIZES,
    expectedSha256: 'dd2f1e02a4b286bbccd1ed61ffba321a3dcfe56daf1c10517bd16290791f946e'
  },
  {
    relativePath: 'resources/icon-dark.ico',
    expectedSizes: APP_ICON_SIZES,
    expectedSha256: 'dd2f1e02a4b286bbccd1ed61ffba321a3dcfe56daf1c10517bd16290791f946e'
  },
  {
    relativePath: 'resources/tray-light.ico',
    expectedSizes: TRAY_ICON_SIZES,
    expectedSha256: 'e5bb025fb58726f92fad76a7d8a106d4e4b204fcb1440a7340077569150b1189'
  },
  {
    relativePath: 'resources/tray-dark.ico',
    expectedSizes: TRAY_ICON_SIZES,
    expectedSha256: 'e5bb025fb58726f92fad76a7d8a106d4e4b204fcb1440a7340077569150b1189'
  }
]

const readIco = (
  relativePath: string
): { bytes: Buffer; reserved: number; type: number; entries: IcoEntry[] } => {
  const bytes = readFileSync(resolve(projectRoot, relativePath))
  const count = bytes.readUInt16LE(4)
  const entries = Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16
    return {
      width: bytes[offset] || 256,
      height: bytes[offset + 1] || 256,
      bitCount: bytes.readUInt16LE(offset + 6),
      byteSize: bytes.readUInt32LE(offset + 8),
      imageOffset: bytes.readUInt32LE(offset + 12)
    }
  })

  return {
    bytes,
    reserved: bytes.readUInt16LE(0),
    type: bytes.readUInt16LE(2),
    entries
  }
}

describe('Windows icon assets', () => {
  it.each(ICON_ASSETS)('ships the approved multi-size ICO in $relativePath', (asset) => {
    const { bytes, reserved, type, entries } = readIco(asset.relativePath)
    const directoryEnd = 6 + entries.length * 16

    expect(reserved).toBe(0)
    expect(type).toBe(1)
    expect(entries.map(({ width }) => width).sort((a, b) => a - b)).toEqual(asset.expectedSizes)
    expect(entries.every(({ width, height }) => width === height)).toBe(true)
    expect(entries.every(({ bitCount }) => bitCount === 32)).toBe(true)
    expect(
      entries.every(
        ({ byteSize, imageOffset }) =>
          imageOffset >= directoryEnd && imageOffset + byteSize <= bytes.length
      )
    ).toBe(true)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.expectedSha256)
  })

  it('keeps the packaged default synchronized with the EarthNano light icon', () => {
    expect(readFileSync(resolve(projectRoot, 'build/icon.ico'))).toEqual(
      readFileSync(resolve(projectRoot, 'resources/icon-light.ico'))
    )
  })

  it.each([
    { relativePath: 'build/icon.ico', expectedHashes: LIGHT_SMALL_FRAME_HASHES },
    { relativePath: 'resources/icon-light.ico', expectedHashes: LIGHT_SMALL_FRAME_HASHES },
    { relativePath: 'resources/icon-dark.ico', expectedHashes: DARK_SMALL_FRAME_HASHES }
  ])('keeps the EarthNano mark recognizable in the small frames of $relativePath', (asset) => {
    const { bytes, entries } = readIco(asset.relativePath)
    const smallFrameHashes = Object.fromEntries(
      entries
        .filter(({ width }) => width in asset.expectedHashes)
        .map(({ width, byteSize, imageOffset }) => [
          width,
          createHash('sha256')
            .update(bytes.subarray(imageOffset, imageOffset + byteSize))
            .digest('hex')
        ])
    )

    expect(smallFrameHashes).toEqual(asset.expectedHashes)
  })
})
