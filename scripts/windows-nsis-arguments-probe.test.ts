import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  cachedCompiler,
  parseObservation,
  probeSource,
  runArgumentProbe
} from './windows-nsis-arguments-probe.mjs'

const receipt = (raw: string, parsed: string, target: string): Buffer =>
  Buffer.from(`\ufeff${raw}\r\n${parsed}\r\n${target}`, 'utf16le')

describe('bounded NSIS argument observation', () => {
  it('retains both raw Windows and NSIS-mutated command lines without interpreting success', () => {
    expect(
      parseObservation(
        receipt(
          '"probe.exe" /S /D=C:\\installed app 程序',
          '"probe.exe" /S',
          'C:\\installed app 程序'
        )
      )
    ).toEqual({
      rawCommandLine: '"probe.exe" /S /D=C:\\installed app 程序',
      nsisCommandLine: '"probe.exe" /S',
      installDirectory: 'C:\\installed app 程序'
    })
    expect(() => parseObservation(Buffer.from('untrusted output'))).toThrow(/BOM/)
    expect(() => parseObservation(receipt('raw', 'parsed', ''))).toThrow(/Invalid/)
    expect(probeSource).toContain('kernel32::GetCommandLineW()')
    expect(probeSource).toContain('FileWriteUTF16LE /BOM')
    expect(probeSource).not.toMatch(/SetOutPath|CreateDirectory|WriteReg|ExecWait|\/LOG/)
  })

  it('requires one already cached original bundle and verifies its archive without downloading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nsis-cache-observation-'))
    const release = join(root, 'nsis-3.0.4.1')
    const archive = join(release, 'nsis-3.0.4.1.7z')
    const compiler = join(release, 'nsis-3.0.4.1-abc12', 'Bin', 'makensis.exe')
    const bytes = Buffer.from('test archive, never executed')
    const compilerBytes = Buffer.from('compiler fixture, never executed')
    const readCompiler = vi.fn(async () => compilerBytes)
    const checksum = createHash('sha256').update(bytes).digest('hex')
    try {
      await mkdir(dirname(compiler), { recursive: true })
      await writeFile(archive, bytes)
      await writeFile(compiler, compilerBytes)
      await expect(cachedCompiler(root, checksum, readCompiler)).resolves.toMatchObject({
        executable: compiler,
        archive,
        archiveSha256: checksum,
        archiveCompilerSha256: createHash('sha256').update(compilerBytes).digest('hex')
      })
      expect(readCompiler).toHaveBeenCalledWith(archive, root)
      await writeFile(compiler, 'different compiler')
      await expect(cachedCompiler(root, checksum, readCompiler)).rejects.toThrow(
        /differs from original/
      )
      await expect(cachedCompiler(root)).rejects.toThrow(/checksum mismatch/)
      const second = join(release, 'nsis-3.0.4.1-def34', 'Bin', 'makensis.exe')
      await mkdir(dirname(second), { recursive: true })
      await writeFile(second, 'ambiguous compiler')
      await expect(cachedCompiler(root, checksum, readCompiler)).rejects.toThrow(/found 2/)
      await rm(archive)
      await expect(cachedCompiler(root, checksum)).rejects.toThrow(/diagnostic unavailable/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps default args as the control and limits verbatim to an explicit observation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nsis-argument-orchestration-'))
    const executable = join(root, 'makensis.exe')
    await writeFile(executable, 'test compiler, never executed')
    const calls: { executable: string; args: string[]; options: Record<string, unknown> }[] = []
    // This is an orchestration fixture, not a Windows/NSIS execution or quoting simulation.
    const run = vi.fn(async (command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ executable: command, args, options })
      if (args.includes('probe.nsi')) {
        await writeFile(join(options.cwd as string, 'probe.exe'), 'test probe, never executed')
      } else if (command !== executable) {
        await writeFile(
          join(dirname(command), 'observation.txt'),
          receipt('observed raw command', 'observed NSIS command', args[1].slice(3))
        )
      }
      return { exitCode: 0, signal: null, stdout: '', stderr: '', error: null }
    })
    try {
      const path = await runArgumentProbe({
        compiler: { executable, directory: root },
        out: join(root, 'evidence'),
        env: { TEMP: root, SECRET: 'not evidence' },
        run
      })
      const report = JSON.parse(await readFile(path, 'utf8'))
      expect(calls).toHaveLength(5)
      expect(calls[0].args).toEqual(['/VERSION'])
      expect(calls[1].args).toEqual(['/HDRINFO'])
      expect(calls[2].args).toEqual(['/NOCONFIG', '/V4', 'probe.nsi'])
      expect(calls.map((call) => call.options.timeout)).toEqual([
        15_000, 15_000, 60_000, 15_000, 15_000
      ])
      const control = calls[3]
      const observation = calls[4]
      expect(control.args).toEqual(['/S', expect.stringMatching(/^\/D=.*installed app 程序$/)])
      expect(observation.args).toEqual(control.args)
      expect(control.options).not.toHaveProperty('windowsVerbatimArguments')
      expect(control.options).not.toHaveProperty('argv0')
      expect(observation.options).toMatchObject({
        windowsVerbatimArguments: true,
        argv0: `"${observation.executable}"`
      })
      expect(control.options.env).toEqual(observation.options.env)
      expect(control.options.env).toMatchObject({
        SECRET: 'not evidence',
        USERPROFILE: expect.stringContaining('profile 数据 with spaces'),
        TEMP: expect.stringContaining('Temp')
      })
      expect(report.cases.map((item: { mode: string }) => item.mode)).toEqual([
        'default',
        'verbatim-observation'
      ])
      expect(report.cases.every((item: { targetCreated: boolean }) => !item.targetCreated)).toBe(
        true
      )
      expect(await readFile(path, 'utf8')).not.toContain('not evidence')
      expect(await readFile(join(dirname(path), 'probe.nsi'), 'utf8')).toBe(`\ufeff${probeSource}`)
      expect(await readFile(executable, 'utf8')).toBe('test compiler, never executed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports missing original archive-reader cache without downloading or executing a compiler', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nsis-archive-read-'))
    const release = join(root, 'nsis-3.0.4.1')
    const directory = join(release, 'nsis-3.0.4.1-abc12')
    const compiler = join(directory, 'Bin', 'makensis.exe')
    const archive = join(release, 'nsis-3.0.4.1.7z')
    try {
      await mkdir(dirname(compiler), { recursive: true })
      await writeFile(compiler, 'data fixture, never executed')
      await writeFile(archive, 'archive fixture, never executed')
      const checksum = createHash('sha256')
        .update(await readFile(archive))
        .digest('hex')
      await expect(cachedCompiler(root, checksum)).rejects.toThrow(/original cached 7zip toolset/)
      expect(await readdir(root)).toEqual(['nsis-3.0.4.1'])
      expect(await readdir(directory)).toEqual(['Bin'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retains a failed real-probe stage as unavailable evidence rather than inferring a result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nsis-failed-observation-'))
    const executable = join(root, 'makensis.exe')
    await writeFile(executable, 'test compiler, never executed')
    const run = vi.fn(async () => ({
      exitCode: 2,
      signal: null,
      stdout: '',
      stderr: 'compiler unavailable',
      error: null
    }))
    try {
      const out = join(root, 'evidence')
      await expect(
        runArgumentProbe({ compiler: { executable, directory: root }, out, env: {}, run })
      ).rejects.toThrow(/version observation failed/)
      expect(run).toHaveBeenCalledOnce()
      const [directory] = await readdir(out)
      const report = JSON.parse(await readFile(join(out, directory, 'report.json'), 'utf8'))
      expect(report.version).toMatchObject({ exitCode: 2, stderr: 'compiler unavailable' })
      expect(report.cases).toEqual([])
      expect(report.error).toContain('version observation failed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
