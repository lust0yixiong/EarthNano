import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
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
    get = vi.fn()
    latest = vi.fn()
    stop = vi.fn()
  }
}))
import {
  createDesktopOptimizationOptions,
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
  settings: {
    captureActiveExplicitAgentBackendTarget: vi.fn().mockResolvedValue(target),
    resolveIsolatedClaudeProvider: vi.fn().mockResolvedValue(selected()),
    resolveIsolatedClaudeExecutable: vi.fn().mockResolvedValue('/synthetic/claude')
  },
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
  const executable = join(mocks.root, 'claude')
  await writeFile(executable, '#!/bin/sh\nprintf "2.1.250 (Claude Code)\\n"\n', { mode: 0o700 })
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
