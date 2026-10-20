import { useEffect, useRef, useState } from 'react'
import { ErrorNotice } from '@/components/error-notice'
import { useTranslation } from 'react-i18next'
import type {
  DesktopOptimizationApi,
  OptimizationProgress
} from '../../../../shared/earthnano/desktop-optimization'
import {
  DEFAULT_OPTIMIZATION_METHOD,
  minimumOptimizationExecutions,
  MAX_OPTIMIZATION_EXECUTIONS,
  type OptimizationMethodOptions
} from '../../../../shared/earthnano/optimization-method'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../../shared/web-event-connection'

type Props = {
  projectId: string
  sessionId: string
  initialPrompt: string
  onOpenSession?: (id: string) => void
  onOpenReview?: (sessionId: string, reviewId: string) => void
  /** Protocol test seam; production always uses the typed preload API. */
  api?: DesktopOptimizationApi
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
  api,
  onOpenSession,
  onOpenReview
}: Props & { api: DesktopOptimizationApi }): React.JSX.Element {
  const { t } = useTranslation()
  const [prompt, setPrompt] = useState(initialPrompt)
  const [criteria, setCriteria] = useState('')
  const [files, setFiles] = useState<Array<{ path: string; content: string }>>([])
  const [limit, setLimit] = useState(12)
  const [method, setMethod] = useState<OptimizationMethodOptions>({
    ...DEFAULT_OPTIMIZATION_METHOD
  })
  const minimum = minimumOptimizationExecutions(method)
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
    if (!promptEdited.current) setPrompt(initialPrompt)
  }, [initialPrompt])
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
    requestKey.current ??= crypto.randomUUID()
    try {
      const result = await api.start({
        projectId,
        sourceSessionId: sessionId,
        requestKey: requestKey.current,
        prompt,
        criteria,
        files,
        executionLimit: limit,
        method
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
  const attach = async (selected: FileList | null): Promise<void> => {
    if (!selected) return
    setBusy(true)
    setError(false)
    try {
      const next = [...files]
      for (const file of Array.from(selected)) {
        if (
          !/^[A-Za-z0-9_. -]{1,180}$/.test(file.name) ||
          file.name === '.' ||
          file.name === '..' ||
          !/\.(txt|md|csv|tsv|json|ya?ml|log)$/i.test(file.name) ||
          file.size > 64_000 ||
          next.some(
            (entry) =>
              entry.path.normalize('NFC').toLowerCase() === file.name.normalize('NFC').toLowerCase()
          )
        )
          throw new Error('Unsupported text file')
        const content = await file.text()
        if (content.includes('\0') || content.includes('\uFFFD'))
          throw new Error('Unsupported text encoding')
        next.push({ path: file.name, content })
      }
      if (
        next.length > 32 ||
        next.reduce((total, file) => total + new TextEncoder().encode(file.content).byteLength, 0) >
          128_000
      )
        throw new Error('Text inputs exceed limit')
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
  const lines = criteria
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const valid =
    prompt.trim().length > 0 &&
    prompt.length <= 32_000 &&
    criteria.length <= 16_000 &&
    lines.length >= 1 &&
    lines.length <= 16 &&
    Number.isInteger(limit) &&
    lines.every((line) => line.length <= 2000) &&
    limit >= minimum &&
    limit <= MAX_OPTIMIZATION_EXECUTIONS
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
            {progress.method && (
              <p>
                {t('Method: {{mode}} · k={{k}} · concurrency={{concurrency}}', {
                  mode: progress.method.mode === 'parallel' ? t('Parallel') : t('Sequential'),
                  k: progress.method.k,
                  concurrency: progress.method.concurrency
                })}
              </p>
            )}
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
            {progress.error && <ErrorNotice role="alert" level="error" description={message} />}
            {progress.assessments && (
              <>
                <p className="text-xs text-text-400">
                  {t('Results compare independent assessments; improvement is not guaranteed.')}
                </p>
                {(['baseline', 'candidate'] as const).map((kind) => {
                  const assessment = progress.assessments![kind]
                  const session = progress.executions.find(
                    (entry) => entry.executionId === assessment.targetExecutionId
                  )?.sessionId
                  return (
                    <div key={kind} className="rounded border border-border p-2">
                      <p className="font-medium">
                        {kind === 'baseline' ? t('Baseline assessment') : t('Candidate assessment')}
                      </p>
                      <p>
                        {t('Score: {{score}} · {{outcome}}', {
                          score: assessment.score,
                          outcome: assessment.outcome === 'pass' ? t('Passed') : t('Flagged')
                        })}
                      </p>
                      <p className="whitespace-pre-wrap break-words">{assessment.rationale}</p>
                      {session && onOpenReview && (
                        <button
                          type="button"
                          className="text-primary underline"
                          onClick={() => onOpenReview(session, assessment.reviewId)}
                        >
                          {t('Open assessment')}
                        </button>
                      )}
                    </div>
                  )
                })}
              </>
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
        <label className="block">
          {t('Task description')}
          <textarea
            aria-label={t('Task description')}
            className={inputClass}
            rows={3}
            maxLength={32_000}
            value={prompt}
            disabled={active || busy}
            onChange={(event) => {
              promptEdited.current = true
              setPrompt(event.target.value)
              requestKey.current = null
            }}
          />
        </label>
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
          {t('Choose up to 32 text files with simple names, at most 64 KB each and 128 KB total.')}
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
        <p className="text-xs text-text-400">{t('Write 1–16 independent checks, one per line.')}</p>
        <label className="block">
          {t('Optimization mode')}
          <select
            aria-label={t('Optimization mode')}
            className={inputClass}
            value={method.mode}
            disabled={active || busy}
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
                setLimit((value) => Math.max(value, minimumOptimizationExecutions(next)))
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
        <p className="text-xs text-text-400">
          {t(
            'First attempts require {{minimum}} executions including assessments; retries use the same limit.',
            { minimum }
          )}
        </p>
        <label className="block">
          {t('Execution limit (includes two assessments)')}
          <input
            aria-label={t('Execution limit (includes two assessments)')}
            className={inputClass}
            type="number"
            min={minimum}
            max={MAX_OPTIMIZATION_EXECUTIONS}
            step={1}
            value={limit}
            disabled={active || busy}
            onChange={(event) => {
              setLimit(Number(event.target.value))
              requestKey.current = null
            }}
          />
        </label>
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
