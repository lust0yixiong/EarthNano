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
  DesktopOptimizationSetupError,
  readDesktopOptimizationResume
} from '../earthnano/desktop-optimization-manager'
import type { PersistentOptimizationOptions } from '../earthnano/run-persistent-optimization'
import type { SettingsService } from '../settings/service'
import { createDefaultDetectDeps } from '../settings/claude-detect'
import { isSupportedClaudeCliVersion } from '../../shared/claude-runtime'
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
import { normalizeOptimizationArtifactInputs } from '../../shared/earthnano/optimization-input'
import { normalizeNotebookOptimizationSource } from '../../shared/earthnano/notebook-source'
import { normalizeFrozenNotebookRuntime } from '../../shared/earthnano/notebook-profile'
import { resolveOptimizationNotebookInputs } from '../earthnano/optimization-notebook-input'
import type { PersistentCandidateNotebookOptions } from '../earthnano/persistent-candidate-owner'
import { resolveOptimizationArtifactInputs } from '../earthnano/optimization-input'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import type { ManagedFileVersionReadPort } from '../managed-file-versions/read-port'
import type { PersistedChatSession } from '../../shared/session-persistence'

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
    probeClaudeVersion?: (executablePath: string) => Promise<string | undefined>
    loadSession?: (projectId: string, sessionId: string) => Promise<PersistedChatSession>
    versions?: Pick<ManagedFileVersionReadPort, 'openVersion'>
    notebook?: PersistentCandidateNotebookOptions
    signal?: AbortSignal
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
    const runtimeVersion = await (
      dependencies.probeClaudeVersion ?? createDefaultDetectDeps().getVersion
    )(executablePath)
    if (!runtimeVersion || !isSupportedClaudeCliVersion(runtimeVersion))
      throw new DesktopOptimizationSetupError(
        'Optimization requires a supported Claude Code runtime. Check the selected model and runtime settings.'
      )
    await access(dependencies.harnessRoot)
    const python = await (dependencies.resolvePython ?? resolveOptimizationPython)()
    if (!isAbsolute(python))
      throw new DesktopOptimizationSetupError(
        'Optimization requires an absolute Python 3.11 executable. Check the selected model and runtime settings.'
      )
    const dataRoot = resolveDataRoot(),
      configRoot = resolveConfigRoot()
    dependencies.signal?.throwIfAborted()
    const notebookSource = normalizeNotebookOptimizationSource(request.notebook)
    if (
      notebookSource &&
      (request.files.length || request.inputArtifacts?.length || request.domain)
    )
      throw new Error('Notebook task cannot mix alternate inputs')
    const versions =
      dependencies.versions ??
      new ManagedFileVersionService({
        storageRoot: dataRoot,
        getClient: () => getProjectDbClient(configRoot)
      })
    let scientific:
      | {
          managedInputs: Awaited<ReturnType<typeof resolveOptimizationNotebookInputs>>
          runtime: ReturnType<typeof normalizeFrozenNotebookRuntime>
        }
      | undefined
    if (notebookSource) {
      if (!dependencies.notebook || !dependencies.loadSession)
        throw new DesktopOptimizationSetupError(
          'Notebook task requires the original enabled Python runtime and fixed source inputs.'
        )
      const source = await dependencies.loadSession(request.projectId, request.sourceSessionId)
      const managedInputs = await resolveOptimizationNotebookInputs({
        projectId: request.projectId,
        sourceSessionId: request.sourceSessionId,
        source: notebookSource,
        prompt: request.prompt,
        loadSession: async () => source,
        versions,
        signal: dependencies.signal
      })
      const listing = await dependencies.notebook.service.listRuntimes({
        projectId: request.projectId,
        sessionId: source.id,
        workspaceCwd: source.cwd ?? ''
      })
      const bound = listing.bindings.python
      const enabled =
        bound &&
        listing.runtimes.find(
          (runtime) =>
            runtime.language === 'python' &&
            runtime.runtimeId === bound.runtimeId &&
            runtime.runnable &&
            (runtime.status ?? 'active') === 'active'
        )
      if (!enabled || !bound || (bound.status ?? 'active') !== 'active')
        throw new DesktopOptimizationSetupError(
          'Notebook task requires the original enabled Python runtime and fixed source inputs.'
        )
      const runtime = normalizeFrozenNotebookRuntime({
        language: bound.language,
        runtimeId: bound.runtimeId,
        source: bound.source,
        provenance: bound.provenance,
        interpreterPath: bound.interpreterPath,
        ...(bound.version ? { version: bound.version } : {})
      })
      dependencies.signal?.throwIfAborted()
      scientific = { managedInputs, runtime }
    }
    const inputArtifacts = normalizeOptimizationArtifactInputs(request.inputArtifacts)
    const resolveFiles = async (
      files: Array<{ path: string; content: string }>
    ): Promise<typeof files> => {
      if (!inputArtifacts?.length) return structuredClone(files)
      if (!dependencies.loadSession) throw new Error('Original Session reader unavailable')
      return resolveOptimizationArtifactInputs({
        projectId: request.projectId,
        sourceSessionId: request.sourceSessionId,
        artifacts: inputArtifacts,
        files,
        loadSession: () => dependencies.loadSession!(request.projectId, request.sourceSessionId),
        versions:
          dependencies.versions ??
          new ManagedFileVersionService({
            storageRoot: dataRoot,
            getClient: () => getProjectDbClient(configRoot)
          })
      })
    }
    const files = await resolveFiles(request.files)
    const domain = request.domain ? structuredClone(request.domain) : undefined
    // Do not release the original data-root writer on one rejection while sibling version leases
    // are still reading. At most three successor tasks are frozen under this same owner.
    for (const task of domain?.nextTasks ?? []) task.files = await resolveFiles(task.files)
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
      sourceSessionId: request.sourceSessionId,
      ...(notebookSource ? { sourcePromptMessageId: notebookSource.promptMessageId } : {}),
      taskId: `desktop-task-${randomUUID()}`,
      workRoot: join(dataRoot, 'earthnano', 'runs', randomUUID()),
      harnessRoot: dependencies.harnessRoot,
      python,
      executionLimit: request.executionLimit,
      semanticCriteria: request.criteria,
      ...(request.method === undefined ? {} : { method: structuredClone(request.method) }),
      ...(request.checks === undefined ? {} : { checks: structuredClone(request.checks) }),
      ...(domain === undefined ? {} : { domain }),
      ...(inputArtifacts?.length ? { inputArtifacts } : {}),
      ownerOptions: {
        dataRoot,
        configRoot,
        getClient: () => getProjectDbClient(configRoot),
        ...(scientific ? { notebook: dependencies.notebook } : {})
      },
      input: {
        task: {
          prompt: request.prompt,
          files,
          ...(scientific ? { managedInputs: scientific.managedInputs } : {})
        },
        harness: {
          instructions:
            'Read the frozen task inputs carefully. Follow the task requirements, verify the deliverables and write the requested files under OUTPUT.',
          skills: [],
          tools: scientific ? 'notebook-python' : 'workspace-only'
        },
        agent: {
          backend: 'claude-code',
          model: provider.model,
          providerRef,
          runtimeVersion
        },
        environment: {
          isolation: 'directory-process',
          network: scientific ? 'provider-and-notebook-policy' : 'provider-only',
          ...(scientific ? { notebook: { runtime: scientific.runtime } } : {})
        }
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
          agent.runtimeVersion !== runtimeVersion
        )
          throw new Error('Optimization provider changed')
        return {
          executablePath,
          runtimeVersion,
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
    notebook?: PersistentCandidateNotebookOptions
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
        readResume: async (runId) => {
          const releaseWriter = acquireDataRootWriter()
          try {
            return readDesktopOptimizationResume(
              join(resolveDataRoot(), 'earthnano', 'desktop-runs', runId, 'execution')
            )
          } finally {
            releaseWriter()
          }
        },
        validateSession,
        createOptions: (request, signal) =>
          createDesktopOptimizationOptions(request, {
            settings: options.settings,
            notebook: options.notebook,
            signal,
            validateSession,
            admitSessionWork: (projectId, sessionId) =>
              options.archive.admitSessionWork(projectId, sessionId, true),
            loadSession: async (projectId, sessionId) => {
              const session = await options.sessions.readSessionSnapshot(projectId, sessionId)
              if (!session) throw new Error('Original Session unavailable')
              return session
            },
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
        resume: unavailable,
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
