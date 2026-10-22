// One-off failed-install observation. The diagnostic setup is never a validated package.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { cachedCompiler, cachedResources } from './windows-nsis-arguments-probe.mjs'
import { loadPackageSmokeIdentity, packageArtifactPattern } from './package-smoke-identity.mjs'
import { terminateProcessTree } from './windows-installer-smoke.mjs'

const MARKERS = [
  'PREINIT',
  'CUSTOM_INIT_BEGIN',
  'CUSTOM_INIT_END',
  'QUIT_FAILED_UPDATE',
  'CUSTOM_INIT_BEFORE_UNINSTALLER_PROBE',
  'CUSTOM_INIT_AFTER_UNINSTALLER_PROBE',
  'CUSTOM_INIT_BEFORE_MODE_PROTECTION',
  'CUSTOM_INIT_AFTER_MODE_PROTECTION',
  'PUBLICATION_PREPARE_BEGIN',
  'PUBLICATION_PREPARE_RETURN_OK',
  'PUBLICATION_PREPARE_RETURN_FAILED',
  'PUBLICATION_EXTRACT_BEGIN',
  'PUBLICATION_EXTRACT_RETURN_OK',
  'PUBLICATION_EXTRACT_RETURN_FAILED',
  'PUBLICATION_PUBLISH_BEGIN',
  'PUBLICATION_PUBLISH_RETURN_OK',
  'PUBLICATION_PUBLISH_RETURN_FAILED',
  'INSTALL_FAILED_CALLBACK',
  'CUSTOM_INSTALL_BEGIN',
  'CUSTOM_INSTALL_END'
]
const block = (body) => `# EARTHNANO_STAGE_BEGIN\n${body}\n# EARTHNANO_STAGE_END\n`
const marker = (name) => {
  if (!MARKERS.includes(name)) throw new Error('Unknown fixed installer stage.')
  return `Push "${name}"\nCall earthNanoDiagnosticStage`
}
const insert = (source, anchor, before = '', after = '') => {
  if (source.split(anchor).length !== 2) throw new Error('Original installer stage anchor changed.')
  return source.replace(
    anchor,
    `${before ? block(before) : ''}${anchor}${after ? block(after) : ''}`
  )
}
const absoluteNsisPath = (path) => {
  if (!win32.isAbsolute(path) || /[\r\n"$]/u.test(path))
    throw new Error('Diagnostic NSIS paths must be absolute and contain no NSIS metacharacters.')
  return win32.normalize(path)
}
const traceFunction = (trace) => `Function earthNanoDiagnosticStage
  Exch $0
  Push $1
  Push $2
  IfErrors diagnostic_saved_error diagnostic_saved_clear
  diagnostic_saved_error:
    StrCpy $2 1
    Goto diagnostic_write
  diagnostic_saved_clear:
    StrCpy $2 0
  diagnostic_write:
    ClearErrors
    FileOpen $1 "${absoluteNsisPath(trace)}" a
    IfErrors diagnostic_restore
    FileWrite $1 "$0$\\r$\\n"
    FileClose $1
  StrCpy $1 $0 12
  StrCmp $1 "PUBLICATION_" 0 diagnostic_restore
  FileOpen $1 "${absoluteNsisPath(trace)}.$0.txt" w
  IfErrors diagnostic_restore
  FileWriteUTF16LE /BOM $1 "$publicationResult$\\r$\\n$publicationOutput"
  FileClose $1
  diagnostic_restore:
    StrCmp $2 1 diagnostic_restore_error diagnostic_restore_clear
  diagnostic_restore_error:
    SetErrors
    Goto diagnostic_restore_registers
  diagnostic_restore_clear:
    ClearErrors
  diagnostic_restore_registers:
    Pop $2
    Pop $1
    Pop $0
FunctionEnd`
const resultMarker = (phase) => `\${if} $publicationResult == "0"
${marker(`PUBLICATION_${phase}_RETURN_OK`)}
\${else}
${marker(`PUBLICATION_${phase}_RETURN_FAILED`)}
\${endif}`

export const createStageOverlay = ({
  installer,
  license,
  publication,
  originalBuild,
  overlay,
  trace,
  compiler
}) => {
  const original = (file) => absoluteNsisPath(win32.join(originalBuild, file))
  const owned = (file) => absoluteNsisPath(win32.join(overlay, file))
  let source = installer
  for (const [from, to] of [
    [
      '!include "${BUILD_RESOURCES_DIR}\\windows-update-handoff.nsh"',
      `!include "${original('windows-update-handoff.nsh')}"`
    ],
    [
      '!include "${BUILD_RESOURCES_DIR}\\windows-install-publication.nsh"',
      `!include "${owned('windows-install-publication.nsh')}"`
    ]
  ]) {
    if (source.split(from).length !== 2) throw new Error('Original installer include changed.')
    source = source.replace(from, to)
  }
  const originalInit = source.match(/!macro customInit\n[\s\S]*?\n!macroend/)?.[0]
  if (!originalInit) throw new Error('Original installer stage anchor changed.')
  let init = insert(originalInit, '!macro customInit\n', '', marker('CUSTOM_INIT_BEGIN'))
  init = insert(init, '  openScienceCustomInit_done:\n', '', marker('CUSTOM_INIT_END'))
  init = insert(
    init,
    '    Call ensureExistingUninstallerIsWritable\n',
    marker('CUSTOM_INIT_BEFORE_UNINSTALLER_PROBE'),
    marker('CUSTOM_INIT_AFTER_UNINSTALLER_PROBE')
  )
  init = insert(
    init,
    '    !insertmacro protectMachineDataRootForSelectedMode\n',
    marker('CUSTOM_INIT_BEFORE_MODE_PROTECTION'),
    marker('CUSTOM_INIT_AFTER_MODE_PROTECTION')
  )
  source = source.replace(originalInit, init)
  source = insert(source, '!macro quitFailedUpdate\n', '', marker('QUIT_FAILED_UPDATE'))
  source = insert(source, '!macro customHeader\n', '', traceFunction(trace))
  source = insert(source, '  Function .onInstFailed\n', '', marker('INSTALL_FAILED_CALLBACK'))
  source = insert(source, '!macro customInstall\n', '', marker('CUSTOM_INSTALL_BEGIN'))
  source = insert(
    source,
    '  Push "installed"\n  Call writeUpdateReceipt\n',
    '',
    marker('CUSTOM_INSTALL_END')
  )
  // customHeader and these hooks are already inside the original !ifndef BUILD_UNINSTALLER.
  source = insert(
    source,
    '!macro customInit\n',
    `!macro preInit\n!ifndef BUILD_UNINSTALLER\n${marker('PREINIT')}\n!endif\n!macroend`,
    ''
  )
  const include = '!include "${BUILD_RESOURCES_DIR}\\installer.nsh"'
  if (license.split(include).length !== 2) throw new Error('Original license include changed.')
  const licenseSource = license.replace(include, `!include "${owned('installer.nsh')}"`)
  if (publication.split('!include x64.nsh').length !== 2)
    throw new Error('Original publication include changed.')
  let publicationSource = publication.replace(
    '!include x64.nsh',
    `!include "${absoluteNsisPath(win32.join(compiler, 'Include', 'x64.nsh'))}"`
  )
  for (const phase of ['prepare', 'publish']) {
    publicationSource = insert(
      publicationSource,
      `  !insertmacro runInstallPublication ${phase}\n`,
      marker(`PUBLICATION_${phase.toUpperCase()}_BEGIN`),
      resultMarker(phase.toUpperCase())
    )
  }
  publicationSource = insert(
    publicationSource,
    `  nsExec::ExecToStack '"$PLUGINSDIR\\7za.exe" x -y -bd -bso0 -bsp0 -bse1 "-o$publicationDirectory" "\${FILE}"'\n`,
    marker('PUBLICATION_EXTRACT_BEGIN'),
    ''
  )
  publicationSource = insert(
    publicationSource,
    '  Pop $publicationResult\n  Pop $publicationOutput\n  StrCmp',
    '',
    ''
  )
  // Preserve the two Pop operations before observing their fixed success/failure classification.
  publicationSource = publicationSource.replace(
    '  Pop $publicationResult\n  Pop $publicationOutput\n  StrCmp',
    `  Pop $publicationResult\n  Pop $publicationOutput\n${block(resultMarker('EXTRACT'))}  StrCmp`
  )
  return {
    'installer.nsh': source,
    'installer-license.nsh': licenseSource,
    'windows-install-publication.nsh': publicationSource
  }
}

const digest = async (path) => {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
const regular = async (path) => {
  const state = await lstat(path)
  if (!state.isFile() || state.isSymbolicLink())
    throw new Error('Diagnostic requires original regular files, not links.')
  return state
}
export const copyOwnedPayload = async (source, destination) => {
  const sourceRoot = await realpath(source)
  if (!(await lstat(source)).isDirectory() || (await lstat(source)).isSymbolicLink())
    throw new Error('Original payload must be an ordinary directory.')
  await mkdir(destination)
  const visit = async (directory, target) => {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry)
      const state = await lstat(path)
      if (
        state.isSymbolicLink() ||
        relative(sourceRoot, await realpath(path))
          .split(/[\\/]/u)
          .includes('..')
      )
        throw new Error('Diagnostic payload links or escaping paths are unavailable.')
      const output = join(target, entry)
      if (state.isDirectory()) {
        await mkdir(output)
        await visit(path, output)
      } else if (state.isFile()) await copyFile(path, output, constants.COPYFILE_EXCL)
      else throw new Error('Diagnostic payload contains a non-regular entry.')
    }
  }
  await visit(source, destination)
}
const protectedManifest = async (root, installerDirectory, payload) => {
  const paths = [
    ...(await readdir(join(root, 'build')))
      .filter((name) => name.endsWith('.nsh'))
      .map((name) => join(root, 'build', name)),
    ...(await readdir(installerDirectory))
      .filter((name) => name.endsWith('.exe'))
      .map((name) => join(installerDirectory, name)),
    join(payload, 'open-science.exe'),
    join(payload, 'resources', 'app.asar')
  ].sort()
  if (!paths.some((path) => dirname(path) === installerDirectory && path.endsWith('.exe')))
    throw new Error('Original setup is unavailable.')
  return Promise.all(
    paths.map(async (path) => {
      await regular(path)
      return { path, sha256: await digest(path) }
    })
  )
}
const lockedBuilder = async (root) => {
  const require = createRequire(join(root, 'package.json'))
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const versions = {}
  for (const name of ['electron-builder', 'app-builder-lib']) {
    const path = require.resolve(`${name}/package.json`)
    const installed = JSON.parse(await readFile(path, 'utf8'))
    if (installed.version !== lock.packages[`node_modules/${name}`]?.version)
      throw new Error('Diagnostic requires the lockfile-selected builder.')
    versions[name] = installed.version
  }
  return { cli: require.resolve('electron-builder/cli.js'), versions }
}
const originalTools = async () => {
  if (
    process.env.ELECTRON_BUILDER_NSIS_DIR ||
    process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR ||
    process.env.ELECTRON_BUILDER_7ZIP_PATH
  )
    throw new Error('Diagnostic unavailable with custom compiler/resource/tool overrides.')
  const require = createRequire(import.meta.url)
  const { getCacheDirectory } = require('app-builder-lib/out/util/electronGet.js')
  const cache = getCacheDirectory({ allowEnvVarOverride: true })
  return { compiler: await cachedCompiler(cache), resources: await cachedResources(cache) }
}
// Reuse the original smoke's process-tree teardown for a finite diagnostic build/run.
// Bounds apply to this observation only; no product install timeout or success rule changes.
export const executeDiagnostic = (command, args, options) =>
  new Promise((finish) => {
    const output = createWriteStream(options.log, { flags: 'wx' })
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true })
    let error
    let bytes = 0
    let stopping = false
    const stop = (reason) => {
      if (stopping) return
      stopping = true
      error = reason
      void terminateProcessTree(child).catch((failure) => {
        error += `; teardown: ${String(failure?.message ?? failure)}`
      })
    }
    const observe = (chunk) => {
      bytes += chunk.length
      if (bytes <= (options.maxLogBytes ?? 16 * 1024 * 1024)) output.write(chunk)
      else stop('Diagnostic output exceeded its finite log budget.')
    }
    const timer = setTimeout(
      () => stop('Diagnostic process exceeded its finite time budget.'),
      options.timeoutMs ?? 15 * 60 * 1000
    )
    child.stdout?.on('data', observe)
    child.stderr?.on('data', observe)
    output.on('error', (failure) => stop(`Diagnostic log: ${failure.message}`))
    child.on('error', (value) => {
      error = value.message
    })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      output.end(() => finish({ exitCode, signal, error: error ?? null, outputBytes: bytes }))
    })
  })
