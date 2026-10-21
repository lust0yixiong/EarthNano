import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolvePythonCommand, probeInterpreterVersion } from '@aipoch/environment'
import { delimiter, isAbsolute, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type {
  DesktopOptimizationApi,
  StartDesktopOptimization
} from '../../shared/earthnano/desktop-optimization'
import {
  DesktopOptimizationManager,
  DesktopOptimizationSetupError,
  readDesktopOptimizationResume
} from '../earthnano/desktop-optimization-manager'
import type {
  PersistentOptimizationOptions,
  PersistentSingleOptimizationOptions,
  PersistentSweepOptimizationOptions
} from '../earthnano/run-persistent-optimization'
import type { SettingsService } from '../settings/service'
import { createDefaultDetectDeps } from '../settings/claude-detect'
import { isSupportedClaudeCliVersion } from '../../shared/claude-runtime'
import type { ArchiveCoordinator } from '../archive/coordinator'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import type { SessionRepository } from '../session-persistence/repository'
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
import {
  normalizeNotebookOptimizationSource,
  notebookOptimizationLanguage
} from '../../shared/earthnano/notebook-source'
import {
  normalizeFrozenNotebookRuntime,
  notebookToolsForLanguage,
  notebookLanguageForTools
} from '../../shared/earthnano/notebook-profile'
import {
  resolveOptimizationNotebookInputs,
  resolveOptimizationNotebookRuntime
} from '../earthnano/optimization-notebook-input'
import type {
  PersistentCandidateNotebookOptions,
  PersistentCandidateOwnersOptions
} from '../earthnano/persistent-candidate-owner'
import { resolveOptimizationArtifactInputs } from '../earthnano/optimization-input'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import type { ManagedFileVersionReadPort } from '../managed-file-versions/read-port'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  assertSweepExecutionLimit,
  normalizeDesktopSweepPreview,
  minimumSweepExecutions,
  type PreviewDesktopSweep,
  type DesktopSweepPreview,
  type StartDesktopSweep
} from '../../shared/earthnano/optimization-sweep'
import { normalizeDesktopSweep } from '../earthnano/desktop-sweep-validation'
import { previewOptimizationSweep } from '../earthnano/sweep-plan'
import { resolveDesktopSweepTask } from '../earthnano/desktop-sweep-sources'
import type { ResolvedSweepTask } from '../earthnano/sweep-contract'

const providerRevision = (
  providerId: string,
  provider: {
    type: string
    model?: string
    baseUrl?: string
    apiEndpoints?: readonly string[]
  }
): string =>
  `desktop-provider:${providerId}:${createHash('sha256')
    .update(
      JSON.stringify({
        type: provider.type,
        model: provider.model,
        baseUrl: provider.baseUrl,
        apiEndpoints: [...(provider.apiEndpoints ?? [])].sort()
      })
    )
    .digest('hex')}`

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

export interface DesktopOptimizationDependencies {
  settings: Pick<
    SettingsService,
    | 'getStoredSettings'
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
  sessionPersistence?: PersistentCandidateOwnersOptions['sessionPersistence']
  signal?: AbortSignal
  /** Pure original task_stream preview; injected only by host tests. */
  previewSweep?: typeof previewOptimizationSweep
}

