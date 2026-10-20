import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolvePythonCommand, probeInterpreterVersion } from '@aipoch/environment'
import { delimiter, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  DesktopOptimizationApi,
  StartDesktopOptimization
} from '../../shared/earthnano/desktop-optimization'
import {
  DesktopOptimizationManager,
  DesktopOptimizationSetupError
} from '../earthnano/desktop-optimization-manager'
import type { PersistentOptimizationOptions } from '../earthnano/run-persistent-optimization'
import type { SettingsService } from '../settings/service'
import type { ArchiveCoordinator } from '../archive/coordinator'
import type { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import type { ApplicationModuleBuilder } from '../application-runtime'
import { BackendShutdownOutcomeError, QUIT_SHUTDOWN_BUDGET_MS } from '../lifecycle-shutdown'
import {
  acquireDataRootWriter,
  isMigrationInProgress,
  isMigrationPending
} from '../storage/migration-state'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import { getProjectDbClient } from '../projects/prisma-client'
import { runtimeMetadata } from '../runtime-metadata'
import { registerDesktopOptimizationIpcHandlers } from '../desktop-surface-declarations'

export type DesktopOptimizationLifecycle = Pick<
  DesktopOptimizationManager,
  'hasActiveWork' | 'shutdown' | 'prepareForUpdateGate' | 'releaseUpdateGate'
>

/** Resolve once to an absolute executable; the generic notebook resolver's bare-command fallback
 * is intentionally insufficient for this Python >=3.11 application dependency. */
export async function resolveOptimizationPython(
  dependencies: {
    resolve?: typeof resolvePythonCommand
    probe?: typeof probeInterpreterVersion
    path?: string
    platform?: NodeJS.Platform
  } = {}
): Promise<string> {
  const acceptable = async (command: string, baseArgs: string[] = []): Promise<boolean> => {
    if ((dependencies.platform ?? process.platform) === 'darwin' && command === '/usr/bin/python3')
      return false
    const version = await (dependencies.probe ?? probeInterpreterVersion)(command, baseArgs)
    const parts = version?.match(/^(\d+)\.(\d+)/)
    return !!parts && (+parts[1] > 3 || (+parts[1] === 3 && +parts[2] >= 11))
  }
  const selected = await (dependencies.resolve ?? resolvePythonCommand)({
    platform: dependencies.platform ?? process.platform,
    probe: ({ command, baseArgs }) => acceptable(command, baseArgs)
  })
  if (selected.baseArgs.length) throw new Error('Unsupported Python launcher')
  const candidates = isAbsolute(selected.command)
    ? [selected.command]
    : (dependencies.path ?? process.env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, selected.command))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      const executable = await realpath(candidate)
      if (isAbsolute(executable) && (await acceptable(executable))) return executable
    } catch {
      /* Continue searching explicit executable candidates. */
    }
  }
  throw new DesktopOptimizationSetupError(
    'Optimization requires Python 3.11 or newer. Check the selected model and runtime settings.'
  )
}