export const parseStageTrace = (bytes) => {
  if (bytes.length > 1024 * 1024) throw new Error('Diagnostic trace exceeds its bounded format.')
  const markers = bytes.toString('utf8').split('\r\n')
  if (markers.pop() !== '' || markers.some((name) => !MARKERS.includes(name)))
    throw new Error('Invalid fixed-stage trace.')
  return markers
}
export const runStageDiagnostic = async ({
  root = process.cwd(),
  installerDirectory = join(root, 'dist'),
  out,
  tools = originalTools,
  run = executeDiagnostic
}) => {
  root = resolve(root)
  installerDirectory = resolve(installerDirectory)
  await mkdir(out, { recursive: true })
  const work = await mkdtemp(join(resolve(out), 'installer-stage-'))
  const reportPath = join(work, 'report.json')
  const trace = join(work, 'stages.txt')
  const report = {
    schemaVersion: 1,
    purpose: 'Failed-installer fixed-stage observation; never a validated package',
    available: false,
    node: process.version,
    platform: process.platform,
    trace,
    status: 'unavailable'
  }
  let before
  try {
    const payload = join(installerDirectory, 'win-unpacked')
    before = await protectedManifest(root, installerDirectory, payload)
    report.originalBefore = before
    const builder = await lockedBuilder(root)
    report.builder = builder
    report.tools = await tools()
    // Copy rather than exposing the original payload to target/signing tools, even with prepackaged.
    // Keep copied packages out of the small evidence upload; the hosted runner owns scratch.
    const scratch = await mkdtemp(join(tmpdir(), 'earthnano-installer-stage-'))
    report.scratch = scratch
    const diagnosticPayload = join(scratch, 'payload')
    await copyOwnedPayload(payload, diagnosticPayload)
    const overlay = join(work, 'overlay')
    await mkdir(overlay)
    await writeFile(trace, '', { flag: 'wx' })
    const overlays = createStageOverlay({
      installer: await readFile(join(root, 'build', 'installer.nsh'), 'utf8'),
      license: await readFile(join(root, 'build', 'installer-license.nsh'), 'utf8'),
      publication: await readFile(join(root, 'build', 'windows-install-publication.nsh'), 'utf8'),
      originalBuild: join(root, 'build'),
      overlay,
      trace,
      compiler: report.tools.compiler.directory
    })
    for (const [name, source] of Object.entries(overlays))
      await writeFile(join(overlay, name), `\ufeff${source}`, 'utf8')
    const output = join(scratch, 'diagnostic-output')
    const buildArgs = [
      builder.cli,
      '--win',
      'nsis',
      '--x64',
      '--publish',
      'never',
      '--prepackaged',
      diagnosticPayload,
      `-c.directories.output=${output}`,
      `-c.nsis.include=${join(overlay, 'installer-license.nsh')}`
    ]
    const buildEnv = {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      ELECTRON_BUILDER_NSIS_DIR: report.tools.compiler.directory,
      ELECTRON_BUILDER_NSIS_RESOURCES_DIR: dirname(dirname(report.tools.resources.directory))
    }
    report.available = true
    report.status = 'build-failed'
    report.build = {
      command: process.execPath,
      args: buildArgs,
      ...(await run(process.execPath, buildArgs, {
        cwd: root,
        env: buildEnv,
        log: join(work, 'build.log'),
        timeoutMs: 15 * 60 * 1000
      }))
    }
    if (report.build.error || report.build.signal || report.build.exitCode !== 0)
      throw new Error(
        'Diagnostic prepackaged build failed; original smoke result remains unchanged.'
      )
    const identity = await loadPackageSmokeIdentity(root)
    const setups = (await readdir(output)).filter((name) =>
      packageArtifactPattern('win', 'exe', identity).test(name)
    )
    if (setups.length !== 1) throw new Error('Expected one isolated diagnostic setup.')
    report.diagnosticSetup = {
      path: join(output, setups[0]),
      sha256: await digest(join(output, setups[0]))
    }
    // Do not trim the original smoke plan, identity checks, installer args, or process budgets.
    const smokeArgs = [
      join(root, 'scripts', 'windows-installer-smoke.mjs'),
      '--installer-dir',
      output
    ]
    report.status = 'smoke-failed'
    report.smoke = {
      command: process.execPath,
      args: smokeArgs,
      ...(await run(process.execPath, smokeArgs, {
        cwd: root,
        env: process.env,
        log: join(work, 'smoke.log'),
        timeoutMs: 10 * 60 * 1000
      }))
    }
    report.status = 'observed'
  } catch (error) {
    report.error = String(error?.message ?? error)
  } finally {
    try {
      report.stageMarkers = parseStageTrace(await readFile(trace))
      report.publication = []
      for (const name of new Set(
        report.stageMarkers.filter(
          (value) => value.startsWith('PUBLICATION_') && value.includes('_RETURN_')
        )
      )) {
        const path = `${trace}.${name}.txt`
        const bytes = await readFile(path).catch(() => undefined)
        if (!bytes) continue
        if (bytes.length > 128 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xfe)
          report.traceError = 'Invalid bounded publication observation.'
        else
          report.publication.push({
            stage: name,
            path,
            output: bytes.subarray(2).toString('utf16le')
          })
      }
    } catch (error) {
      report.traceError = String(error?.message ?? error)
    }
    if (before) {
      try {
        report.originalAfter = await protectedManifest(
          root,
          installerDirectory,
          join(installerDirectory, 'win-unpacked')
        )
        report.originalsUnchanged = isDeepStrictEqual(before, report.originalAfter)
        if (!report.originalsUnchanged) report.status = 'originals-changed'
      } catch (error) {
        report.integrityError = String(error?.message ?? error)
        report.status = 'originals-changed'
      }
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  }
  return reportPath
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const main = async () => {
    if (process.platform !== 'win32')
      throw new Error('Real installer stage diagnostics require Windows.')
    if (
      process.argv.length !== 6 ||
      process.argv[2] !== '--installer-dir' ||
      process.argv[4] !== '--out'
    )
      throw new Error('Usage: --installer-dir <original-dist> --out <owned-evidence-directory>')
    const reportPath = await runStageDiagnostic({
      installerDirectory: process.argv[3],
      out: resolve(process.argv[5])
    })
    console.log(reportPath)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    if (
      !report.available ||
      !report.originalsUnchanged ||
      report.traceError ||
      !report.smoke ||
      report.smoke.error ||
      report.smoke.signal ||
      report.smoke.exitCode !== 0
    )
      process.exitCode = 1
  }
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
