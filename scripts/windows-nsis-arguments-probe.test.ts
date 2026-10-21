import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  cachedCompiler,
  cachedResources,
  parseObservation,
  probeSource,
  runArgumentProbe
} from './windows-nsis-arguments-probe.mjs'

const receipt = (raw: string, parsed: string, target: string): Buffer =>
  Buffer.from(`\ufeff${raw}\r\n${parsed}\r\n${target}\r\n${target}\r\n${target}`, 'utf16le')

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
      installDirectory: 'C:\\installed app 程序',
      dParameter: 'C:\\installed app 程序',
      builtinInstallDirectory: 'C:\\installed app 程序'
    })
    expect(() => parseObservation(Buffer.from('untrusted output'))).toThrow(/BOM/)
    expect(() => parseObservation(receipt('raw', 'parsed', ''))).toThrow(/Invalid/)
    expect(probeSource).toContain('kernel32::GetCommandLineW()')
    expect(probeSource).toContain('FileWriteUTF16LE /BOM')
    expect(probeSource).toContain('!include "multiUser.nsh"')
    expect(probeSource).toContain('!insertmacro GetDParameter $R0')
    expect(probeSource).not.toMatch(/\bQuit\b/)
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

  it('verifies cached StdUtils against its original resource archive without resolving a downloader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nsis-original-stdutils-'))
    const release = join(root, 'nsis-resources-3.4.1')
    const archive = join(release, 'nsis-resources-3.4.1.7z')
    const plugin = join(
      release,
      'nsis-resources-3.4.1-abc12',
      'plugins',
      'x86-unicode',
      'StdUtils.dll'
    )
    const archiveBytes = Buffer.from('archive fixture, never executed')
    const pluginBytes = Buffer.from('plugin fixture, never executed')
    const checksum = createHash('sha256').update(archiveBytes).digest('hex')
    const readPlugin = vi.fn(async () => pluginBytes)
    try {
      await mkdir(dirname(plugin), { recursive: true })
      await writeFile(archive, archiveBytes)
      await writeFile(plugin, pluginBytes)
      await expect(cachedResources(root, checksum, readPlugin)).resolves.toMatchObject({
        directory: dirname(plugin),
        archiveSha256: checksum,
        pluginSha256: createHash('sha256').update(pluginBytes).digest('hex')
      })
      expect(readPlugin).toHaveBeenCalledWith(archive, root, 'plugins/x86-unicode/StdUtils.dll')
      await writeFile(plugin, 'changed plugin')
      await expect(cachedResources(root, checksum, readPlugin)).rejects.toThrow(
        /differs from original/
      )
      await expect(cachedResources(root)).rejects.toThrow(/checksum mismatch/)
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
        resources: { directory: root },
        out: join(root, 'evidence'),
        env: { TEMP: root, SECRET: 'not evidence' },
        run
      })
      const report = JSON.parse(await readFile(path, 'utf8'))
      expect(calls).toHaveLength(5)
      expect(calls[0].args).toEqual(['/VERSION'])
      expect(calls[1].args).toEqual(['/HDRINFO'])
      expect(calls[2].args).toEqual([
        '/NOCONFIG',
        '/V4',
        `/DAPP_BUILDER_NSIS_DIR=${report.parser.directory}`,
        `/DAPP_BUILDER_NSIS_PLUGIN_DIR=${root}`,
        'probe.nsi'
      ])
      const lockedMacro = await readFile(join(report.parser.directory, 'multiUser.nsh'), 'utf8')
      expect(report.parser.macroSource).toBe(
        lockedMacro.match(/!macro GetDParameter outVar[\s\S]*?!macroend/)![0]
      )
      expect(report.parser.multiUserSha256).toBe(
        createHash('sha256').update(lockedMacro).digest('hex')
      )
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

  it('observes the corrected case and both receipts even when the default process exits 2', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nsis-independent-cases-'))
    const executable = join(root, 'makensis.exe')
    await writeFile(executable, 'fixture compiler, never executed')
    const modes: boolean[] = []
    const run = vi.fn(async (command: string, args: string[], options: Record<string, unknown>) => {
      if (args.includes('probe.nsi'))
        await writeFile(join(options.cwd as string, 'probe.exe'), 'fixture probe, never executed')
      if (command !== executable) {
        const verbatim = options.windowsVerbatimArguments === true
        modes.push(verbatim)
        const target = args[1].slice(3)
        await writeFile(
          join(dirname(command), 'observation.txt'),
          receipt('raw command', 'NSIS command', verbatim ? target : target + '"')
        )
        return { exitCode: verbatim ? 0 : 2, signal: null, stdout: '', stderr: '', error: null }
      }
      return { exitCode: 0, signal: null, stdout: '', stderr: '', error: null }
    })
    try {
      const path = await runArgumentProbe({
        compiler: { executable, directory: root },
        resources: { directory: root },
        out: join(root, 'evidence'),
        env: {},
        run
      })
      const report = JSON.parse(await readFile(path, 'utf8'))
      expect(modes).toEqual([false, true])
      expect(report.cases[0]).toMatchObject({
        exitCode: 2,
        executionSucceeded: false,
        targetSelected: false
      })
      expect(report.cases[1]).toMatchObject({
        exitCode: 0,
        executionSucceeded: true,
        targetSelected: true
      })
      expect(report.passed).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    'missing-control-receipt',
    'control-spawn-error',
    'corrected-nonzero',
    'corrected-wrong-target',
    'target-created'
  ])(
    'rejects incomplete or failed comparisons after both independent calls: %s',
    async (failure) => {
      const root = await mkdtemp(join(tmpdir(), 'nsis-case-failure-'))
      const executable = join(root, 'makensis.exe')
      await writeFile(executable, 'fixture compiler, never executed')
      let executions = 0
      const run = vi.fn(
        async (command: string, args: string[], options: Record<string, unknown>) => {
          if (args.includes('probe.nsi'))
            await writeFile(
              join(options.cwd as string, 'probe.exe'),
              'fixture probe, never executed'
            )
          const corrected = options.windowsVerbatimArguments === true
          if (command !== executable) {
            executions++
            if (failure === 'control-spawn-error' && !corrected)
              throw new Error('spawn unavailable')
            const target = args[1].slice(3)
            if (failure !== 'missing-control-receipt' || corrected)
              await writeFile(
                join(dirname(command), 'observation.txt'),
                receipt(
                  'raw command',
                  'NSIS command',
                  corrected && failure === 'corrected-wrong-target' ? 'wrong target' : target
                )
              )
            if (failure === 'target-created' && corrected) await mkdir(target)
          }
          return {
            exitCode: corrected && failure === 'corrected-nonzero' ? 2 : 0,
            signal: null,
            stdout: '',
            stderr: '',
            error: null
          }
        }
      )
      try {
        const out = join(root, 'evidence')
        await expect(
          runArgumentProbe({
            compiler: { executable, directory: root },
            resources: { directory: root },
            out,
            env: {},
            run
          })
        ).rejects.toThrow(/comparison failed/)
        expect(executions).toBe(2)
        const [directory] = await readdir(out)
        const report = JSON.parse(await readFile(join(out, directory, 'report.json'), 'utf8'))
        expect(report.cases).toHaveLength(2)
        expect(report.passed).toBe(false)
        if (failure === 'control-spawn-error')
          expect(report.cases[0].error).toBe('spawn unavailable')
        if (failure === 'missing-control-receipt')
          expect(report.cases[0].receiptError).toBeDefined()
        if (failure === 'corrected-nonzero') expect(report.cases[1].exitCode).toBe(2)
        if (failure === 'corrected-wrong-target') expect(report.cases[1].targetSelected).toBe(false)
        if (failure === 'target-created') expect(report.cases[1].targetCreated).toBe(true)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

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
        runArgumentProbe({
          compiler: { executable, directory: root },
          resources: { directory: root },
          out,
          env: {},
          run
        })
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
