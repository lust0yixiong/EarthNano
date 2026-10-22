import { mkdtemp, rm, writeFile, realpath, cp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { StartDesktopSweep } from '../../shared/earthnano/optimization-sweep'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ManagedFileReadLease } from '../managed-file-versions/read-port'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SettingsService } from '../settings/service'
import type { ApplicationModuleBuilder } from '../application-runtime'
import type { StartDesktopOptimization } from '../../shared/earthnano/desktop-optimization'
const mocks = vi.hoisted(() => ({
  root: '',
  releaseWriter: vi.fn(),
  corrupt: false,
  constructed: vi.fn(),
  readResume: vi.fn(),
  register: vi.fn()
}))
vi.mock('../storage-root', () => ({
  resolveDataRoot: () => join(mocks.root, 'data'),
  resolveConfigRoot: () => join(mocks.root, 'config')
}))
vi.mock('../storage/migration-state', () => ({
  acquireDataRootWriter: () => mocks.releaseWriter,
  isMigrationInProgress: () => false,
  isMigrationPending: () => false
}))
vi.mock('../runtime-metadata', () => ({
  runtimeMetadata: () => ({
    packaged: false,
    applicationPath: mocks.root,
    resourcesPath: mocks.root
  })
}))
vi.mock('../desktop-surface-declarations', () => ({
  registerDesktopOptimizationIpcHandlers: mocks.register
}))
vi.mock('../earthnano/desktop-optimization-manager', () => ({
  readDesktopOptimizationResume: mocks.readResume,
  DesktopOptimizationSetupError: class extends Error {},
  DesktopOptimizationManager: class {
    constructor(options: unknown) {
      mocks.constructed(options)
      if (mocks.corrupt) throw new Error('Corrupt persisted metadata')
    }
    hasActiveWork = (): boolean => false
    shutdown = async (): Promise<{ reaped: boolean }> => ({ reaped: true })
    prepareForUpdateGate = async (): Promise<{ reaped: boolean }> => ({ reaped: true })
    releaseUpdateGate = (): void => undefined
    start = vi.fn()
    startSweep = vi.fn()
    previewSweep = vi.fn()
    get = vi.fn()
    latest = vi.fn()
    stop = vi.fn()
    resume = vi.fn()
  }
}))
import {
  createDesktopOptimizationOptions,
  createDesktopSweepOptions,
  createDesktopSweepPreview,
  resolveOptimizationPython,
  registerDesktopOptimizationComposition
} from './desktop-optimization'
const request: StartDesktopOptimization = {
  projectId: 'p',
  sourceSessionId: 's',
  requestKey: 'key',
  prompt: 'Synthetic task',
  files: [{ path: 'input.txt', content: 'synthetic' }],
  criteria: 'Check synthetic result',
  executionLimit: 9
}
const target = {
  frameworkId: 'claude-code' as const,
  providerId: 'selected',
  model: { kind: 'required' as const, id: 'custom-model' },
  reasoningEffort: 'default' as const
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- preserve concrete fixture types
const selected = () => ({
  providerId: 'selected',
  provider: {
    type: 'custom' as const,
    model: 'custom-model',
    key: 'synthetic-private-key',
    baseUrl: 'https://provider.invalid/anthropic',
    apiEndpoints: ['messages' as const]
  },
  reasoningEffortProfile: { supported: false as const }
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- preserve concrete Vitest mocks
const dependencies = () => ({
  platform: 'linux' as const,
  settings: {
    getStoredSettings: vi.fn(),
    captureActiveExplicitAgentBackendTarget: vi.fn().mockResolvedValue(target),
    resolveIsolatedClaudeProvider: vi.fn().mockResolvedValue(selected()),
    resolveIsolatedClaudeExecutable: vi.fn().mockResolvedValue('/synthetic/claude')
  },
  sessionPersistence: { repository: {}, coordinator: {} } as NonNullable<
    Parameters<typeof createDesktopOptimizationOptions>[1]['sessionPersistence']
  >,
  validateSession: vi.fn().mockResolvedValue(undefined),
  admitSessionWork: vi.fn().mockReturnValue(vi.fn()),
  harnessRoot: mocks.root,
  probeClaudeVersion: vi.fn().mockResolvedValue('2.1.232'),
  resolvePython: vi.fn().mockResolvedValue('/synthetic/python3.11')
})
beforeEach(async () => {
  vi.clearAllMocks()
  mocks.root = await mkdtemp(join(tmpdir(), 'optimization-composition-'))
  mocks.corrupt = false
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(mocks.root, { recursive: true, force: true })
})
it('captures only an explicit custom messages route and holds original admission until cleanup', async () => {
  const deps = dependencies()
  const options = await createDesktopOptimizationOptions(request, deps)
  expect(options.input.task).toEqual({ prompt: request.prompt, files: request.files })
  expect(options.executionLimit).toBe(9)
  expect(options.python).toBe('/synthetic/python3.11')
  expect(options.semanticCriteria).toBe(request.criteria)
  expect(JSON.stringify(options.input)).not.toContain('synthetic-private-key')
  expect(deps.settings.resolveIsolatedClaudeProvider).toHaveBeenCalledWith(target)
  expect(mocks.releaseWriter).not.toHaveBeenCalled()
  const binding = await options.binding(options.input.agent)
  expect(binding).toMatchObject({
    executablePath: '/synthetic/claude',
    runtimeVersion: '2.1.232',
    provider: { key: 'synthetic-private-key' }
  })
  options.releaseAdmission()
  options.releaseAdmission()
  expect(mocks.releaseWriter).toHaveBeenCalledTimes(1)
  expect(deps.admitSessionWork.mock.results[0].value).toHaveBeenCalledTimes(1)
})
it('passes the application Session persistence authority to candidates without reconstructing a private owner', async () => {
  const sessionPersistence = {
    repository: {},
    coordinator: {}
  } as NonNullable<Parameters<typeof createDesktopOptimizationOptions>[1]['sessionPersistence']>
  const options = await createDesktopOptimizationOptions(request, {
    ...dependencies(),
    sessionPersistence
  })
  expect(options.ownerOptions.sessionPersistence).toBe(sessionPersistence)
  options.releaseAdmission()
})
it('rejects unsupported backend/subscription/endpoints and releases leases without spawning', async () => {
  for (const variant of ['backend', 'subscription', 'endpoint'] as const) {
    const deps = dependencies()
    if (variant === 'backend')
      deps.settings.captureActiveExplicitAgentBackendTarget.mockResolvedValue({
        ...target,
        frameworkId: 'opencode'
      })
    if (variant === 'subscription')
      deps.settings.resolveIsolatedClaudeProvider.mockResolvedValue({
        ...selected(),
        provider: { ...selected().provider, type: 'claude-shared' }
      })
    if (variant === 'endpoint')
      deps.settings.resolveIsolatedClaudeProvider.mockResolvedValue({
        ...selected(),
        provider: { ...selected().provider, apiEndpoints: ['chat-completions'] }
      })
    await expect(createDesktopOptimizationOptions(request, deps)).rejects.toThrow()
    expect(deps.settings.resolveIsolatedClaudeExecutable).not.toHaveBeenCalled()
  }
  expect(mocks.releaseWriter).toHaveBeenCalledTimes(3)
})
it('rejects a changed provider identity during the frozen run', async () => {
  const deps = dependencies(),
    options = await createDesktopOptimizationOptions(request, deps)
  deps.settings.resolveIsolatedClaudeProvider.mockResolvedValue({
    ...selected(),
    provider: { ...selected().provider, baseUrl: 'https://changed.invalid' }
  })
  await expect(options.binding(options.input.agent)).rejects.toThrow('provider changed')
  options.releaseAdmission()
})
it('pins provider routing across reconstruction while allowing a credential rotation on the same route', async () => {
  const deps = dependencies()
  const original = await createDesktopOptimizationOptions(request, deps)
  original.releaseAdmission()
  deps.settings.resolveIsolatedClaudeProvider.mockResolvedValue({
    ...selected(),
    provider: { ...selected().provider, key: 'rotated-synthetic-key' }
  })
  const rotated = await createDesktopOptimizationOptions(request, deps)
  expect(rotated.input.agent.providerRef).toBe(original.input.agent.providerRef)
  expect(JSON.stringify(rotated.input)).not.toContain('rotated-synthetic-key')
  rotated.releaseAdmission()
  deps.settings.resolveIsolatedClaudeProvider.mockResolvedValue({
    ...selected(),
    provider: { ...selected().provider, baseUrl: 'https://different.invalid/anthropic' }
  })
  const rerouted = await createDesktopOptimizationOptions(request, deps)
  expect(rerouted.input.agent.providerRef).not.toBe(original.input.agent.providerRef)
  expect(JSON.stringify(rerouted.input)).not.toContain('https://different.invalid')
  rerouted.releaseAdmission()
})
it.each(['2.1.118', '2.1.250'])(
  'freezes the selected CLI version %s for every candidate instead of the development version',
  async (version) => {
    const deps = dependencies()
    deps.probeClaudeVersion.mockResolvedValue(version)
    const options = await createDesktopOptimizationOptions(request, deps)
    expect(deps.probeClaudeVersion).toHaveBeenCalledExactlyOnceWith('/synthetic/claude')
    expect(options.input.agent.runtimeVersion).toBe(version)
    // A later probe result cannot silently change an already frozen comparison.
    deps.probeClaudeVersion.mockResolvedValue('2.1.999')
    expect(await options.binding(options.input.agent)).toMatchObject({
      executablePath: '/synthetic/claude',
      runtimeVersion: version
    })
    await expect(
      options.binding({ ...options.input.agent, runtimeVersion: '2.1.999' })
    ).rejects.toThrow('provider changed')
    options.releaseAdmission()
  }
)
it.each([undefined, 'unverified', '2.1.117'])(
  'rejects unverified or unsupported CLI version %s and releases admission before execution',
  async (version) => {
    const deps = dependencies()
    deps.probeClaudeVersion.mockResolvedValue(version)
    await expect(createDesktopOptimizationOptions(request, deps)).rejects.toThrow(
      'supported Claude Code runtime'
    )
    expect(mocks.releaseWriter).toHaveBeenCalledOnce()
    expect(deps.admitSessionWork.mock.results[0].value).toHaveBeenCalledOnce()
    expect(deps.resolvePython).not.toHaveBeenCalled()
  }
)
it('uses the existing version probe on the selected executable when no test probe is supplied', async () => {
  const deps = dependencies()
  const executable = join(mocks.root, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  await writeFile(
    executable,
    process.platform === 'win32'
      ? '@echo off\r\necho 2.1.250\r\n'
      : '#!/bin/sh\nprintf "2.1.250 (Claude Code)\\n"\n',
    { mode: 0o700 }
  )
  deps.settings.resolveIsolatedClaudeExecutable.mockResolvedValue(executable)
  const options = await createDesktopOptimizationOptions(request, {
    ...deps,
    probeClaudeVersion: undefined
  })
  expect(options.input.agent.runtimeVersion).toBe('2.1.250')
  expect(await options.binding(options.input.agent)).toMatchObject({
    executablePath: executable,
    runtimeVersion: '2.1.250'
  })
  options.releaseAdmission()
})
it('keeps corrupt feature metadata unavailable and fenced without aborting desktop composition', async () => {
  mocks.corrupt = true
  const lifecycle: { current: unknown } = { current: undefined }
  const installed: Array<() => void> = []
  const modules = {
    add: async (_input: unknown, factory: (input: unknown) => { capability: unknown }) =>
      factory(_input).capability
  } as unknown as ApplicationModuleBuilder
  const options = {
    settings: {} as SettingsService,
    archive: {},
    sessions: {},
    lifecycle,
    declareElectronAdapter: (_name: string, install: () => void) => installed.push(install)
  } as unknown as Parameters<typeof registerDesktopOptimizationComposition>[1]
  await registerDesktopOptimizationComposition(modules, options)
  const owner = lifecycle.current as {
    hasActiveWork(): boolean
    shutdown(): Promise<{ reaped: boolean }>
    start(request: StartDesktopOptimization): Promise<unknown>
  }
  expect(owner.hasActiveWork()).toBe(true)
  expect(await owner.shutdown()).toEqual({ reaped: false })
  await expect(owner.start(request)).rejects.toThrow('reconciliation')
  installed[0]()
  expect(mocks.register).toHaveBeenCalledWith(owner)
  const captured = mocks.constructed.mock.calls[0][0] as { root: string; executionRoot(): string }
  expect(captured.root).toBe(join(mocks.root, 'config', 'earthnano-desktop'))
  expect(captured.executionRoot()).toBe(join(mocks.root, 'data', 'earthnano', 'desktop-runs'))
})

it('reads private resume metadata under the original current data-root lease and releases it on failure', async () => {
  const modules = {
    add: async (_input: unknown, factory: (input: unknown) => { capability: unknown }) =>
      factory(_input).capability
  } as unknown as ApplicationModuleBuilder
  await registerDesktopOptimizationComposition(modules, {
    settings: {},
    archive: {},
    sessions: {},
    sessionRepository: {},
    lifecycle: { current: undefined },
    declareElectronAdapter: vi.fn()
  } as unknown as Parameters<typeof registerDesktopOptimizationComposition>[1])
  const captured = mocks.constructed.mock.calls[0][0] as {
    readResume(runId: string): Promise<unknown>
  }
  const value = { manifest: 'host-only-fixture', records: [] }
  mocks.readResume.mockImplementationOnce(() => {
    expect(mocks.releaseWriter).not.toHaveBeenCalled()
    return value
  })
  expect(await captured.readResume('original')).toBe(value)
  expect(mocks.readResume).toHaveBeenCalledWith(
    join(mocks.root, 'data', 'earthnano', 'desktop-runs', 'original', 'execution')
  )
  expect(mocks.releaseWriter).toHaveBeenCalledOnce()
  mocks.readResume.mockImplementationOnce(() => {
    throw new Error('Private metadata unavailable')
  })
  await expect(captured.readResume('original')).rejects.toThrow('Private metadata unavailable')
  expect(mocks.releaseWriter).toHaveBeenCalledTimes(2)
})

it('rejects missing or non-absolute Python before owner execution and releases admissions', async () => {
  const deps = dependencies()
  deps.resolvePython.mockRejectedValueOnce(new Error('No compatible Python'))
  await expect(createDesktopOptimizationOptions(request, deps)).rejects.toThrow(
    'No compatible Python'
  )
  expect(mocks.releaseWriter).toHaveBeenCalledOnce()
  deps.resolvePython.mockResolvedValueOnce('python3')
  await expect(createDesktopOptimizationOptions(request, deps)).rejects.toThrow('absolute Python')
  expect(mocks.releaseWriter).toHaveBeenCalledTimes(2)
})

it('pins an executable Python >=3.11 and rejects old interpreters, fallback commands and the macOS stub', async () => {
  const executable = join(mocks.root, 'python3')
  await writeFile(executable, 'synthetic executable, never spawned', { mode: 0o700 })
  const probe = vi.fn().mockResolvedValue('3.11.9')
  const resolve = vi.fn().mockResolvedValue({ command: executable, baseArgs: [] })
  await expect(
    resolveOptimizationPython({ resolve, probe, path: '', platform: 'darwin' })
  ).resolves.toBe(await realpath(executable))
  const accept = resolve.mock.calls[0][0].probe
  probe.mockResolvedValue('3.9.20')
  await expect(accept({ command: executable, baseArgs: [] })).resolves.toBe(false)
  await expect(
    resolveOptimizationPython({ resolve, probe, path: '', platform: 'darwin' })
  ).rejects.toThrow('Python 3.11')
  probe.mockClear().mockResolvedValue('3.12.0')
  await expect(accept({ command: '/usr/bin/python3', baseArgs: [] })).resolves.toBe(false)
  expect(probe).not.toHaveBeenCalled()
  resolve.mockResolvedValue({ command: 'python3', baseArgs: [] })
  await expect(
    resolveOptimizationPython({ resolve, probe, path: '', platform: 'darwin' })
  ).rejects.toThrow('Python 3.11')
})

it('passes explicit method, private checks and experiment domain through original desktop composition', async () => {
  const method = { mode: 'parallel' as const, k: 2, concurrency: 2 }
  const checks = [
    { kind: 'json-value' as const, path: 'result.json', pointer: '', expected: { count: 3 } }
  ]
  const domain = {
    name: 'csv',
    nextTasks: [
      {
        prompt: 'Next CSV',
        files: [{ path: 'data.csv', content: '1\n' }],
        criteria: 'Correct count',
        checks
      }
    ]
  }
  const options = await createDesktopOptimizationOptions(
    { ...request, executionLimit: 36, method, checks, domain },
    dependencies()
  )
  expect(options).toMatchObject({ method, checks, domain, executionLimit: 36 })
  expect(options.input.task).toEqual({ prompt: request.prompt, files: request.files })
  expect(JSON.stringify(options.input)).not.toContain('"expected"')
  options.releaseAdmission()
})

it('keeps original admissions until a failing source-version lease closes, without starting sibling reads', async () => {
  const deps = dependencies(),
    bytes = Buffer.from('fixed source')
  const ref = {
    artifactId: 'artifact',
    versionId: 'version',
    checksum: createHash('sha256').update(bytes).digest('hex'),
    path: 'source.txt'
  }
  let rejectRead!: (error: Error) => void
  const close = vi.fn(async () => {})
  let opened = 0
  const versions = {
    openVersion: vi.fn(
      async () =>
        ({
          logicalFile: { projectId: 'p', sessionId: 's', id: ref.artifactId },
          version: { id: ref.versionId, checksum: ref.checksum },
          size: bytes.length,
          readRange:
            ++opened === 1
              ? async () => bytes
              : () =>
                  new Promise<Uint8Array>((_resolve, reject) => {
                    rejectRead = reject
                  }),
          verifyUnchanged: async () => {},
          close
        }) as unknown as ManagedFileReadLease
    )
  }
  const loadSession = async (): Promise<PersistedChatSession> =>
    ({
      projectId: 'p',
      id: 's',
      artifacts: [
        {
          id: 'version',
          artifactId: ref.artifactId,
          versionId: ref.versionId,
          sha256: ref.checksum
        }
      ]
    }) as PersistedChatSession
  const result = createDesktopOptimizationOptions(
    {
      ...request,
      inputArtifacts: [ref],
      domain: {
        name: 'science',
        nextTasks: [1, 2].map((i) => ({ prompt: `Task ${i}`, criteria: 'Keep source', files: [] }))
      }
    },
    { ...deps, versions, loadSession }
  )
  const rejected = expect(result).rejects.toThrow('read failed')
  await vi.waitFor(() => expect(rejectRead).toBeTypeOf('function'))
  expect(versions.openVersion).toHaveBeenCalledTimes(2)
  expect(mocks.releaseWriter).not.toHaveBeenCalled()
  rejectRead(new Error('read failed'))
  await rejected
  expect(close).toHaveBeenCalledTimes(2)
  expect(close.mock.invocationCallOrder[1]).toBeLessThan(
    mocks.releaseWriter.mock.invocationCallOrder[0]
  )
  expect(deps.admitSessionWork.mock.results[0].value).toHaveBeenCalledOnce()
})

it.each(['python', 'r'] as const)(
  'freezes the same original scientific task, exact upload and enabled %s without accepting renderer runtime paths',
  async (language) => {
    const deps = dependencies()
    const bytes = Buffer.from('sample,value\nA,2\nB,4\nC,6\n')
    const checksum = createHash('sha256').update(bytes).digest('hex')
    const runtime = {
      language,
      runtimeId: '/synthetic/python',
      source: 'external' as const,
      provenance: 'user-own' as const,
      interpreterPath: '/synthetic/python',
      version: '3.12.0'
    }
    const lease = {
      logicalFile: { projectId: 'p', sessionId: 's', id: 'upload', source: 'upload' },
      version: { id: 'v1', checksum, filename: 'measurements.csv' },
      size: bytes.length,
      readRange: vi.fn(async () => bytes),
      verifyUnchanged: vi.fn(async () => {}),
      close: vi.fn(async () => {})
    } as unknown as ManagedFileReadLease
    const session = {
      id: 's',
      projectId: 'p',
      cwd: '/original/workspace',
      messages: [
        {
          id: 'source-prompt',
          role: 'user',
          content: request.prompt,
          status: 'complete',
          uploads: [
            {
              id: 'upload',
              versionId: 'v1',
              sessionId: 's',
              name: 'measurements.csv',
              size: bytes.length,
              sha256: checksum
            }
          ]
        }
      ]
    } as PersistedChatSession
    const notebook = {
      service: {
        listRuntimes: vi.fn(async () => ({
          bindings: { [language]: runtime },
          runtimes: [{ ...runtime, runnable: true, bound: true }]
        }))
      },
      rpc: {},
      mcpEntryPath: '/synthetic/main.js'
    } as unknown as NonNullable<Parameters<typeof createDesktopOptimizationOptions>[1]['notebook']>
    const sourceRequest = {
      ...request,
      files: [],
      notebook: { promptMessageId: 'source-prompt', ...(language === 'r' ? { language } : {}) }
    }
    const sourceDeps = {
      ...deps,
      notebook,
      loadSession: vi.fn(async () => session),
      versions: { openVersion: vi.fn(async () => lease) }
    }
    const options = await createDesktopOptimizationOptions(sourceRequest, sourceDeps)
    expect(options.input.task.prompt).toBe(request.prompt)
    expect(options.input.task.files).toEqual([])
    expect(options.input.task.managedInputs).toMatchObject([
      { inputFileVersionId: 'v1', sourceFileId: 'upload', checksum }
    ])
    expect(options.input.harness.tools).toBe(
      language === 'python' ? 'notebook-python' : 'notebook-r'
    )
    expect(options.input.environment).toMatchObject({
      network: 'provider-and-notebook-policy',
      notebook: { runtime }
    })
    expect(options.ownerOptions.notebook).toBe(notebook)
    expect(notebook.service.listRuntimes).toHaveBeenCalledWith({
      projectId: 'p',
      sessionId: 's',
      workspaceCwd: '/original/workspace'
    })
    expect(lease.close).toHaveBeenCalledOnce()
    options.releaseAdmission()
    vi.mocked(notebook.service.listRuntimes).mockResolvedValueOnce({
      bindings: { [language]: { ...runtime, label: language, status: 'unavailable' } },
      runtimes: []
    })
    await expect(createDesktopOptimizationOptions(sourceRequest, sourceDeps)).rejects.toThrow(
      language === 'r' ? 'enabled R' : 'enabled Python'
    )
    await expect(
      createDesktopOptimizationOptions({ ...sourceRequest, files: request.files }, sourceDeps)
    ).rejects.toThrow('mix')
    await expect(
      createDesktopOptimizationOptions(sourceRequest, {
        ...sourceDeps,
        signal: AbortSignal.abort()
      })
    ).rejects.toThrow()
  }
)

const catalogRequest = (): StartDesktopSweep => ({
  projectId: 'p',
  sourceSessionId: 's',
  requestKey: 'sweep-key',
  executionLimit: 40,
  catalog: ['a', 'b', 'unselected'].map((id) => ({
    taskId: id,
    domain: 'csv',
    sourceSessionId: `source-${id}`,
    source: { kind: 'text', prompt: `Original ${id}`, files: [{ path: `${id}.txt`, content: id }] },
    criteria: `Check ${id}`
  })),
  sweep: {
    modes: ['parallel', 'sequential'],
    k: 1,
    concurrency: 2,
    stream: { seed: null, onlyDomains: [], onlyTasks: ['a', 'b'], maxTasks: null, workers: 1 }
  }
})
const catalogDependencies = (): ReturnType<typeof dependencies> & {
  loadSession: ReturnType<
    typeof vi.fn<(projectId: string, sessionId: string) => Promise<PersistedChatSession>>
  >
} => {
  const deps = dependencies()
  deps.harnessRoot = resolve('vendor/harness2')
  deps.admitSessionWork.mockImplementation(() => vi.fn())
  deps.resolvePython.mockResolvedValue(
    execFileSync(
      process.env.EARTHNANO_RESEARCH_PYTHON ?? 'python3',
      ['-c', 'import sys; print(sys.executable)'],
      { encoding: 'utf8' }
    ).trim()
  )
  return {
    ...deps,
    loadSession: vi.fn(
      async (projectId: string, id: string) =>
        ({ projectId, id, messages: [] }) as unknown as PersistedChatSession
    )
  }
}
it('uses original sweep preview, authorizes only selected independent sources and keeps every admission until cleanup', async () => {
  const deps = catalogDependencies()
  const options = await createDesktopSweepOptions(catalogRequest(), deps)
  expect(options.sweep.plan.domains).toEqual([{ domain: 'csv', taskIds: ['a', 'b'] }])
  expect(deps.validateSession.mock.calls).toEqual([
    ['p', 's'],
    ['p', 'source-a'],
    ['p', 'source-b']
  ])
  expect(deps.loadSession.mock.calls).toEqual([
    ['p', 'source-a'],
    ['p', 'source-b']
  ])
  expect(
    options.sweep.tasks.map((t) => [t.taskId, t.sourceSessionId, t.input.task.prompt])
  ).toEqual([
    ['a', 'source-a', 'Original a'],
    ['b', 'source-b', 'Original b']
  ])
  expect(options.sweep.tasks[0].input.agent).toEqual(options.sweep.tasks[1].input.agent)
  expect(options).not.toHaveProperty('input')
  expect(options).not.toHaveProperty('semanticCriteria')
  expect(JSON.stringify(options.sweep)).not.toContain('synthetic-private-key')
  expect(mocks.releaseWriter).not.toHaveBeenCalled()
  for (const result of deps.admitSessionWork.mock.results)
    expect(result.value).not.toHaveBeenCalled()
  options.releaseAdmission()
  options.releaseAdmission()
  expect(mocks.releaseWriter).toHaveBeenCalledOnce()
  for (const result of deps.admitSessionWork.mock.results)
    expect(result.value).toHaveBeenCalledOnce()
})

it('routes a selected original Compute task to the same owners while leaving text tasks unchanged', async () => {
  const deps = catalogDependencies()
  const request = catalogRequest()
  request.catalog[0].source = { kind: 'compute', promptMessageId: 'compute-source' }
  deps.loadSession.mockImplementation(
    async (projectId, id) =>
      ({
        projectId,
        id,
        messages:
          id === 'source-a'
            ? [
                {
                  id: 'compute-source',
                  role: 'user',
                  status: 'complete',
                  content: 'Original remote calculation'
                }
              ]
            : [],
        enabledComputeHosts: [],
        selectedComputeHosts: []
      }) as unknown as PersistedChatSession
  )
  const notebook = { service: {}, rpc: {}, mcpEntryPath: '/original/entry' } as NonNullable<
    Parameters<typeof createDesktopSweepOptions>[1]['notebook']
  >
  const compute = { hosts: { get: vi.fn() } } as unknown as NonNullable<
    Parameters<typeof createDesktopSweepOptions>[1]['compute']
  >
  const options = await createDesktopSweepOptions(request, { ...deps, notebook, compute })
  expect(options.ownerOptions.notebook).toBe(notebook)
  expect(options.ownerOptions.compute).toBe(compute)
  expect(options.sweep.tasks[0]).toMatchObject({
    taskId: 'a',
    sourcePromptMessageId: 'compute-source',
    input: {
      task: { prompt: 'Original remote calculation', files: [], managedInputs: [] },
      harness: { tools: 'notebook-compute' },
      environment: { compute: { sourceSessionId: 'source-a' } }
    }
  })
  expect(options.sweep.tasks[1].input.harness.tools).toBe('workspace-only')
  expect(options.sweep.tasks[1].input.environment).not.toHaveProperty('compute')
  expect(deps.loadSession).not.toHaveBeenCalledWith('p', 'source-unselected')
  expect(compute.hosts.get).not.toHaveBeenCalled()
  options.releaseAdmission()
  for (const result of deps.admitSessionWork.mock.results)
    expect(result.value).toHaveBeenCalledOnce()
})
it('validates excluded catalog sources before provider capture or admission', async () => {
  const deps = catalogDependencies(),
    request = catalogRequest()
  request.catalog[2].source = {
    kind: 'text',
    prompt: 'Excluded',
    files: [{ path: '../escape', content: 'invalid' }]
  }
  await expect(createDesktopSweepOptions(request, deps)).rejects.toThrow()
  expect(deps.admitSessionWork).not.toHaveBeenCalled()
  expect(deps.settings.captureActiveExplicitAgentBackendTarget).not.toHaveBeenCalled()
})
it('enforces total selected-task execution budget before any source freeze', async () => {
  const deps = catalogDependencies()
  await expect(
    createDesktopSweepOptions({ ...catalogRequest(), executionLimit: 1 }, deps)
  ).rejects.toThrow()
  expect(deps.loadSession).not.toHaveBeenCalled()
  expect(deps.admitSessionWork).toHaveBeenCalledTimes(1)
  expect(deps.admitSessionWork.mock.results[0].value).toHaveBeenCalledOnce()
  expect(mocks.releaseWriter).toHaveBeenCalledOnce()
})
it('rejects an obsolete user-reviewed original plan before reading or admitting catalog sources', async () => {
  const deps = catalogDependencies()
  await expect(
    createDesktopSweepOptions(
      { ...catalogRequest(), previewPlanDigest: 'sha256:' + 'f'.repeat(64) },
      deps
    )
  ).rejects.toThrow('Original task stream changed after preview')
  expect(deps.loadSession).not.toHaveBeenCalled()
  expect(deps.admitSessionWork).toHaveBeenCalledExactlyOnceWith('p', 's')
  expect(deps.admitSessionWork.mock.results[0].value).toHaveBeenCalledOnce()
  expect(mocks.releaseWriter).toHaveBeenCalledOnce()
})
it('freezes exactly the original plan reviewed by the desktop user', async () => {
  const request = catalogRequest(),
    deps = catalogDependencies()
  const preview = await createDesktopSweepPreview(
    {
      projectId: request.projectId,
      sourceSessionId: request.sourceSessionId,
      catalog: request.catalog.map(({ taskId, domain }) => ({ taskId, domain })),
      sweep: request.sweep
    },
    deps
  )
  const options = await createDesktopSweepOptions(
    { ...request, previewPlanDigest: preview.planDigest },
    deps
  )
  expect(options.sweep.plan.digest).toBe(preview.planDigest)
  expect(options.sweep.request.previewPlanDigest).toBe(preview.planDigest)
  options.releaseAdmission()
})
it('releases all selected source admissions on freeze rejection without starting any owner', async () => {
  const deps = catalogDependencies()
  deps.loadSession.mockImplementation(async (projectId, id) => {
    if (id === 'source-b') throw new Error('Original source unavailable')
    return { projectId, id, messages: [] } as unknown as PersistedChatSession
  })
  await expect(createDesktopSweepOptions(catalogRequest(), deps)).rejects.toThrow(
    'Original source unavailable'
  )
  expect(deps.admitSessionWork).toHaveBeenCalledTimes(3)
  for (const result of deps.admitSessionWork.mock.results)
    expect(result.value).toHaveBeenCalledOnce()
  expect(mocks.releaseWriter).toHaveBeenCalledOnce()
})

it('releases every source and the data-root lease even when one original admission release fails', async () => {
  const deps = catalogDependencies()
  const options = await createDesktopSweepOptions(catalogRequest(), deps)
  deps.admitSessionWork.mock.results[1].value.mockImplementation(() => {
    throw new Error('Admission release failed')
  })
  expect(() => options.releaseAdmission()).toThrow('Admission release failed')
  for (const result of deps.admitSessionWork.mock.results)
    expect(result.value).toHaveBeenCalledOnce()
  expect(mocks.releaseWriter).toHaveBeenCalledOnce()
})

const previewRequest = {
  projectId: 'p',
  sourceSessionId: 's',
  catalog: [
    { taskId: 'z2', domain: 'z' },
    { taskId: 'a2', domain: 'a' },
    { taskId: 'z1', domain: 'z' },
    { taskId: 'a1', domain: 'a' }
  ],
  sweep: {
    modes: ['parallel' as const, 'sequential' as const],
    k: 2,
    concurrency: 2,
    stream: {
      seed: null as number | null,
      onlyDomains: [] as string[],
      onlyTasks: [] as string[],
      maxTasks: null as number | null,
      workers: 2
    }
  }
}
it.each([null, 0, -7])(
  'previews original task_stream seed %s without model capture, catalog task source reads or execution',
  async (seed) => {
    const deps = dependencies()
    const loadSession = vi.fn(() => {
      throw new Error('Source body must not be read')
    })
    const versions = {
      openVersion: vi.fn(() => {
        throw new Error('Source file must not be read')
      })
    }
    const dto = {
      ...previewRequest,
      sweep: {
        ...previewRequest.sweep,
        stream: { ...previewRequest.sweep.stream, seed, maxTasks: 1 }
      }
    }
    const python = execFileSync(
      process.env.EARTHNANO_RESEARCH_PYTHON ?? 'python3',
      ['-c', 'import sys; print(sys.executable)'],
      { encoding: 'utf8' }
    ).trim()
    const harnessRoot = resolve('vendor/harness2')
    const host = { ...deps, loadSession, versions, harnessRoot, resolvePython: async () => python }
    const result = await createDesktopSweepPreview(dto, host)
    const { previewOptimizationSweep } = await import('../earthnano/sweep-plan')
    const original = await previewOptimizationSweep({
      catalog: dto.catalog,
      options: dto.sweep,
      python,
      harnessRoot
    })
    expect(result).toEqual({
      planDigest: original.digest,
      order: original.domains,
      modes: ['parallel', 'sequential'],
      minimumExecutions: 66
    })
    expect(result.order).toHaveLength(2)
    expect(result.order.every((row) => row.taskIds.length === 1)).toBe(true)
    expect(deps.settings.captureActiveExplicitAgentBackendTarget).not.toHaveBeenCalled()
    expect(deps.settings.resolveIsolatedClaudeProvider).not.toHaveBeenCalled()
    expect(deps.settings.resolveIsolatedClaudeExecutable).not.toHaveBeenCalled()
    expect(loadSession).not.toHaveBeenCalled()
    expect(versions.openVersion).not.toHaveBeenCalled()
    expect(deps.validateSession).toHaveBeenCalledWith('p', 's')
    expect(deps.admitSessionWork.mock.results[0].value).toHaveBeenCalledOnce()
    expect(mocks.releaseWriter).toHaveBeenCalledOnce()
  }
)
it('applies original domain/task filters and releases navigation leases after preview failure', async () => {
  const deps = dependencies()
  const python = execFileSync(
    process.env.EARTHNANO_RESEARCH_PYTHON ?? 'python3',
    ['-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf8' }
  ).trim()
  const result = await createDesktopSweepPreview(
    {
      ...previewRequest,
      sweep: {
        ...previewRequest.sweep,
        stream: { ...previewRequest.sweep.stream, onlyDomains: ['z'], onlyTasks: ['z2'] }
      }
    },
    { ...deps, harnessRoot: resolve('vendor/harness2'), resolvePython: async () => python }
  )
  expect(result.order).toEqual([{ domain: 'z', taskIds: ['z2'] }])
  expect(result.minimumExecutions).toBe(33)
  deps.validateSession.mockRejectedValueOnce(new Error('wrong project'))
  await expect(createDesktopSweepPreview(previewRequest, deps)).rejects.toThrow('wrong project')
  expect(deps.resolvePython).not.toHaveBeenCalled()
  expect(mocks.releaseWriter).toHaveBeenCalledTimes(2)
  expect(deps.admitSessionWork.mock.results[1].value).toHaveBeenCalledTimes(2)
})
it('does not spawn a preview after cancellation during Python resolution and releases both leases', async () => {
  const deps = dependencies(),
    controller = new AbortController()
  const previewSweep = vi.fn()
  await expect(
    createDesktopSweepPreview(previewRequest, {
      ...deps,
      signal: controller.signal,
      previewSweep,
      resolvePython: async () => {
        controller.abort()
        return '/python'
      }
    })
  ).rejects.toThrow()
  expect(previewSweep).not.toHaveBeenCalled()
  expect(deps.admitSessionWork.mock.results[0].value).toHaveBeenCalledOnce()
  expect(mocks.releaseWriter).toHaveBeenCalledOnce()
})
it('rejects preview bodies, provider settings and malformed catalog metadata before acquiring a lease', async () => {
  const deps = dependencies()
  for (const dto of [
    { ...previewRequest, provider: 'SECRET' },
    { ...previewRequest, catalog: [{ taskId: 'a', domain: 'd', prompt: 'SECRET' }] },
    { ...previewRequest, executionLimit: 512 }
  ])
    await expect(createDesktopSweepPreview(dto, deps)).rejects.toThrow()
  expect(deps.admitSessionWork).not.toHaveBeenCalled()
  expect(deps.resolvePython).not.toHaveBeenCalled()
  expect(mocks.releaseWriter).not.toHaveBeenCalled()
})

it('reaps an already-running original Python preview before releasing navigation leases', async () => {
  // Only this private fixture copy adds a wait at the original CLI entry point; planning,
  // process launch and cancellation use the production helper. No shared sources are changed.
  const harnessRoot = join(mocks.root, 'slow-harness')
  await cp(resolve('vendor/harness2/harness2'), join(harnessRoot, 'harness2'), { recursive: true })
  const entry = join(harnessRoot, 'harness2', 'earthnano_sweep.py'),
    marker = join(mocks.root, 'preview-pid')
  await writeFile(
    entry,
    (await readFile(entry, 'utf8')).replace(
      '    raise SystemExit(main())',
      `    import os, time
    from pathlib import Path
    Path(${JSON.stringify(marker)}).write_text(str(os.getpid()))
    time.sleep(30)
    raise SystemExit(main())`
    )
  )
  const deps = dependencies(),
    controller = new AbortController()
  const python = execFileSync(
    process.env.EARTHNANO_RESEARCH_PYTHON ?? 'python3',
    ['-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf8' }
  ).trim()
  const pending = createDesktopSweepPreview(previewRequest, {
    ...deps,
    harnessRoot,
    signal: controller.signal,
    resolvePython: async () => python
  })
  const rejected = expect(pending).rejects.toThrow('cancelled')
  let pid = 0
  await vi.waitFor(async () => {
    pid = Number(await readFile(marker, 'utf8'))
    expect(pid).toBeGreaterThan(0)
  })
  expect(mocks.releaseWriter).not.toHaveBeenCalled()
  expect(deps.admitSessionWork.mock.results[0].value).not.toHaveBeenCalled()
  controller.abort()
  await rejected
  expect(() => process.kill(pid, 0)).toThrow()
  expect(mocks.releaseWriter).toHaveBeenCalledOnce()
  expect(deps.admitSessionWork.mock.results[0].value).toHaveBeenCalledOnce()
})

it.each(['missing', 'foreign-project', 'archived', 'imported'])(
  'wires preview through original navigation authorization and rejects %s Session before planning',
  async (kind) => {
    const modules = {
      add: async (_input: unknown, factory: (input: unknown) => { capability: unknown }) =>
        factory(_input).capability
    } as unknown as ApplicationModuleBuilder
    const deps = dependencies()
    const session =
      kind === 'missing'
        ? undefined
        : {
            id: 's',
            projectId: kind === 'foreign-project' ? 'other' : 'p',
            ...(kind === 'archived' ? { archivedAt: 1 } : {}),
            ...(kind === 'imported' ? { packageOrigin: {} } : {})
          }
    const sessions = {
      assertSessionAvailable: vi.fn().mockResolvedValue(undefined),
      readSessionSnapshot: vi.fn().mockResolvedValue(session)
    }
    const archive = {
      withProjectAvailable: vi.fn(async (_id: string, operation: () => Promise<void>) =>
        operation()
      ),
      admitSessionWork: deps.admitSessionWork
    }
    await registerDesktopOptimizationComposition(modules, {
      settings: deps.settings,
      archive,
      sessions,
      sessionRepository: {},
      lifecycle: { current: undefined },
      declareElectronAdapter: vi.fn()
    } as unknown as Parameters<typeof registerDesktopOptimizationComposition>[1])
    const captured = mocks.constructed.mock.calls[0][0] as {
      previewSweep: NonNullable<
        import('../earthnano/desktop-optimization-manager').DesktopOptimizationManagerOptions['previewSweep']
      >
    }
    await expect(
      captured.previewSweep(previewRequest, new AbortController().signal)
    ).rejects.toThrow('Source Session is unavailable')
    expect(archive.withProjectAvailable).toHaveBeenCalledWith('p', expect.any(Function))
    expect(sessions.assertSessionAvailable).toHaveBeenCalledWith('p', 's')
    expect(sessions.readSessionSnapshot).toHaveBeenCalledWith('p', 's')
    expect(deps.settings.captureActiveExplicitAgentBackendTarget).not.toHaveBeenCalled()
    expect(deps.admitSessionWork).toHaveBeenCalledWith('p', 's', true)
    expect(deps.admitSessionWork.mock.results[0].value).toHaveBeenCalledOnce()
    expect(mocks.releaseWriter).toHaveBeenCalledOnce()
  }
)

it('passes the original owner registration unchanged through single and sweep options', async () => {
  const onOwnersReady = vi.fn()
  const single = await createDesktopOptimizationOptions(request, {
    ...dependencies(),
    onOwnersReady
  })
  const sweep = await createDesktopSweepOptions(catalogRequest(), {
    ...catalogDependencies(),
    onOwnersReady
  })
  expect(single.onOwnersReady).toBe(onOwnersReady)
  expect(sweep.onOwnersReady).toBe(onOwnersReady)
  expect(onOwnersReady).not.toHaveBeenCalled()
  single.releaseAdmission()
  sweep.releaseAdmission()
})
it('retries retained original owners during desktop teardown without promoting the manager gate', async () => {
  mocks.corrupt = true
  const lifecycle: Parameters<typeof registerDesktopOptimizationComposition>[1]['lifecycle'] = {
    current: undefined
  }
  const candidateOwners = {
    onOwnersReady: vi.fn(),
    resolveCandidateDelivery: vi.fn(),
    resolveControlPolicy: vi.fn(),
    hasActiveWork: vi.fn(() => true),
    shutdown: vi.fn(async () => ({ reaped: true }))
  }
  const modules = {
    add: async (_input: unknown, factory: (input: unknown) => { capability: unknown }) =>
      factory(_input).capability
  } as unknown as ApplicationModuleBuilder
  await registerDesktopOptimizationComposition(modules, {
    settings: {},
    archive: {},
    sessions: {},
    sessionRepository: {},
    lifecycle,
    candidateOwners,
    declareElectronAdapter: vi.fn()
  } as unknown as Parameters<typeof registerDesktopOptimizationComposition>[1])
  expect(await lifecycle.current!.shutdown()).toEqual({ reaped: false })
  expect(await lifecycle.current!.prepareForUpdateGate()).toEqual({ reaped: false })
  expect(candidateOwners.shutdown).toHaveBeenCalledTimes(2)
  expect(lifecycle.current!.hasActiveWork()).toBe(true)
})

it('uses an explicit supported-platform dependency view for platform-independent composition', async () => {
  const deps = dependencies()
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const options = await createDesktopOptimizationOptions(request, deps)
  expect(options.input.task).toEqual({ prompt: request.prompt, files: request.files })
  expect(options.input.agent.runtimeVersion).toBe('2.1.232')
  options.releaseAdmission()
})

it('keeps the default Windows runtime refusal before provider, version and Python admission', async () => {
  const deps = { ...dependencies(), platform: undefined }
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  await expect(createDesktopOptimizationOptions(request, deps)).rejects.toThrow(
    'Optimization requires a supported Claude Code runtime.'
  )
  expect(deps.settings.resolveIsolatedClaudeProvider).not.toHaveBeenCalled()
  expect(deps.settings.resolveIsolatedClaudeExecutable).not.toHaveBeenCalled()
  expect(deps.probeClaudeVersion).not.toHaveBeenCalled()
  expect(deps.resolvePython).not.toHaveBeenCalled()
  expect(mocks.releaseWriter).toHaveBeenCalledOnce()
  expect(deps.admitSessionWork.mock.results[0].value).toHaveBeenCalledOnce()
})
