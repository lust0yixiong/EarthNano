// Diagnostic only: never launches the application installer or changes its spawn options.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const NSIS_RELEASE = 'nsis-3.0.4.1'
const NSIS_ARCHIVE_SHA256 = '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const readArchivedMember = async (archive, cacheRoot, member) => {
  // This original toolset already unpacked NSIS. Never call its downloading resolver.
  const release = join(cacheRoot, '7zip@1.0.0')
  const prefix = `7zip-win-${process.arch}-`
  const candidates = []
  for (const entry of await readdir(release, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    if (!/^[a-z0-9]{5}$/.test(entry.name.slice(prefix.length))) continue
    const executable = join(release, entry.name, 'bin', '7za.exe')
    if ((await stat(executable).catch(() => undefined))?.isFile()) candidates.push(executable)
  }
  if (candidates.length !== 1 || process.env.ELECTRON_BUILDER_7ZIP_PATH) {
    throw new Error('NSIS diagnostic unavailable: expected one original cached 7zip toolset.')
  }
  // Read one original member to stdout without extracting/installing files.
  const result = spawnSync(candidates[0], ['e', '-so', archive, member], {
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024
  })
  if (result.error || result.status !== 0 || result.signal || !result.stdout?.length) {
    throw new Error(`NSIS diagnostic unavailable: cannot read original archived ${member} bytes.`)
  }
  return result.stdout
}

// Resolve only the already extracted original bundle. No downloader, PATH fallback, or override.
const readArchivedCompiler = (archive, cacheRoot) =>
  readArchivedMember(archive, cacheRoot, 'Bin/makensis.exe')

