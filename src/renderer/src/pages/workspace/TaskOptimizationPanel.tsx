import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ErrorNotice } from '@/components/error-notice'
import { OptimizationUsageView } from './OptimizationUsageView'
import { useTranslation } from 'react-i18next'
import type {
  DesktopOptimizationApi,
  OptimizationProgress
} from '../../../../shared/earthnano/desktop-optimization'
import {
  DEFAULT_OPTIMIZATION_METHOD,
  type OptimizationMethodOptions
} from '../../../../shared/earthnano/optimization-method'
import { ExpectedJsonCheckEditor } from './OptimizationResearchInputs'
import { emptyJsonCheckDraft } from './optimization-research-input'
import {
  ResearchOutcomeView,
  ExperimentExperienceView,
  IndependentAssessmentsView
} from './OptimizationResearchResults'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../../shared/web-event-connection'
import type { PersistedArtifact } from '../../../../shared/session-persistence'
import {
  isOptimizationTextPath,
  normalizeOptimizationArtifactInputs,
  type OptimizationArtifactInput
} from '../../../../shared/earthnano/optimization-input'
import {
  MAX_SWEEP_EXECUTIONS,
  MAX_SWEEP_TASKS,
  normalizeOptimizationCatalog,
  normalizeOptimizationSweep,
  type PreviewDesktopSweep,
  type DesktopSweepPreview,
  type OptimizationSweepOptions
} from '../../../../shared/earthnano/optimization-sweep'

import {
  OptimizationCatalogSource,
  type CatalogSessionApi,
  type NotebookSourceSelection
} from './OptimizationCatalogSource'
import {
  appendTextFiles,
  catalogTaskInput,
  newCatalogTask,
  type CatalogTaskDraft
} from './optimization-catalog-input'

type Props = {
  projectId: string
  sessionId: string
  initialPrompt: string
  sourcePromptMessageId?: string
  artifacts?: PersistedArtifact[]
  onOpenSession?: (id: string) => void
  onOpenReview?: (sessionId: string, reviewId: string) => void
  /** Protocol test seam; production always uses the typed preload API. */
  api?: DesktopOptimizationApi
  sessions?: CatalogSessionApi
}
const terminal = (state: OptimizationProgress['state']): boolean =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(state)