interface DesktopOptimizationRuntime {
  python: string
  agent: import('../earthnano/candidate-snapshot').CandidateSnapshotInput['agent']
  binding: PersistentOptimizationOptions['binding']
}
async function captureDesktopOptimizationRuntime(
  dependencies: DesktopOptimizationDependencies
): Promise<DesktopOptimizationRuntime> {
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
  const providerRef = providerRevision(selected.providerId, provider)
  return {
    python,
    agent: { backend: 'claude-code', model: provider.model, providerRef, runtimeVersion },
    binding: async (agent) => {
      const current = await dependencies.settings.resolveIsolatedClaudeProvider(target)
      if (
        current.providerId !== selected.providerId ||
        current.provider.type !== 'custom' ||
        current.provider.model !== agent.model ||
        current.provider.baseUrl !== provider.baseUrl ||
        providerRevision(current.providerId, current.provider) !== providerRef ||
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
    }
  }
}

/** Uses explicit current identity and the existing key resolver without provisioning host Claude settings. */
export async function createDesktopOptimizationOptions(
  request: StartDesktopOptimization,
  dependencies: DesktopOptimizationDependencies
): Promise<PersistentSingleOptimizationOptions & { releaseAdmission(): void }> {
  const releaseWriter = acquireDataRootWriter()
  let releaseSession: (() => void) | undefined
  try {
    releaseSession = dependencies.admitSessionWork(request.projectId, request.sourceSessionId)
    await dependencies.validateSession(request.projectId, request.sourceSessionId)
    const runtime = await captureDesktopOptimizationRuntime(dependencies)
    const { python } = runtime
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
      const language = notebookOptimizationLanguage(notebookSource)
      if (!dependencies.notebook || !dependencies.loadSession)
        throw new DesktopOptimizationSetupError(
          `Notebook task requires the original enabled ${language === 'r' ? 'R' : 'Python'} runtime and fixed source inputs.`
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
      const runtime = await resolveOptimizationNotebookRuntime({
        service: dependencies.notebook.service,
        projectId: request.projectId,
        source,
        language,
        signal: dependencies.signal
      })
      if (!runtime)
        throw new DesktopOptimizationSetupError(
          `Notebook task requires the original enabled ${language === 'r' ? 'R' : 'Python'} runtime and fixed source inputs.`
        )
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
        settings: { getSettings: () => dependencies.settings.getStoredSettings() },
        sessionPersistence: requireSessionPersistence(dependencies),
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
          tools: scientific
            ? notebookToolsForLanguage(scientific.runtime.language)
            : 'workspace-only'
        },
        agent: runtime.agent,
        environment: {
          isolation: 'directory-process',
          network: scientific ? 'provider-and-notebook-policy' : 'provider-only',
          ...(scientific ? { notebook: { runtime: scientific.runtime } } : {})
        }
      },
      binding: runtime.binding,
      releaseAdmission
    }
  } catch (error) {
    releaseSession?.()
    releaseWriter()
    throw error
  }
}

/** Read-only original task_stream, authorized by the navigation Session. No provider or source
 * catalog task source reader exists in this dependency surface. Navigation authorization keeps
 * the original Session owner checks (which may read its snapshot). Lifetime leases cover cleanup. */
export async function createDesktopSweepPreview(
  value: PreviewDesktopSweep,
  dependencies: Pick<
    DesktopOptimizationDependencies,
    | 'validateSession'
    | 'admitSessionWork'
    | 'harnessRoot'
    | 'resolvePython'
    | 'previewSweep'
    | 'signal'
  >
): Promise<DesktopSweepPreview> {
  const request = normalizeDesktopSweepPreview(value)
  dependencies.signal?.throwIfAborted()
  const releaseWriter = acquireDataRootWriter()
  let releaseSession: (() => void) | undefined
  try {
    releaseSession = dependencies.admitSessionWork(request.projectId, request.sourceSessionId)
    await dependencies.validateSession(request.projectId, request.sourceSessionId)
    dependencies.signal?.throwIfAborted()
    const python = await (dependencies.resolvePython ?? resolveOptimizationPython)()
    dependencies.signal?.throwIfAborted()
    const plan = await (dependencies.previewSweep ?? previewOptimizationSweep)({
      catalog: request.catalog,
      options: request.sweep,
      python,
      harnessRoot: dependencies.harnessRoot,
      signal: dependencies.signal
    })
    dependencies.signal?.throwIfAborted()
    const selectedCount = plan.domains.reduce((count, domain) => count + domain.taskIds.length, 0)
    return {
      planDigest: plan.digest,
      order: plan.domains,
      modes: plan.options.modes,
      minimumExecutions: selectedCount ? minimumSweepExecutions(plan.options, selectedCount) : 0
    }
  } finally {
    try {
      releaseSession?.()
    } finally {
      releaseWriter()
    }
  }
}

