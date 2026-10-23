// Export platform assets from the approved transparent vector. The classic macOS enclosure
// reuses the exact alpha from the pinned upstream runtime icon; do not hand-draw another mask.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { renderEarthNanoLogo } from './earthnano-logo.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const master = join(root, 'build/earthnano-icon-master.png')
const mask = join(root, 'build/earthnano-legacy-icon-mask.png')
if (process.argv[2]) throw new Error('Use without arguments; edit build/earthnano-logo.svg')
const transparent = await renderEarthNanoLogo(1024)
await sharp(transparent).flatten({ background: '#ffffff' }).png().toFile(master)

const metadata = await sharp(master).metadata()
if (metadata.width !== 1024 || metadata.height !== 1024)
  throw new Error('Expected the approved 1024px square master')
const legacy = await sharp({
  create: { width: 1024, height: 1024, channels: 4, background: '#ffffff' }
})
  .composite([
    { input: await sharp(master).resize(820, 820).png().toBuffer(), left: 102, top: 102 },
    { input: mask, blend: 'dest-in' }
  ])
  .png()
  .toBuffer()
for (const name of ['resources/icon.png', 'resources/icon-dark.png'])
  await writeFile(join(root, name), legacy)
await sharp(legacy).resize(512, 512).png().toFile(join(root, 'build/icon.png'))

const sizes = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256]
// Retain the upstream frame inventory, DIB layout and transparency mask on Windows.
/** @param {Buffer} source @param {number[]} sizes @returns {Promise<Buffer>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JavaScript asset exporter.
const encodeIco = async (source, sizes) => {
  const frames = []
  for (const size of sizes) {
    if (size === 256) {
      frames.push(await sharp(source).resize(size, size).png().toBuffer())
      continue
    }
    const pixels = await sharp(source).resize(size, size).ensureAlpha().raw().toBuffer()
    const stride = Math.ceil(size / 32) * 4
    const bitmap = Buffer.alloc(40 + size * size * 4 + size * stride)
    bitmap.writeUInt32LE(40, 0)
    bitmap.writeInt32LE(size, 4)
    bitmap.writeInt32LE(size * 2, 8)
    bitmap.writeUInt16LE(1, 12)
    bitmap.writeUInt16LE(32, 14)
    bitmap.writeUInt32LE(size * size * 4 + size * stride, 20)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const source = (y * size + x) * 4
        const target = 40 + ((size - y - 1) * size + x) * 4
        bitmap[target] = pixels[source + 2]
        bitmap[target + 1] = pixels[source + 1]
        bitmap[target + 2] = pixels[source]
        bitmap[target + 3] = pixels[source + 3]
        if (pixels[source + 3] === 0)
          bitmap[40 + size * size * 4 + (size - y - 1) * stride + (x >> 3)] |= 0x80 >> (x & 7)
      }
    frames.push(bitmap)
  }
  const header = Buffer.alloc(6 + sizes.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  for (let index = 0; index < sizes.length; index++) {
    const position = 6 + index * 16
    header[position] = sizes[index] === 256 ? 0 : sizes[index]
    header[position + 1] = header[position]
    header.writeUInt16LE(1, position + 4)
    header.writeUInt16LE(32, position + 6)
    header.writeUInt32LE(frames[index].length, position + 8)
    header.writeUInt32LE(offset, position + 12)
    offset += frames[index].length
  }
  return Buffer.concat([header, ...frames])
}
const ico = await encodeIco(legacy, sizes)
for (const name of ['build/icon.ico', 'resources/icon-light.ico', 'resources/icon-dark.ico'])
  await writeFile(join(root, name), ico)

const trayIco = await encodeIco(transparent, [16, 20, 24, 32, 40, 48, 64, 256])
for (const name of ['resources/tray-light.ico', 'resources/tray-dark.ico'])
  await writeFile(join(root, name), trayIco)
for (const [name, size] of [
  ['tray.png', 32],
  ['tray@2x.png', 64]
])
  await sharp(transparent)
    .resize(size, size)
    .png()
    .toFile(join(root, 'resources', name))
// macOS tints the existing template asset; only its alpha silhouette changes.
for (const [name, size] of [
  ['trayTemplate.png', 18],
  ['trayTemplate@2x.png', 36]
]) {
  const alpha = await sharp(transparent).resize(size, size).extractChannel('alpha').toBuffer()
  await sharp({ create: { width: size, height: size, channels: 3, background: '#000000' } })
    .joinChannel(alpha)
    .png()
    .toFile(join(root, 'resources', name))
}

if (process.platform === 'darwin') {
  const iconset = join(tmpdir(), `earthnano-${process.pid}.iconset`)
  await mkdir(iconset)
  try {
    for (const size of [16, 32, 128, 256, 512])
      for (const scale of [1, 2])
        await sharp(legacy)
          .resize(size * scale, size * scale)
          .png()
          .toFile(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`))
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(root, 'build/icon.icns')])
  } finally {
    await rm(iconset, { recursive: true, force: true })
  }
}
await writeFile(join(root, 'build/icon.icon/Assets/earthnano.png'), await readFile(master))
const catalog = JSON.parse(await readFile(join(root, 'build/icon.icon/icon.json'), 'utf8'))
catalog['fill-specializations'] = [{ value: { solid: 'srgb:1.00000,1.00000,1.00000,1.00000' } }]
catalog.groups = [
  {
    layers: [
      {
        'image-name': 'earthnano.png',
        name: 'EarthNano',
        glass: false,
        opacity: 1,
        position: { scale: 1, 'translation-in-points': [0, 0] }
      }
    ],
    shadow: { kind: 'neutral', opacity: 0 },
    translucency: { enabled: false, value: 0 }
  }
]
await writeFile(join(root, 'build/icon.icon/icon.json'), JSON.stringify(catalog, null, 2) + '\n')
console.log(
  'Exported EarthNano app and tray icons from the approved vector; platform enclosures retained.'
)