/** Uses explicit current identity and the existing key resolver without provisioning host Claude settings. */
export async function createDesktopOptimizationOptions(
  request: StartDesktopOptimization,
  dependencies: {
    settings: Pick<
      SettingsService,
      | 'captureActiveExplicitAgentBackendTarget'
      | 'resolveIsolatedClaudeProvider'
      | 'resolveIsolatedClaudeExecutable'
    >
    validateSession(projectId: string, sessionId: string): Promise<void>
    admitSessionWork(projectId: string, sessionId: string): () => void
    harnessRoot: string
    resolvePython?: () => Promise<string>
  }
): Promise<PersistentOptimizationOptions & { releaseAdmission(): void }> {
  const releaseWriter = acquireDataRootWriter()
  let releaseSession: (() => void) | undefined
  try {
    releaseSession = dependencies.admitSessionWork(request.projectId, request.sourceSessionId)
    await dependencies.validateSession(request.projectId, request.sourceSessionId)
    const target = await dependencies.settings.captureActiveExplicitAgentBackendTarget()
    if (process.platform === 'win32' || target.frameworkId !== 'claude-code')
      throw new DesktopOptimizationSetupError(
        'Optimization requires a supported Claude Code runtime. Check the selected model and runtime settings.'
      )
    const selected = await dependencies.settings.resolveIsolatedClaudeProvider(target)
    const provider = selected.provider
    if (
      provider.type !== 'custom' ||
      !provider.apiEndpoints?.includes('messages') ||
      !provider.model ||
      !provider.key ||
      !provider.baseUrl
    )
      throw new DesktopOptimizationSetupError(
        'Optimization requires an explicit custom messages provider. Check the selected model and runtime settings.'
      )
    const executablePath = await dependencies.settings.resolveIsolatedClaudeExecutable()
    await access(dependencies.harnessRoot)
    const python = await (dependencies.resolvePython ?? resolveOptimizationPython)()
    if (!isAbsolute(python))
      throw new DesktopOptimizationSetupError(
        'Optimization requires an absolute Python 3.11 executable. Check the selected model and runtime settings.'
      )
    const dataRoot = resolveDataRoot(),
      configRoot = resolveConfigRoot()
    const providerRef = `desktop-provider:${selected.providerId}`
    let released = false
    const releaseAdmission = (): void => {
      if (released) return
      released = true
      releaseSession?.()
      releaseWriter()
    }
    return {
      projectId: request.projectId,
      taskId: `desktop-task-${randomUUID()}`,
      workRoot: join(dataRoot, 'earthnano', 'runs', randomUUID()),
      harnessRoot: dependencies.harnessRoot,
      python,
      executionLimit: request.executionLimit,
      semanticCriteria: request.criteria,
      ownerOptions: { dataRoot, configRoot, getClient: () => getProjectDbClient(configRoot) },
      input: {
        task: { prompt: request.prompt, files: structuredClone(request.files) },
        harness: {
          instructions:
            'Read the frozen task inputs carefully. Follow the task requirements, verify the deliverables and write the requested files under OUTPUT.',
          skills: [],
          tools: 'workspace-only'
        },
        agent: {
          backend: 'claude-code',
          model: provider.model,
          providerRef,
          runtimeVersion: '2.1.232'
        },
        environment: { isolation: 'directory-process', network: 'provider-only' }
      },
      binding: async (agent) => {
        const current = await dependencies.settings.resolveIsolatedClaudeProvider(target)
        if (
          current.providerId !== selected.providerId ||
          current.provider.type !== 'custom' ||
          current.provider.model !== agent.model ||
          current.provider.baseUrl !== provider.baseUrl ||
          !current.provider.apiEndpoints?.includes('messages') ||
          agent.providerRef !== providerRef ||
          agent.runtimeVersion !== '2.1.232'
        )
          throw new Error('Optimization provider changed')
        return {
          executablePath,
          runtimeVersion: '2.1.232',
          providerRef,
          provider: current.provider
        }
      },
      releaseAdmission
    }
  } catch (error) {
    releaseSession?.()
    releaseWriter()
    throw error
  }
}

export async function registerDesktopOptimizationComposition(
  modules: ApplicationModuleBuilder,
  options: {
    settings: SettingsService
    archive: ArchiveCoordinator
    sessions: SessionPersistenceCoordinator
    lifecycle: { current: DesktopOptimizationLifecycle | undefined }
    declareElectronAdapter(name: string, install: () => void): void
  }
): Promise<DesktopOptimizationApi> {
  const validateSession = async (projectId: string, sessionId: string): Promise<void> => {
    if (isMigrationInProgress() || isMigrationPending()) throw new Error('Data root is moving')
    await options.archive.withProjectAvailable(projectId, async () => {
      await options.sessions.assertSessionAvailable(projectId, sessionId)
      const session = await options.sessions.readSessionSnapshot(projectId, sessionId)
      if (
        !session ||
        session.projectId !== projectId ||
        session.archivedAt ||
        session.packageOrigin
      )
        throw new Error('Source Session is unavailable')
    })
  }
  const manager = await modules.add({}, () => {
    let manager: DesktopOptimizationApi & DesktopOptimizationLifecycle
    try {
      manager = new DesktopOptimizationManager({
        root: join(resolveConfigRoot(), 'earthnano-desktop'),
        executionRoot: () => join(resolveDataRoot(), 'earthnano', 'desktop-runs'),
        validateSession,
        createOptions: (request) =>
          createDesktopOptimizationOptions(request, {
            settings: options.settings,
            validateSession,
            admitSessionWork: (projectId, sessionId) =>
              options.archive.admitSessionWork(projectId, sessionId, true),
            harnessRoot: runtimeMetadata().packaged
              ? join(runtimeMetadata().resourcesPath, 'earthnano', 'harness2')
              : join(runtimeMetadata().applicationPath, 'vendor', 'harness2')
          })
      })
    } catch {
      const unavailable = async (): Promise<never> => {
        throw new Error('Optimization history requires reconciliation')
      }
      manager = {
        start: unavailable,
        get: unavailable,
        latest: unavailable,
        stop: unavailable,
        hasActiveWork: () => true,
        shutdown: async () => ({ reaped: false }),
        prepareForUpdateGate: async () => ({ reaped: false }),
        releaseUpdateGate: () => undefined
      }
    }
    options.lifecycle.current = manager
    return {
      name: 'desktop-optimization',
      capability: manager,
      disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS,
      dispose: async () => {
        if (!(await manager.shutdown()).reaped) throw new BackendShutdownOutcomeError('degraded')
      }
    }
  })
  options.declareElectronAdapter('desktop-optimization', () =>
    registerDesktopOptimizationIpcHandlers(manager)
  )
  return manager
}