const cachedCompiler = async (
  cacheRoot,
  expectedArchiveHash = NSIS_ARCHIVE_SHA256,
  readCompiler = readArchivedCompiler
) => {
  const release = join(cacheRoot, NSIS_RELEASE)
  const archive = join(release, `${NSIS_RELEASE}.7z`)
  const archiveBytes = await readFile(archive).catch((error) => {
    throw new Error(`NSIS diagnostic unavailable: cannot read original archive ${archive}`, {
      cause: error
    })
  })
  if (sha256(archiveBytes) !== expectedArchiveHash) {
    throw new Error('Cached original NSIS archive checksum mismatch.')
  }
  const candidates = []
  for (const entry of await readdir(release, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^nsis-3\.0\.4\.1-[a-z0-9]{5}$/.test(entry.name)) continue
    const directory = join(release, entry.name)
    const executable = join(directory, 'Bin', 'makensis.exe')
    if ((await stat(executable).catch(() => undefined))?.isFile()) {
      candidates.push({ directory, executable, archive, archiveSha256: expectedArchiveHash })
    }
  }
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one cached original NSIS compiler, found ${candidates.length}.`
    )
  }
  const compiler = candidates[0]
  const archiveCompilerSha256 = sha256(await readCompiler(archive, cacheRoot))
  if (sha256(await readFile(compiler.executable)) !== archiveCompilerSha256) {
    throw new Error('NSIS diagnostic unavailable: cached compiler differs from original archive.')
  }
  return { ...compiler, archiveCompilerSha256 }
}

const cachedResources = async (
  cacheRoot,
  archiveSha256 = '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103',
  readPlugin = readArchivedMember
) => {
  const releaseName = 'nsis-resources-3.4.1'
  const release = join(cacheRoot, releaseName)
  const archive = join(release, `${releaseName}.7z`)
  if (sha256(await readFile(archive)) !== archiveSha256)
    throw new Error('Cached original NSIS resources checksum mismatch.')
  const candidates = []
  for (const entry of await readdir(release, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^nsis-resources-3\.4\.1-[a-z0-9]{5}$/.test(entry.name)) continue
    const directory = join(release, entry.name, 'plugins', 'x86-unicode')
    const plugin = join(directory, 'StdUtils.dll')
    if ((await stat(plugin).catch(() => undefined))?.isFile())
      candidates.push({ directory, plugin })
  }
  if (candidates.length !== 1)
    throw new Error(
      `Expected exactly one original cached StdUtils plugin, found ${candidates.length}.`
    )
  const resources = candidates[0]
  const pluginSha256 = sha256(
    await readPlugin(archive, cacheRoot, 'plugins/x86-unicode/StdUtils.dll')
  )
  if (sha256(await readFile(resources.plugin)) !== pluginSha256)
    throw new Error('Cached StdUtils plugin differs from original archive.')
  return { ...resources, archive, archiveSha256, pluginSha256 }
}

const lockedTemplates = async () => {
  const require = createRequire(import.meta.url)
  const packageFile = require.resolve('app-builder-lib/package.json')
  const installed = JSON.parse(await readFile(packageFile, 'utf8'))
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  const expectedVersion = lock.packages['node_modules/app-builder-lib'].version
  if (installed.version !== expectedVersion)
    throw new Error('NSIS probe requires the lockfile-selected app-builder-lib.')
  const directory = join(dirname(packageFile), 'templates', 'nsis')
  const multiUser = await readFile(join(directory, 'multiUser.nsh'), 'utf8')
  const macroSource = multiUser.match(/!macro GetDParameter outVar[\s\S]*?!macroend/)?.[0]
  if (!macroSource) throw new Error('Locked NSIS GetDParameter macro unavailable.')
  return {
    directory,
    version: installed.version,
    macroSource,
    multiUserSha256: sha256(Buffer.from(multiUser)),
    stdUtilsSha256: sha256(await readFile(join(directory, 'include', 'StdUtils.nsh')))
  }
}

// The stock compiler has its own MultiUser.nsh. Bind both app-builder headers by absolute
// path: !addincludedir alone does not give them priority over the compiler's Include directory.
const probeSource = `Unicode true
!addincludedir "\${APP_BUILDER_NSIS_DIR}"
!addincludedir "\${APP_BUILDER_NSIS_DIR}\\include"
!addplugindir /x86-unicode "\${APP_BUILDER_NSIS_PLUGIN_DIR}"
!include "LogicLib.nsh"
!include "\${APP_BUILDER_NSIS_DIR}\\include\\StdUtils.nsh"
!define APP_GUID "earthnano-argument-observation"
!define UNINSTALL_APP_KEY "earthnano-argument-observation"
!define INSTALL_MODE_PER_ALL_USERS
!include "\${APP_BUILDER_NSIS_DIR}\\multiUser.nsh"
Name "EarthNano NSIS argument observation"
OutFile "probe.exe"
InstallDir "$EXEDIR\\default-target"
RequestExecutionLevel user
SilentInstall silent
Section
  System::Call 'kernel32::GetCommandLineW() w .r1'
  StrCpy $2 $INSTDIR
  !insertmacro GetDParameter $R0
  \${If} $R0 != ""
    StrCpy $INSTDIR $R0
  \${EndIf}
  ClearErrors
  FileOpen $0 "$EXEDIR\\observation.txt" w
  IfErrors failed
  FileWriteUTF16LE /BOM $0 "$1$\\r$\\n$CMDLINE$\\r$\\n$INSTDIR$\\r$\\n$R0$\\r$\\n$2"
  FileClose $0
  IfErrors failed
  SetErrorLevel 0
  Goto done
failed:
  SetErrorLevel 3
done:
SectionEnd
`

const parseObservation = (bytes) => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xfe) throw new Error('Missing UTF-16LE probe receipt BOM.')
  const lines = bytes.subarray(2).toString('utf16le').split('\r\n')
  if (lines.length !== 5 || lines.some((line) => !line))
    throw new Error('Invalid NSIS probe receipt.')
  // NSIS removes a recognized /D suffix from $CMDLINE; retain GetCommandLineW separately.
  return {
    rawCommandLine: lines[0],
    nsisCommandLine: lines[1],
    installDirectory: lines[2],
    dParameter: lines[3],
    builtinInstallDirectory: lines[4]
  }
}

const execute = (executable, args, options) => {
  const result = spawnSync(executable, args, {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    ...options
  })
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? null
  }
}

const runArgumentProbe = async ({ compiler, resources, out, env = process.env, run = execute }) => {
  await mkdir(out, { recursive: true })
  // This fresh owned directory contains all probe writes. No installation/registry/cleanup actions.
  const work = await mkdtemp(join(resolve(out), 'nsis-arguments-'))
  const report = {
    schemaVersion: 2,
    purpose: 'NSIS argument mechanism observation; does not diagnose or fix application exit 2',
    node: process.version,
    uv: process.versions.uv,
    platform: process.platform,
    compiler: { ...compiler, sha256: sha256(await readFile(compiler.executable)) },
    profile: Object.fromEntries(
      ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'].map((key) => [
        key,
        env[key]
      ])
    ),
    cases: []
  }
  const reportPath = join(work, 'report.json')
  const save = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  const requireSuccess = (result, phase) => {
    if (result.error || result.exitCode !== 0 || result.signal) {
      throw new Error(`${phase} failed; see ${reportPath}`)
    }
  }
  try {
    report.parser = await lockedTemplates()
    if (!resources?.directory) throw new Error('Original cached StdUtils resources unavailable.')
    report.resources = resources
    const compilerEnv = { ...env, NSISDIR: compiler.directory }
    report.version = await run(compiler.executable, ['/VERSION'], {
      env: compilerEnv,
      timeout: 15_000
    })
    requireSuccess(report.version, 'NSIS version observation')
    report.headerInfo = await run(compiler.executable, ['/HDRINFO'], {
      env: compilerEnv,
      timeout: 15_000
    })
    requireSuccess(report.headerInfo, 'NSIS build configuration observation')
    await writeFile(join(work, 'probe.nsi'), `\ufeff${probeSource}`, 'utf8')
    report.compile = await run(
      compiler.executable,
      [
        '/NOCONFIG',
        '/V4',
        `/DAPP_BUILDER_NSIS_DIR=${report.parser.directory}`,
        `/DAPP_BUILDER_NSIS_PLUGIN_DIR=${resources.directory}`,
        'probe.nsi'
      ],
      {
        cwd: work,
        env: compilerEnv,
        timeout: 60_000
      }
    )
    requireSuccess(report.compile, 'NSIS probe compilation')
    const probe = join(work, 'probe.exe')
    report.probeSha256 = sha256(await readFile(probe))
    // Same spaces/Unicode and isolated profile layout as the original smoke.
    const profileRoot = join(work, 'profile 数据 with spaces')
    const profile = {
      HOME: profileRoot,
      USERPROFILE: profileRoot,
      APPDATA: join(profileRoot, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(profileRoot, 'AppData', 'Local'),
      TEMP: join(profileRoot, 'Temp'),
      TMP: join(profileRoot, 'Temp')
    }
    await Promise.all(
      Object.values(profile).map((directory) => mkdir(directory, { recursive: true }))
    )
    const probeEnv = { ...env, ...profile }
    report.probeProfile = profile
    for (const mode of ['default', 'verbatim-observation']) {
      const directory = join(work, `${mode} executable 程序`)
      const executable = join(directory, basename(probe))
      const target = join(work, 'installed app 程序')
      const args = ['/S', `/D=${target}`]
      const options = { env: probeEnv, timeout: 15_000 }
      if (mode === 'verbatim-observation') {
        options.windowsVerbatimArguments = true
        // With verbatim argv, explicitly quote only argv[0], never the /D argument.
        options.argv0 = `"${executable}"`
      }
      const observation = {
        mode,
        executable,
        args,
        target,
        argv0: options.argv0,
        windowsVerbatimArguments: options.windowsVerbatimArguments ?? false
      }
      report.cases.push(observation)
      // A failed control must never prevent the corrected invocation from running. A receipt
      // remains evidence even when its process fails; neither fact implies the other succeeded.
      try {
        await mkdir(directory)
        await copyFile(probe, executable)
        Object.assign(observation, await run(executable, args, options))
      } catch (error) {
        observation.error = String(error?.message ?? error)
      }
      observation.executionSucceeded =
        !observation.error && observation.exitCode === 0 && !observation.signal
      try {
        Object.assign(
          observation,
          parseObservation(await readFile(join(directory, 'observation.txt')))
        )
        observation.targetSelected = observation.installDirectory === target
      } catch (error) {
        observation.receiptError = String(error?.message ?? error)
      }
      observation.targetCreated = !!(await stat(target).catch(() => undefined))
      await save()
    }
    const corrected = report.cases[1]
    report.passed =
      report.cases.every((item) => !item.receiptError && !item.targetCreated) &&
      corrected.executionSucceeded &&
      corrected.targetSelected === true
    if (!report.passed) throw new Error(`NSIS argument comparison failed; see ${reportPath}`)
  } catch (error) {
    report.error = String(error?.message ?? error)
    error.reportPath = reportPath
    throw error
  } finally {
    await save()
  }
  return reportPath
}

const main = async () => {
  if (process.platform !== 'win32')
    throw new Error('The real NSIS argument probe requires Windows.')
  if (process.argv.length !== 4 || process.argv[2] !== '--out') {
    throw new Error(
      'Usage: node scripts/windows-nsis-arguments-probe.mjs --out <evidence-directory>'
    )
  }
  const out = resolve(process.argv[3])
  try {
    if (process.env.ELECTRON_BUILDER_NSIS_DIR || process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR) {
      throw new Error('NSIS override is set; original cached compiler provenance is unavailable.')
    }
    const require = createRequire(import.meta.url)
    const { getCacheDirectory } = require('app-builder-lib/out/util/electronGet.js')
    const cache = getCacheDirectory({ allowEnvVarOverride: true })
    const compiler = await cachedCompiler(cache)
    const resources = await cachedResources(cache)
    console.log(await runArgumentProbe({ compiler, resources, out }))
  } catch (error) {
    if (error.reportPath) throw error
    await mkdir(out, { recursive: true })
    const directory = await mkdtemp(join(out, 'unavailable-'))
    await writeFile(
      join(directory, 'report.json'),
      `${JSON.stringify({ available: false, error: String(error?.message ?? error) }, null, 2)}\n`
    )
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

export { cachedCompiler, cachedResources, parseObservation, probeSource, runArgumentProbe }
