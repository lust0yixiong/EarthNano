import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { EARTHNANO_LOGO_POINTS } from '../src/renderer/src/components/earthnano-logo-points'
import { exportEarthNanoLogo, sampleEarthNanoLogo } from './earthnano-logo.mjs'

// Use dual connectivity: diagonally touching foreground pixels belong to one curve, while a
// transparent pinhole must have a real four-connected route to the outer background.
const componentSizes = (mask: Uint8Array, width: number, diagonal = false): number[] => {
  const seen = new Uint8Array(mask.length)
  const sizes: number[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    const queue = [start]
    seen[start] = 1
    for (let index = 0; index < queue.length; index++) {
      const pixel = queue[index]
      const x = pixel % width
      const y = Math.floor(pixel / width)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx === 0 && dy === 0) || (!diagonal && dx !== 0 && dy !== 0)) continue
          const nx = x + dx
          const ny = y + dy
          const next = ny * width + nx
          if (nx < 0 || nx >= width || ny < 0 || next >= mask.length) continue
          if (mask[next] && !seen[next]) {
            seen[next] = 1
            queue.push(next)
          }
        }
    }
    sizes.push(queue.length)
  }
  return sizes.sort((a, b) => b - a)
}

describe('EarthNano original artwork cutout', () => {
  it('ships both themes and startup particles from the same original artwork', async () => {
    await expect(exportEarthNanoLogo(true)).resolves.toBeUndefined()
    const mark = await readFile(resolve('src/renderer/src/assets/logo.png'))
    const dark = await readFile(resolve('src/renderer/src/assets/logo-dark.png'))
    expect(dark).toEqual(mark)
    expect(await sampleEarthNanoLogo(mark)).toEqual(EARTHNANO_LOGO_POINTS)
  })

  it('keeps five complete lobes and five droplets, without stray islands or internal pinholes', async () => {
    const { data, info } = await sharp(resolve('src/renderer/src/assets/logo.png'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect([info.width, info.height, info.channels]).toEqual([512, 512, 4])
    const foreground = Uint8Array.from({ length: 512 * 512 }, (_, p) =>
      data[p * 4 + 3] >= 128 ? 1 : 0
    )
    const sizes = componentSizes(foreground, 512, true)
    expect(sizes).toHaveLength(10)
    expect(sizes[4]).toBeGreaterThan(8000)
    expect(sizes[5]).toBeLessThan(1000)
    expect(sizes[9]).toBeGreaterThan(60)
    expect(
      componentSizes(
        foreground.map((value) => 1 - value),
        512
      )
    ).toHaveLength(1)
    for (const [x, y] of [
      [0, 0],
      [511, 0],
      [0, 511],
      [511, 511]
    ])
      expect(data[(y * 512 + x) * 4 + 3]).toBe(0)
  })

  it('preserves the original curved silhouette and spacing instead of imposing a circle', async () => {
    const original = await sharp(resolve('build/earthnano-icon-master.png'))
      .extract({ left: 80, top: 80, width: 860, height: 860 })
      .resize(512, 512)
      .removeAlpha()
      .raw()
      .toBuffer()
    const actual = await sharp(resolve('src/renderer/src/assets/logo.png'))
      .ensureAlpha()
      .raw()
      .toBuffer()
    let intersection = 0
    let union = 0
    const reference = Uint8Array.from({ length: 512 * 512 }, (_, p) => {
      const rgb = original.subarray(p * 3, p * 3 + 3)
      return Math.max(...rgb) - Math.min(...rgb) > 32 ? 1 : 0
    })
    let changesOutsideEdge = 0
    for (let p = 0; p < 512 * 512; p++) {
      const wasArtwork = reference[p] === 1
      const isArtwork = actual[p * 4 + 3] >= 128
      if (wasArtwork && isArtwork) intersection++
      if (wasArtwork || isArtwork) union++
      if (wasArtwork === isArtwork) continue
      const x = p % 512
      const y = Math.floor(p / 512)
      let touchesOriginalEdge = false
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx >= 0 && nx < 512 && ny >= 0 && ny < 512)
            touchesOriginalEdge ||= reference[ny * 512 + nx] !== reference[p]
        }
      if (!touchesOriginalEdge) changesOutsideEdge++
    }
    // Edge decontamination may remove the old white matte, but cannot alter a curve's interior,
    // invent a circular boundary, or change the internal gaps. All changed pixels stay at the edge.
    expect(changesOutsideEdge).toBe(0)
    expect(intersection / union).toBeGreaterThan(0.97)
  })
})
