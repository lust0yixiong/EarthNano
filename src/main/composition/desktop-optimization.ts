import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  DesktopOptimizationApi,
  StartDesktopOptimization
} from '../../shared/earthnano/desktop-optimization'
import { DesktopOptimizationManager } from '../earthnano/desktop-optimization-manager'
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
  }
): Promise<PersistentOptimizationOptions & { releaseAdmission(): void }> {
  const releaseWriter = acquireDataRootWriter()
  let releaseSession: (() => void) | undefined
  try {
    releaseSession = dependencies.admitSessionWork(request.projectId, request.sourceSessionId)
    await dependencies.validateSession(request.projectId, request.sourceSessionId)
    const target = await dependencies.settings.captureActiveExplicitAgentBackendTarget()
    if (process.platform === 'win32' || target.frameworkId !== 'claude-code')
      throw new Error('Optimization requires a supported Claude Code runtime')
    const selected = await dependencies.settings.resolveIsolatedClaudeProvider(target)
    const provider = selected.provider
    if (
      provider.type !== 'custom' ||
      !provider.apiEndpoints?.includes('messages') ||
      !provider.model ||
      !provider.key ||
      !provider.baseUrl
    )
      throw new Error('Optimization requires an explicit custom messages provider')
    const executablePath = await dependencies.settings.resolveIsolatedClaudeExecutable()
    await access(dependencies.harnessRoot)
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
): Promise<void> {
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
}