/** One explicit sweep, original shared provider and independently authorized selected sources. */
export async function createDesktopSweepOptions(
  value: StartDesktopSweep,
  dependencies: DesktopOptimizationDependencies
): Promise<PersistentSweepOptimizationOptions & { releaseAdmission(): void }> {
  const request = normalizeDesktopSweep(value)
  const releaseWriter = acquireDataRootWriter()
  const releases = new Map<string, () => void>()
  let released = false
  const releaseAdmission = (): void => {
    if (released) return
    released = true
    let failure: unknown
    for (const release of [...releases.values()].reverse()) {
      try {
        release()
      } catch (error) {
        failure ??= error
      }
    }
    try {
      releaseWriter()
    } catch (error) {
      failure ??= error
    }
    if (failure) throw failure
  }
  const authorize = async (sessionId: string): Promise<void> => {
    if (!releases.has(sessionId))
      releases.set(sessionId, dependencies.admitSessionWork(request.projectId, sessionId))
    await dependencies.validateSession(request.projectId, sessionId)
    dependencies.signal?.throwIfAborted()
  }
  try {
    await authorize(request.sourceSessionId)
    const runtime = await captureDesktopOptimizationRuntime(dependencies)
    const plan = await (dependencies.previewSweep ?? previewOptimizationSweep)({
      catalog: request.catalog.map(({ taskId, domain }) => ({ taskId, domain })),
      options: request.sweep,
      python: runtime.python,
      harnessRoot: dependencies.harnessRoot,
      signal: dependencies.signal
    })
    if (request.previewPlanDigest !== undefined && request.previewPlanDigest !== plan.digest)
      throw new Error('Original task stream changed after preview')
    const ids = plan.domains.flatMap((domain) => domain.taskIds)
    assertSweepExecutionLimit(request.sweep, ids.length, request.executionLimit)
    const selected = ids.map((id) => {
      const task = request.catalog.find((task) => task.taskId === id)
      if (!task) throw new Error('Original sweep selected an unknown catalog task')
      return task
    })
    for (const sourceId of [...new Set(selected.map((task) => task.sourceSessionId))].sort())
      await authorize(sourceId)
    if (!dependencies.loadSession) throw new Error('Original source Session reader unavailable')
    const dataRoot = resolveDataRoot(),
      configRoot = resolveConfigRoot()
    const versions =
      dependencies.versions ??
      new ManagedFileVersionService({
        storageRoot: dataRoot,
        getClient: () => getProjectDbClient(configRoot)
      })
    const tasks: ResolvedSweepTask[] = []
    for (const task of selected)
      tasks.push(
        await resolveDesktopSweepTask({
          projectId: request.projectId,
          task,
          agent: runtime.agent,
          harness: {
            instructions:
              'Read the frozen task inputs carefully. Follow the task requirements, verify the deliverables and write the requested files under OUTPUT.',
            skills: []
          },
          loadSession: dependencies.loadSession,
          versions,
          notebook: dependencies.notebook,
          signal: dependencies.signal
        })
      )
    dependencies.signal?.throwIfAborted()
    return {
      projectId: request.projectId,
      sourceSessionId: request.sourceSessionId,
      taskId: `desktop-sweep-${randomUUID()}`,
      workRoot: join(dataRoot, 'earthnano', 'runs', randomUUID()),
      harnessRoot: dependencies.harnessRoot,
      python: runtime.python,
      executionLimit: request.executionLimit,
      sweep: { plan, tasks, request },
      ownerOptions: {
        dataRoot,
        configRoot,
        getClient: () => getProjectDbClient(configRoot),
        settings: { getSettings: () => dependencies.settings.getStoredSettings() },
        sessionPersistence: requireSessionPersistence(dependencies),
        ...(tasks.some((task) => notebookLanguageForTools(task.input.harness.tools) !== undefined)
          ? { notebook: dependencies.notebook }
          : {})
      },
      binding: runtime.binding,
      releaseAdmission
    }
  } catch (error) {
    releaseAdmission()
    throw error
  }
}

function requireSessionPersistence(
  dependencies: DesktopOptimizationDependencies
): NonNullable<DesktopOptimizationDependencies['sessionPersistence']> {
  if (!dependencies.sessionPersistence)
    throw new Error('Original Session persistence authority is required')
  return dependencies.sessionPersistence
}

export async function registerDesktopOptimizationComposition(
  modules: ApplicationModuleBuilder,
  options: {
    settings: SettingsService
    archive: ArchiveCoordinator
    sessions: Pick<
      SessionPersistenceCommands,
      | 'mutateRuntimeSession'
      | 'assertSessionAvailable'
      | 'saveSession'
      | 'admitTaskTurn'
      | 'readSessionSnapshot'
    >
    sessionRepository: SessionRepository
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
      const dependencies = (signal?: AbortSignal): DesktopOptimizationDependencies => ({
        settings: options.settings,
        notebook: options.notebook,
        sessionPersistence: {
          repository: options.sessionRepository,
          coordinator: options.sessions
        },
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
          createDesktopOptimizationOptions(request, dependencies(signal)),
        previewSweep: (request, signal) => createDesktopSweepPreview(request, dependencies(signal)),
        createSweepOptions: (request, signal) =>
          createDesktopSweepOptions(request, dependencies(signal))
      })
    } catch {
      const unavailable = async (): Promise<never> => {
        throw new Error('Optimization history requires reconciliation')
      }
      manager = {
        start: unavailable,
        startSweep: unavailable,
        previewSweep: unavailable,
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
