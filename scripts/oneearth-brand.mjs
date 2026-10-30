/* eslint-disable @typescript-eslint/explicit-function-return-type -- JavaScript brand asset exporter. */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import sharp from 'sharp'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const exportOneEarthBrand = async (check = false) => {
  const letters = await readFile(join(root, 'build/oneearth-wordmark.svg'), 'utf8')
  const mark = await readFile(join(root, 'build/earthnano-logo.svg'), 'utf8')
  const nested = (source, x, y, width, height) => {
    const svg = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement
    for (const [key, value] of Object.entries({ x, y, width, height }))
      svg.setAttribute(key, String(value))
    return new XMLSerializer().serializeToString(svg)
  }
  const lockup = `<svg xmlns="http://www.w3.org/2000/svg" width="660" height="200" viewBox="0 0 660 200"><title>OneEarth</title>${nested(mark, 0, 0, 200, 200)}${nested(letters, 216, 71.25, 425, 57.5)}</svg>\n`
  const outputs = [
    ['src/renderer/src/assets/oneearth-wordmark.svg', Buffer.from(letters)],
    [
      'src/renderer/src/assets/oneearth-wordmark-dark.svg',
      Buffer.from(letters.replaceAll('#050101', '#eceee8'))
    ],
    ['docs/earthnano/assets/oneearth-lockup.svg', Buffer.from(lockup)],
    [
      'docs/earthnano/assets/oneearth-lockup-dark.svg',
      Buffer.from(lockup.replaceAll('#050101', '#eceee8'))
    ],
    [
      'docs/earthnano/assets/oneearth-lockup.png',
      await sharp(Buffer.from(lockup), { density: 144 }).png().toBuffer()
    ]
  ]
  for (const [name, content] of outputs) {
    const path = join(root, name)
    if (check) {
      if (!(await readFile(path)).equals(content)) throw new Error(`${name} is stale`)
    } else await writeFile(path, content)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('Use [--check]')
  await exportOneEarthBrand(process.argv.includes('--check'))
  console.log('OneEarth wordmark and combined brand assets are synchronized.')
}