export function TaskOptimizationPanel(props: Props): React.JSX.Element | null {
  const api = props.api ?? window.api?.optimization
  if (
    !api ||
    window.api?.platform === 'win32' ||
    document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) === 'true'
  )
    return null
  return (
    <OptimizationSessionPanel key={`${props.projectId}:${props.sessionId}`} {...props} api={api} />
  )
}
function OptimizationSessionPanel({
  projectId,
  sessionId,
  initialPrompt,
  sourcePromptMessageId,
  artifacts = [],
  api,
  sessions,
  onOpenSession,
  onOpenReview
}: Props & { api: DesktopOptimizationApi }): React.JSX.Element {
  const { t } = useTranslation()
  const [prompt, setPrompt] = useState(initialPrompt)
  const [notebookMode, setNotebookMode] = useState(false)
  const [bothModes, setBothModes] = useState(false)
  const [criteria, setCriteria] = useState('')
  const [files, setFiles] = useState<Array<{ path: string; content: string }>>([])
  const [selectedVersions, setSelectedVersions] = useState<string[]>([])
  const availableArtifacts = artifacts.filter(
    (file) =>
      file.artifactId &&
      file.versionId &&
      file.sha256 &&
      file.size !== undefined &&
      file.size <= 64_000 &&
      file.name !== undefined &&
      isOptimizationTextPath(file.name)
  )
  const inputArtifacts = (): OptimizationArtifactInput[] => {
    const selected = normalizeOptimizationArtifactInputs(
      selectedVersions.map((versionId) => {
        const file = availableArtifacts.find((file) => file.versionId === versionId)
        if (!file) throw new Error('Selected source version unavailable')
        return {
          artifactId: file.artifactId!,
          versionId: file.versionId!,
          checksum: file.sha256!,
          path: file.name!
        }
      })
    )!
    if (
      selected.length + files.length > 32 ||
      selected.some((ref) =>
        files.some(
          (file) =>
            file.path.normalize('NFC').toLowerCase() === ref.path.normalize('NFC').toLowerCase()
        )
      )
    )
      throw new Error('Optimization input paths collide')
    return selected
  }
  const [limit, setLimit] = useState(12)
  const [method, setMethod] = useState<OptimizationMethodOptions>({
    ...DEFAULT_OPTIMIZATION_METHOD
  })
  const [checkDraft, setCheckDraft] = useState(emptyJsonCheckDraft)
  const [domainName, setDomainName] = useState('research')
  const [taskId, setTaskId] = useState('task-0001')
  const [nextTasks, setNextTasks] = useState<CatalogTaskDraft[]>([])
  const [source, setSource] = useState<NotebookSourceSelection>({
    sourceSessionId: sessionId,
    promptMessageId: sourcePromptMessageId ?? '',
    sourceReady: false,
    prompt: ''
  })
  const [seed, setSeed] = useState('')
  const [domainFilter, setDomainFilter] = useState('')
  const [taskFilter, setTaskFilter] = useState('')
  const [maxTasks, setMaxTasks] = useState('')
  const [workers, setWorkers] = useState(1)
  const integer = (value: string): number => (/^-?\d+$/.test(value) ? Number(value) : NaN)
  const sweepOptions = (): OptimizationSweepOptions =>
    normalizeOptimizationSweep({
      modes: bothModes ? ['parallel', 'sequential'] : [method.mode],
      k: method.k,
      concurrency: method.concurrency,
      stream: {
        seed: seed === '' ? null : integer(seed),
        onlyDomains: domainFilter.trim() ? domainFilter.trim().split(/[\s,]+/) : [],
        onlyTasks: taskFilter.trim() ? taskFilter.trim().split(/[\s,]+/) : [],
        maxTasks: maxTasks === '' ? null : integer(maxTasks),
        workers
      }
    })
  const draftCatalog =
    (): import('../../../../shared/earthnano/optimization-sweep').OptimizationSweepTask[] => {
      const tasks = [
        catalogTaskInput({
          id: 'primary',
          taskId,
          domain: domainName,
          kind: notebookMode ? 'notebook' : 'text',
          sourceSessionId: notebookMode ? source.sourceSessionId : sessionId,
          promptMessageId: source.promptMessageId,
          sourceReady: source.sourceReady,
          prompt: notebookMode ? source.prompt : prompt,
          criteria,
          files: notebookMode ? [] : files,
          inputArtifacts: notebookMode ? [] : inputArtifacts(),
          check: checkDraft
        }),
        ...nextTasks.map(catalogTaskInput)
      ]
      normalizeOptimizationCatalog(tasks.map(({ taskId, domain }) => ({ taskId, domain })))
      return tasks
    }
  const appendTask = (kind: CatalogTaskDraft['kind']): void =>
    setNextTasks((tasks) => {
      const used = new Set([taskId, ...tasks.map((task) => task.taskId)])
      let index = 1
      while (used.has(`task-${String(index).padStart(4, '0')}`)) index++
      return [
        ...tasks,
        newCatalogTask(
          `task-${String(index).padStart(4, '0')}`,
          domainName,
          kind === 'text' ? sessionId : '',
          kind
        )
      ]
    })
  const maximum = MAX_SWEEP_EXECUTIONS
  const [preview, setPreview] = useState<{
    identity: { fingerprint: string }
    result: DesktopSweepPreview
    request: PreviewDesktopSweep
  } | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const fingerprint = JSON.stringify({
    projectId,
    sessionId,
    prompt,
    notebookMode,
    source,
    criteria,
    files,
    selectedVersions,
    artifacts,
    taskId,
    domainName,
    nextTasks,
    method,
    bothModes,
    seed,
    domainFilter,
    taskFilter,
    maxTasks,
    workers
  })
  const draftIdentity = useMemo(() => ({ fingerprint }), [fingerprint])
  const latestDraft = useRef(draftIdentity)
  useLayoutEffect(() => {
    latestDraft.current = draftIdentity
  }, [draftIdentity])
  const currentPreview = preview?.identity === draftIdentity ? preview : null
  const hasSelectedTasks =
    currentPreview?.result.order.some((domain) => domain.taskIds.length > 0) ?? false
  const minimum = currentPreview?.result.minimumExecutions
  const domainDraft = nextTasks.length > 0
  const [progress, setProgress] = useState<OptimizationProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<false | 'request' | 'files'>(false)
  const panel = useRef<HTMLDetailsElement>(null)
  const alive = useRef(true)
  const actionRevision = useRef(0)
  const requestKey = useRef<string | null>(null)
  const promptEdited = useRef(false)
  const active = !!progress && !terminal(progress.state)
  useEffect(() => {
    if (!promptEdited.current || notebookMode) setPrompt(initialPrompt)
  }, [initialPrompt, notebookMode])
  const message = t(
    'Optimization request could not be completed. Check the selected model and runtime settings.'
  )
  useEffect(() => {
    alive.current = true
    let disposed = false
    const revision = actionRevision.current
    void api
      .latest({ projectId, sourceSessionId: sessionId })
      .then((value) => {
        if (!disposed && revision === actionRevision.current) setProgress(value)
      })
      .catch(() => {
        if (!disposed && revision === actionRevision.current) setError('request')
      })
    return () => {
      disposed = true
      alive.current = false
    }
  }, [api, projectId, sessionId])
  useEffect(() => {
    if (progress?.runId && panel.current) panel.current.scrollTop = 0
  }, [progress?.runId])
  const runningRunId = progress && !terminal(progress.state) ? progress.runId : undefined
  useEffect(() => {
    if (!runningRunId) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = (): void => {
      timer = setTimeout(() => {
        const revision = actionRevision.current
        void api
          .get({ projectId, sourceSessionId: sessionId, runId: runningRunId })
          .then((value) => {
            if (disposed) return
            if (revision !== actionRevision.current) {
              poll()
              return
            }
            setProgress(value)
            setError(false)
            if (!terminal(value.state)) poll()
          })
          .catch(() => {
            if (!disposed) {
              if (revision === actionRevision.current) setError('request')
              poll()
            }
          })
      }, 1000)
    }
    poll()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [api, projectId, sessionId, runningRunId])
  const stage = (): string => {
    if (!progress) return t('Ready')
    if (progress.state === 'queued') return t('Queued')
    if (progress.state === 'stopping') return t('Stopping')
    if (progress.state === 'completed') return t('Completed')
    if (progress.state === 'failed') return t('Failed')
    if (progress.state === 'cancelled') return t('Cancelled')
    if (progress.state === 'interrupted') return t('Interrupted')
    const currentStage =
      progress.executions.find((entry) => entry.phase === 'running' || entry.phase === 'preparing')
        ?.role ?? progress.stage
    if (progress.state === 'assessing' || progress.stage.includes('assessment'))
      return t('Assessing')
    if (currentStage.includes('select')) return t('Selecting')
    if (currentStage.includes('baseline')) return t('Baseline')
    if (currentStage.includes('propos')) return t('Proposing')
    if (currentStage.includes('compos')) return t('Composing')
    return t('Working')
  }
  const start = async (): Promise<void> => {
    actionRevision.current += 1
    setBusy(true)
    setError(false)
    try {
      if (
        !currentPreview ||
        !hasSelectedTasks ||
        limit < currentPreview.result.minimumExecutions ||
        limit > maximum
      )
        throw new Error('Current preview required')
      requestKey.current ??= crypto.randomUUID()
      const result = await api.startSweep({
        projectId,
        sourceSessionId: sessionId,
        requestKey: requestKey.current,
        executionLimit: limit,
        previewPlanDigest: currentPreview.result.planDigest,
        sweep: sweepOptions(),
        catalog: draftCatalog()
      })
      if (alive.current) {
        actionRevision.current += 1
        setProgress(result)
        requestKey.current = null
      }
    } catch {
      if (alive.current) setError('request')
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const stop = async (): Promise<void> => {
    if (!progress) return
    actionRevision.current += 1
    setBusy(true)
    setError(false)
    try {
      const result = await api.stop({
        projectId,
        sourceSessionId: sessionId,
        runId: progress.runId
      })
      if (alive.current) {
        actionRevision.current += 1
        setProgress(result)
      }
    } catch {
      if (alive.current) setError('request')
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const resume = async (): Promise<void> => {
    if (!progress?.resumeAvailable) return
    actionRevision.current += 1
    setBusy(true)
    setError(false)
    try {
      const result = await api.resume({
        projectId,
        sourceSessionId: sessionId,
        runId: progress.runId
      })
      if (alive.current) {
        actionRevision.current += 1
        setProgress(result)
      }
    } catch {
      if (alive.current) setError('request')
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const attach = async (selected: FileList | null): Promise<void> => {
    if (!selected) return
    setBusy(true)
    setError(false)
    try {
      const next = await appendTextFiles(files, selected)
      if (alive.current) {
        setFiles(next)
        requestKey.current = null
      }
    } catch {
      if (alive.current) setError('files')
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  let draftValid = true
  try {
    draftCatalog()
    sweepOptions()
  } catch {
    draftValid = false
  }
  const valid =
    draftValid &&
    !!currentPreview &&
    hasSelectedTasks &&
    Number.isSafeInteger(limit) &&
    limit >= currentPreview.result.minimumExecutions &&
    limit <= maximum
  const previewStream = async (): Promise<void> => {
    const captured = draftIdentity
    setPreviewBusy(true)
    setError(false)
    setPreview(null)
    try {
      const request = {
        projectId,
        sourceSessionId: sessionId,
        catalog: draftCatalog().map(({ taskId, domain }) => ({ taskId, domain })),
        sweep: sweepOptions()
      }
      const result = await api.previewSweep(request)
      if (alive.current && latestDraft.current === captured) {
        setPreview({ identity: captured, result, request })
        setLimit((value) => Math.min(maximum, Math.max(value, result.minimumExecutions)))
      }
    } catch {
      if (alive.current && latestDraft.current === captured) setError('request')
    } finally {
      if (alive.current) setPreviewBusy(false)
    }
  }
  // Any edited source/options/criteria/input gets a fresh idempotency key, even after a failed submit.
  useEffect(() => {
    requestKey.current = null
  }, [fingerprint, limit])
  const inputClass =
    'w-full rounded border border-border bg-bg-10 p-2 text-sm text-text-100 disabled:opacity-60'
  return (
    <details
      ref={panel}
      className="mx-4 mb-2 shrink-0 rounded-lg border border-border text-sm max-h-[55vh] overflow-auto"
      data-testid="task-optimization-panel"
    >
      <summary className="cursor-pointer px-3 py-2 font-medium text-text-100">
        {t('Optimize task')}
        {progress ? ` · ${stage()}` : ''}
      </summary>
      <div className="space-y-3 px-3 pb-3">
        {progress && (
          <div role="status" aria-live="polite" className="space-y-2">
            <p>{stage()}</p>
            <p>
              {t('Used {{used}} of {{limit}} executions · {{active}} active', {
                used: progress.budget.admitted,
                limit: progress.budget.limit,
                active: progress.budget.active
              })}
            </p>
            {progress.usage && <OptimizationUsageView usage={progress.usage} />}
            {progress.method && (
              <p>
                {t('Method: {{mode}} · k={{k}} · concurrency={{concurrency}}', {
                  mode: progress.method.mode === 'parallel' ? t('Parallel') : t('Sequential'),
                  k: progress.method.k,
                  concurrency: progress.method.concurrency
                })}
              </p>
            )}
            {progress.outcome && !progress.domain && (
              <ResearchOutcomeView
                outcome={progress.outcome}
                sessionId={
                  progress.executions.find(
                    (entry) =>
                      entry.executionId === progress.assessments?.candidate.targetExecutionId
                  )?.sessionId
                }
                onOpenReview={onOpenReview}
              />
            )}
            {(progress.sweep
              ? progress.sweep.domains.map(({ mode, summary }) => ({ mode, summary }))
              : progress.domain
                ? [{ mode: undefined, summary: progress.domain }]
                : []
            ).map(({ mode, summary: domainSummary }) => (
              <div
                className="space-y-2"
                data-testid="domain-results"
                key={`${mode ?? 'single'}:${domainSummary.name}`}
              >
                <p>{t('Domain experiment: {{name}}', { name: domainSummary.name })}</p>
                {mode && <p>{mode === 'parallel' ? t('Parallel') : t('Sequential')}</p>}
                {domainSummary.order.map((taskId, index) => {
                  const task = domainSummary.tasks.find((entry) => entry.taskId === taskId)
                  return (
                    <section key={taskId} className="space-y-2 rounded border border-border p-2">
                      <p className="font-medium">
                        {t('Task {{number}} · {{taskId}}', { number: index + 1, taskId })}
                      </p>
                      {task?.outcome ? (
                        <ResearchOutcomeView
                          outcome={task.outcome}
                          sessionId={
                            progress.executions.find(
                              (entry) =>
                                entry.executionId ===
                                (task.assessments?.candidate.targetExecutionId ??
                                  task.experience?.selectedExecutionId)
                            )?.sessionId
                          }
                          onOpenReview={onOpenReview}
                        />
                      ) : (
                        <p>
                          {terminal(progress.state)
                            ? t('Task result unavailable')
                            : t('Awaiting task result')}
                        </p>
                      )}
                      {task?.assessments && (
                        <IndependentAssessmentsView
                          assessments={task.assessments}
                          executions={progress.executions}
                          onOpenReview={onOpenReview}
                        />
                      )}
                      {task?.selection && (
                        <p>
                          {t('Selected {{label}} from {{candidateCount}} candidates', {
                            label: task.selection.chosenLabel,
                            candidateCount: task.selection.candidateCount
                          })}
                        </p>
                      )}
                      {task?.selection && (
                        <>
                          <p>
                            {task.selection.trivial
                              ? t('Trivial selection')
                              : t('Selector comparison')}
                          </p>
                          {task.selection.fallback && <p>{t('Selection fallback')}</p>}
                          <p className="whitespace-pre-wrap break-words">{task.selection.reason}</p>
                        </>
                      )}
                      {task?.experience && (
                        <ExperimentExperienceView experience={task.experience} />
                      )}
                    </section>
                  )
                })}
              </div>
            ))}
            {progress.selection && (
              <div>
                <p>
                  {t('Selected {{label}} from {{candidateCount}} candidates', {
                    label: progress.selection.chosenLabel,
                    candidateCount: progress.selection.candidateCount
                  })}
                </p>
                <p>
                  {progress.selection.trivial ? t('Trivial selection') : t('Selector comparison')}
                </p>
                {progress.selection.fallback && <p>{t('Selection fallback')}</p>}
                <p className="whitespace-pre-wrap break-words">{progress.selection.reason}</p>
              </div>
            )}
            {progress.executions
              .filter((entry) => entry.stageId)
              .map((entry) => (
                <p key={entry.executionId}>{t('Stage: {{stage}}', { stage: entry.stageId })}</p>
              ))}
            {active && (
              <button
                type="button"
                className="rounded border border-border px-3 py-2 disabled:opacity-50"
                disabled={busy || progress?.state === 'stopping'}
                onClick={() => void stop()}
              >
                {t('Stop optimization')}
              </button>
            )}
            {!active && progress.resumeAvailable && (
              <div>
                <p>{t('Resume uses the original task and remaining budget.')}</p>
                <button
                  type="button"
                  className="rounded border border-border px-3 py-2 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void resume()}
                >
                  {t('Resume optimization')}
                </button>
              </div>
            )}
            {progress.error && <ErrorNotice role="alert" level="error" description={message} />}
            {progress.assessments && !progress.domain && (
              <IndependentAssessmentsView
                assessments={progress.assessments}
                executions={progress.executions}
                onOpenReview={onOpenReview}
              />
            )}
            {progress.executions
              .filter((entry) => entry.sessionId)
              .map((entry, index) => (
                <button
                  key={entry.executionId}
                  type="button"
                  className="mr-3 text-primary underline"
                  disabled={!onOpenSession}
                  onClick={() => onOpenSession?.(entry.sessionId!)}
                >
                  {t('Open result chat {{number}}', { number: index + 1 })}
                </button>
              ))}
          </div>
        )}
        <div data-testid={`optimization-catalog-task-${taskId}`} className="space-y-3">
          {sourcePromptMessageId && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={notebookMode}
                disabled={active || busy}
                onChange={(event) => {
                  setNotebookMode(event.target.checked)
                  if (event.target.checked) {
                    setPrompt(initialPrompt)
                    setFiles([])
                    setSelectedVersions([])
                  }
                  requestKey.current = null
                }}
              />
              {t('Repeat this task with Notebook Python')}
            </label>
          )}
          {notebookMode && (
            <OptimizationCatalogSource
              projectId={projectId}
              value={source}
              onChange={setSource}
              disabled={active || busy}
              inputClass={inputClass}
              sessions={sessions}
            />
          )}
          <label className="block">
            {t('Task ID')}
            <input
              aria-label={t('Task ID')}
              className={inputClass}
              value={taskId}
              maxLength={80}
              disabled={active || busy}
              onChange={(e) => setTaskId(e.target.value)}
            />
          </label>
          <label className="block">
            {t('Task description')}
            <textarea
              aria-label={t('Task description')}
              className={inputClass}
              rows={3}
              maxLength={32_000}
              value={notebookMode ? source.prompt : prompt}
              disabled={active || busy || notebookMode}
              onChange={(event) => {
                promptEdited.current = true
                setPrompt(event.target.value)
                requestKey.current = null
              }}
            />
          </label>
          {!notebookMode && (
            <>
              {availableArtifacts.length > 0 && (
                <fieldset className="space-y-1" data-testid="optimization-source-artifacts">
                  <legend>{t('Use saved artifact versions as inputs')}</legend>
                  {availableArtifacts.map((file) => (
                    <label key={file.versionId} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        disabled={active || busy}
                        checked={selectedVersions.includes(file.versionId!)}
                        onChange={(event) => {
                          setSelectedVersions(
                            event.target.checked
                              ? [...selectedVersions, file.versionId!]
                              : selectedVersions.filter((id) => id !== file.versionId)
                          )
                          requestKey.current = null
                        }}
                      />
                      {t('{{name}} · version {{version}}', {
                        name: file.name,
                        version: file.versionNumber ?? file.versionId
                      })}
                    </label>
                  ))}
                </fieldset>
              )}
              <label className="block">
                {t('Text input files')}
                <input
                  aria-label={t('Text input files')}
                  type="file"
                  multiple
                  accept=".txt,.md,.csv,.tsv,.json,.yaml,.yml,.log"
                  disabled={active || busy}
                  onChange={(event) => {
                    void attach(event.target.files)
                    event.target.value = ''
                  }}
                />
              </label>
              <p className="text-xs text-text-400">
                {t(
                  'Choose up to 32 text files with simple names, at most 64 KB each and 128 KB total.'
                )}
              </p>
              {files.map((file) => (
                <div key={file.path} className="flex items-center justify-between gap-2">
                  <span className="truncate">{file.path}</span>
                  <button
                    type="button"
                    disabled={active || busy}
                    onClick={() => {
                      setFiles(files.filter((entry) => entry.path !== file.path))
                      requestKey.current = null
                    }}
                  >
                    {t('Remove')}
                  </button>
                </div>
              ))}
            </>
          )}
          <label className="block">
            {t('Acceptance criteria (one per line)')}
            <textarea
              aria-label={t('Acceptance criteria (one per line)')}
              className={inputClass}
              rows={3}
              maxLength={16_000}
              value={criteria}
              disabled={active || busy}
              onChange={(event) => {
                setCriteria(event.target.value)
                requestKey.current = null
              }}
            />
          </label>
          <p className="text-xs text-text-400">
            {t('Write 1–16 independent checks, one per line.')}
          </p>
          <ExpectedJsonCheckEditor
            value={checkDraft}
            disabled={active || busy}
            inputClass={inputClass}
            onChange={(value) => {
              setCheckDraft(value)
              requestKey.current = null
            }}
          />
          <label className="block">
            {t('Domain')}
            <input
              aria-label={t('Domain')}
              className={inputClass}
              maxLength={80}
              value={domainName}
              disabled={active || busy}
              onChange={(e) => setDomainName(e.target.value)}
            />
          </label>
        </div>
        <p className="text-xs text-text-400">
          {t('Each catalog task owns its source, inputs and acceptance checks.')}
        </p>
        {nextTasks.map((task, index) => (
          <fieldset
            key={task.id}
            data-testid={`optimization-catalog-task-${task.taskId}`}
            className="space-y-2 rounded border border-border p-2"
          >
            <legend>{t('Next task {{number}}', { number: index + 1 })}</legend>
            <label className="block">
              {t('Task ID')}
              <input
                aria-label={t('Task ID')}
                className={inputClass}
                value={task.taskId}
                maxLength={80}
                disabled={active || busy}
                onChange={(e) =>
                  setNextTasks((tasks) =>
                    tasks.map((x) => (x.id === task.id ? { ...x, taskId: e.target.value } : x))
                  )
                }
              />
            </label>
            <label className="block">
              {t('Domain')}
              <input
                aria-label={t('Domain')}
                className={inputClass}
                value={task.domain}
                maxLength={80}
                disabled={active || busy}
                onChange={(e) =>
                  setNextTasks((tasks) =>
                    tasks.map((x) => (x.id === task.id ? { ...x, domain: e.target.value } : x))
                  )
                }
              />
            </label>
            {task.kind === 'notebook' ? (
              <OptimizationCatalogSource
                projectId={projectId}
                value={task}
                onChange={(value) =>
                  setNextTasks((tasks) =>
                    tasks.map((x) => (x.id === task.id ? { ...x, ...value } : x))
                  )
                }
                disabled={active || busy}
                inputClass={inputClass}
                sessions={sessions}
              />
            ) : (
              <>
                <label className="block">
                  {t('Task description')}
                  <textarea
                    aria-label={t('Next task description {{number}}', { number: index + 1 })}
                    className={inputClass}
                    value={task.prompt}
                    maxLength={32000}
                    disabled={active || busy}
                    onChange={(e) =>
                      setNextTasks((tasks) =>
                        tasks.map((x) => (x.id === task.id ? { ...x, prompt: e.target.value } : x))
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  disabled={active || busy || notebookMode}
                  onClick={() => {
                    try {
                      const refs = inputArtifacts()
                      setNextTasks((tasks) =>
                        tasks.map((x) =>
                          x.id === task.id
                            ? {
                                ...x,
                                sourceSessionId: sessionId,
                                files: structuredClone(files),
                                inputArtifacts: refs
                              }
                            : x
                        )
                      )
                    } catch {
                      setError('files')
                    }
                  }}
                >
                  {t('Copy current text inputs')}
                </button>
                <label className="block">
                  {t('Text input files')}
                  <input
                    aria-label={t('Text input files')}
                    type="file"
                    multiple
                    accept=".txt,.md,.csv,.tsv,.json,.yaml,.yml,.log"
                    disabled={active || busy}
                    onChange={(e) => {
                      const selected = e.target.files
                      if (selected) {
                        setBusy(true)
                        void appendTextFiles(task.files, selected)
                          .then((value) => {
                            if (alive.current)
                              setNextTasks((tasks) =>
                                tasks.map((x) => (x.id === task.id ? { ...x, files: value } : x))
                              )
                          })
                          .catch(() => {
                            if (alive.current) setError('files')
                          })
                          .finally(() => {
                            if (alive.current) setBusy(false)
                          })
                      }
                      e.target.value = ''
                    }}
                  />
                </label>
                {task.files.map((file) => (
                  <div key={file.path}>
                    <span>{file.path}</span>
                    <button
                      type="button"
                      disabled={active || busy}
                      onClick={() =>
                        setNextTasks((tasks) =>
                          tasks.map((x) =>
                            x.id === task.id
                              ? { ...x, files: x.files.filter((f) => f.path !== file.path) }
                              : x
                          )
                        )
                      }
                    >
                      {t('Remove')}
                    </button>
                  </div>
                ))}
                {availableArtifacts.length > 0 && (
                  <fieldset>
                    <legend>{t('Use saved artifact versions as inputs')}</legend>
                    {availableArtifacts.map((file) => (
                      <label key={file.versionId} className="flex gap-2">
                        <input
                          type="checkbox"
                          disabled={active || busy}
                          checked={task.inputArtifacts.some((r) => r.versionId === file.versionId)}
                          onChange={(e) =>
                            setNextTasks((tasks) =>
                              tasks.map((x) =>
                                x.id === task.id
                                  ? {
                                      ...x,
                                      inputArtifacts: e.target.checked
                                        ? [
                                            ...x.inputArtifacts,
                                            {
                                              artifactId: file.artifactId!,
                                              versionId: file.versionId!,
                                              checksum: file.sha256!,
                                              path: file.name!
                                            }
                                          ]
                                        : x.inputArtifacts.filter(
                                            (r) => r.versionId !== file.versionId
                                          )
                                    }
                                  : x
                              )
                            )
                          }
                        />
                        {t('{{name}} · version {{version}}', {
                          name: file.name,
                          version: file.versionNumber ?? file.versionId
                        })}
                      </label>
                    ))}
                  </fieldset>
                )}
              </>
            )}
            <label className="block">
              {t('Acceptance criteria (one per line)')}
              <textarea
                aria-label={t('Next task criteria {{number}}', { number: index + 1 })}
                className={inputClass}
                value={task.criteria}
                maxLength={16000}
                disabled={active || busy}
                onChange={(e) =>
                  setNextTasks((tasks) =>
                    tasks.map((x) => (x.id === task.id ? { ...x, criteria: e.target.value } : x))
                  )
                }
              />
            </label>
            <ExpectedJsonCheckEditor
              value={task.check}
              disabled={active || busy}
              inputClass={inputClass}
              onChange={(check) =>
                setNextTasks((tasks) => tasks.map((x) => (x.id === task.id ? { ...x, check } : x)))
              }
            />
            <button
              type="button"
              disabled={active || busy}
              onClick={() => setNextTasks((tasks) => tasks.filter((x) => x.id !== task.id))}
            >
              {t('Remove next task')}
            </button>
          </fieldset>
        ))}
        <div className="flex gap-3">
          <button
            type="button"
            disabled={active || busy || nextTasks.length >= MAX_SWEEP_TASKS - 1}
            onClick={() => appendTask('text')}
          >
            {t('Add next task')}
          </button>
          <button
            type="button"
            disabled={active || busy || nextTasks.length >= MAX_SWEEP_TASKS - 1}
            onClick={() => appendTask('notebook')}
          >
            {t('Add Notebook task from another chat')}
          </button>
        </div>
        <label className="block">
          {t('Optimization mode')}
          <select
            aria-label={t('Optimization mode')}
            className={inputClass}
            value={method.mode}
            disabled={active || busy || bothModes}
            onChange={(event) => {
              setMethod({
                ...method,
                mode: event.target.value as OptimizationMethodOptions['mode']
              })
              requestKey.current = null
            }}
          >
            <option value="sequential">{t('Sequential')}</option>
            <option value="parallel">{t('Parallel')}</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            aria-label={t('Compare both optimization modes')}
            checked={bothModes}
            disabled={active || busy}
            onChange={(event) => {
              const enabled = event.target.checked
              setBothModes(enabled)
              requestKey.current = null
            }}
          />
          {t('Compare both optimization modes')}
        </label>
        <label className="block">
          {t('Recursion parameter (k)')}
          <input
            aria-label={t('Recursion parameter (k)')}
            className={inputClass}
            type="number"
            min={1}
            max={8}
            step={1}
            value={method.k}
            disabled={active || busy}
            onChange={(event) => {
              const k = Number(event.target.value)
              if (Number.isInteger(k) && k >= 1 && k <= 8) {
                const next = { ...method, k }
                setMethod(next)
                requestKey.current = null
              }
            }}
          />
        </label>
        <label className="block">
          {t('Concurrent executions')}
          <input
            aria-label={t('Concurrent executions')}
            className={inputClass}
            type="number"
            min={1}
            max={4}
            step={1}
            value={method.concurrency}
            disabled={active || busy}
            onChange={(event) => {
              const concurrency = Number(event.target.value)
              if (Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4) {
                setMethod({ ...method, concurrency })
                requestKey.current = null
              }
            }}
          />
        </label>
        <label className="block">
          {t('Shuffle seed (empty uses original order)')}
          <input
            aria-label={t('Shuffle seed (empty uses original order)')}
            className={inputClass}
            value={seed}
            disabled={active || busy}
            onChange={(e) => setSeed(e.target.value)}
          />
        </label>
        <label className="block">
          {t('Domain filter')}
          <input
            aria-label={t('Domain filter')}
            className={inputClass}
            value={domainFilter}
            disabled={active || busy}
            onChange={(e) => setDomainFilter(e.target.value)}
          />
        </label>
        <label className="block">
          {t('Task filter')}
          <input
            aria-label={t('Task filter')}
            className={inputClass}
            value={taskFilter}
            disabled={active || busy}
            onChange={(e) => setTaskFilter(e.target.value)}
          />
        </label>
        <p className="text-xs text-text-400">
          {t('Separate filter IDs with commas or spaces; empty includes all.')}
        </p>
        <label className="block">
          {t('Tasks per domain (empty means all)')}
          <input
            aria-label={t('Tasks per domain (empty means all)')}
            className={inputClass}
            value={maxTasks}
            disabled={active || busy}
            onChange={(e) => setMaxTasks(e.target.value)}
          />
        </label>
        <label className="block">
          {t('Domain workers')}
          <input
            aria-label={t('Domain workers')}
            className={inputClass}
            type="number"
            min={1}
            max={4}
            value={workers}
            disabled={active || busy}
            onChange={(e) => setWorkers(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          disabled={!draftValid || active || busy || previewBusy}
          onClick={() => void previewStream()}
        >
          {t('Preview task stream')}
        </button>
        {currentPreview ? (
          <div data-testid="optimization-sweep-preview" role="status">
            {hasSelectedTasks ? (
              <>
                <p>
                  {t(
                    'First attempts require {{minimum}} executions including assessments; retries use the same limit.',
                    { minimum }
                  )}
                </p>
                {currentPreview.result.order.map((domain) => (
                  <p key={domain.domain}>
                    {t('Planned domain {{domain}}: {{tasks}}', {
                      domain: domain.domain,
                      tasks: domain.taskIds.join(', ')
                    })}
                  </p>
                ))}
              </>
            ) : (
              <p>
                {t('No tasks match the previewed filters. Adjust the filters and preview again.')}
              </p>
            )}
          </div>
        ) : (
          <p>{t('Preview the current task stream before starting.')}</p>
        )}
        <label className="block">
          {domainDraft || bothModes
            ? t('Shared execution limit (all task assessments and reflections)')
            : t('Execution limit (includes two assessments)')}
          <input
            aria-label={
              domainDraft || bothModes
                ? t('Shared execution limit (all task assessments and reflections)')
                : t('Execution limit (includes two assessments)')
            }
            className={inputClass}
            type="number"
            min={minimum}
            max={maximum}
            step={1}
            value={limit}
            disabled={active || busy}
            onChange={(event) => {
              setLimit(Number(event.target.value))
              requestKey.current = null
            }}
          />
        </label>
        {minimum !== undefined && minimum > maximum && (
          <p role="alert" className="text-xs text-text-400">
            {t('Reduce recursion or task count to stay within {{limit}} shared executions.', {
              limit: maximum
            })}
          </p>
        )}
        <div className="flex gap-3">
          <button
            type="button"
            className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50"
            disabled={!valid || active || busy || progress?.state === 'interrupted'}
            onClick={() => void start()}
          >
            {t('Start optimization')}
          </button>
        </div>
        {error && (
          <ErrorNotice
            role="alert"
            level="error"
            description={
              error === 'files'
                ? t(
                    'Choose up to 32 text files with simple names, at most 64 KB each and 128 KB total.'
                  )
                : message
            }
          />
        )}
      </div>
    </details>
  )
}
