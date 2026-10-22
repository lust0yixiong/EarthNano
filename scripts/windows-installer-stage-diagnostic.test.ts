import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  copyOwnedPayload,
  createStageOverlay,
  executeDiagnostic,
  parseStageTrace
} from './windows-installer-stage-diagnostic.mjs'

const stripObservation = (source: string): string =>
  source.replace(/# EARTHNANO_STAGE_BEGIN\n[\s\S]*?# EARTHNANO_STAGE_END\n/g, '')

describe('isolated failed-installer stage observation', () => {
  it('preserves the original NSIS lifecycle after removing fixed observations and include paths', async () => {
    const installer = await readFile('build/installer.nsh', 'utf8')
    const license = await readFile('build/installer-license.nsh', 'utf8')
    const publication = await readFile('build/windows-install-publication.nsh', 'utf8')
    const result = createStageOverlay({
      installer,
      license,
      publication,
      originalBuild: 'C:\\repo\\build',
      overlay: 'C:\\evidence\\overlay',
      trace: 'C:\\evidence\\stages.txt',
      compiler: 'C:\\original-nsis'
    })
    expect(
      stripObservation(result['installer.nsh'])
        .replace(
          '!include "C:\\repo\\build\\windows-update-handoff.nsh"',
          '!include "${BUILD_RESOURCES_DIR}\\windows-update-handoff.nsh"'
        )
        .replace(
          '!include "C:\\evidence\\overlay\\windows-install-publication.nsh"',
          '!include "${BUILD_RESOURCES_DIR}\\windows-install-publication.nsh"'
        )
    ).toBe(installer)
    expect(
      result['installer-license.nsh'].replace(
        '!include "C:\\evidence\\overlay\\installer.nsh"',
        '!include "${BUILD_RESOURCES_DIR}\\installer.nsh"'
      )
    ).toBe(license)
    expect(
      stripObservation(result['windows-install-publication.nsh']).replace(
        '!include "C:\\original-nsis\\Include\\x64.nsh"',
        '!include x64.nsh'
      )
    ).toBe(publication)
    expect(result['installer.nsh']).toContain(
      'IfErrors diagnostic_saved_error diagnostic_saved_clear'
    )
    expect(result['installer.nsh']).toContain(
      'FileWriteUTF16LE /BOM $1 "$publicationResult$\\r$\\n$publicationOutput"'
    )
    expect(() =>
      createStageOverlay({
        installer: installer.replace('!macro customInit\n', ''),
        license,
        publication,
        originalBuild: 'C:\\repo\\build',
        overlay: 'C:\\evidence\\overlay',
        trace: 'C:\\evidence\\stages.txt',
        compiler: 'C:\\original-nsis'
      })
    ).toThrow(/anchor changed/)
    expect(() =>
      createStageOverlay({
        installer,
        license,
        publication,
        originalBuild: 'C:\\repo\\build',
        overlay: 'C:\\evidence\\overlay',
        trace: 'C:\\evidence\\$unsafe.txt',
        compiler: 'C:\\original-nsis'
      })
    ).toThrow(/metacharacters/)
  })

  it('accepts only complete fixed markers, preserving an empty observation as no reached stage', () => {
    expect(parseStageTrace(Buffer.from('PREINIT\r\nCUSTOM_INIT_BEGIN\r\n'))).toEqual([
      'PREINIT',
      'CUSTOM_INIT_BEGIN'
    ])
    expect(parseStageTrace(Buffer.alloc(0))).toEqual([])
    expect(() => parseStageTrace(Buffer.from('PREINIT'))).toThrow(/Invalid/)
    expect(() => parseStageTrace(Buffer.from('UNRECOGNIZED\r\n'))).toThrow(/Invalid/)
    expect(() => parseStageTrace(Buffer.alloc(1024 * 1024 + 1))).toThrow(/bounded/)
  })

  it('copies real payload bytes without exposing the original to packaging tools and rejects links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'earthnano-stage-copy-'))
    try {
      const source = join(root, 'source')
      const copy = join(root, 'copy')
      await mkdir(source)
      await writeFile(join(source, 'app.asar'), 'original package bytes')
      await copyOwnedPayload(source, copy)
      await writeFile(join(copy, 'app.asar'), 'diagnostic-only bytes')
      expect(await readFile(join(source, 'app.asar'), 'utf8')).toBe('original package bytes')
      await symlink(join(source, 'app.asar'), join(source, 'linked.asar'))
      await expect(copyOwnedPayload(source, join(root, 'unsafe-copy'))).rejects.toThrow(/links/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['completed-without-close', 'never-completed'])(
    'settles with cleanup-unconfirmed when teardown is %s',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'earthnano-stage-unconfirmed-'))
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        unref: vi.fn()
      })
      const terminate = vi.fn(() =>
        mode === 'never-completed' ? new Promise<void>(() => {}) : Promise.resolve()
      )
      try {
        const result = await executeDiagnostic(
          'fixture-child',
          [],
          { log: join(root, 'bounded.log'), timeoutMs: 5, cleanupTimeoutMs: 10 },
          terminate,
          () => child as never
        )
        expect(result).toMatchObject({ exitCode: null, signal: null, cleanupConfirmed: false })
        expect(result.error).toMatch(/cleanup-unconfirmed/)
        expect(terminate).toHaveBeenCalledOnce()
        expect(child.unref).toHaveBeenCalledOnce()
        expect(child.stdout.destroyed).toBe(true)
        expect(child.stderr.destroyed).toBe(true)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('retains actual nonzero exit/output and bounds a stuck real child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'earthnano-stage-process-'))
    try {
      const log = join(root, 'nonzero.log')
      const failure = await executeDiagnostic(
        process.execPath,
        ['-e', "process.stdout.write('real child output'); process.exitCode = 2"],
        { log, timeoutMs: 5000 }
      )
      expect(failure).toMatchObject({ exitCode: 2, signal: null, error: null })
      expect(await readFile(log, 'utf8')).toBe('real child output')
      const timeout = await executeDiagnostic(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { log: join(root, 'timeout.log'), timeoutMs: 100 }
      )
      expect(timeout.error).toMatch(/finite time budget/)
      const oversized = await executeDiagnostic(
        process.execPath,
        ['-e', "process.stdout.write('x'.repeat(1024 * 1024)); setInterval(() => {}, 1000)"],
        { log: join(root, 'oversized.log'), timeoutMs: 5000, maxLogBytes: 16 }
      )
      expect(oversized.error).toMatch(/finite log budget/)
      expect((await readFile(join(root, 'oversized.log'))).length).toBeLessThanOrEqual(16)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
