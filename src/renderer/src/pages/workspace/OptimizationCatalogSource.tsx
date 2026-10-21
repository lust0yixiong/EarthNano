import type { NotebookLanguage } from '../../../../shared/notebook-language-contract'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import type { PersistedChatSession, SessionSummary } from '../../../../shared/session-persistence'
import { notebookOptimizationSourceMessages } from '../../../../shared/earthnano/notebook-source'
export type CatalogSessionApi = Pick<Window['api']['sessions'], 'list' | 'loadOne'>
export interface NotebookSourceSelection {
  language: NotebookLanguage | 'compute'
  sourceSessionId: string
  promptMessageId: string
  sourceReady: boolean
  prompt: string
}
export function OptimizationCatalogSource({
  projectId,
  value,
  onChange,
  disabled,
  inputClass,
  sessions = window.api?.sessions
}: {
  projectId: string
  value: NotebookSourceSelection
  onChange(value: NotebookSourceSelection): void
  disabled: boolean
  inputClass: string
  sessions?: CatalogSessionApi
}): React.JSX.Element {
  const { t } = useTranslation()
  const [choices, setChoices] = useState<readonly SessionSummary[]>([])
  const [snapshot, setSnapshot] = useState<{ key: string; session: PersistedChatSession }>()
  const [errorKey, setError] = useState<string>()
  const sourceKey = JSON.stringify([projectId, value.sourceSessionId])
  const loaded = snapshot?.key === sourceKey ? snapshot.session : undefined
  const error = errorKey === sourceKey || errorKey === projectId
  useEffect(() => {
    let current = true
    void Promise.resolve()
      .then(() => {
        if (!sessions) throw new Error('Source reader unavailable')
        return sessions.list()
      })
      .then((result) => {
        if (current)
          setChoices(result.sessions.filter((s) => s.projectId === projectId && !s.archivedAt))
      })
      .catch(() => {
        if (current) setError(projectId)
      })
    return () => {
      current = false
    }
  }, [sessions, projectId])
  useEffect(() => {
    let current = true
    if (!value.sourceSessionId || !sessions) return
    void sessions
      .loadOne({ projectId, sessionId: value.sourceSessionId })
      .then((session) => {
        if (!current) return
        if (
          !session ||
          session.projectId !== projectId ||
          session.id !== value.sourceSessionId ||
          session.archivedAt ||
          session.packageOrigin
        )
          throw new Error('Source unavailable')
        setSnapshot({ key: sourceKey, session })
        setError(undefined)
      })
      .catch(() => {
        if (current) setError(sourceKey)
      })
    return () => {
      current = false
    }
  }, [sessions, projectId, value.sourceSessionId, sourceKey])
  const messages = loaded
    ? notebookOptimizationSourceMessages(loaded, { allowEmpty: value.language === 'compute' })
    : []
  const selected = messages.find((m) => m.id === value.promptMessageId)
  // Publish readiness only from this exact loaded source; parent revision invalidates stale previews.
  useEffect(() => {
    const ready = !!selected
    if (value.sourceReady !== ready || (selected && value.prompt !== selected.content))
      onChange({ ...value, sourceReady: ready, prompt: selected?.content ?? '' })
  }, [selected, value, onChange])
  return (
    <div className="space-y-2">
      <label className="block">
        {t('Notebook runtime')}
        <select
          aria-label={t('Notebook runtime')}
          className={inputClass}
          value={value.language}
          disabled={disabled}
          onChange={(event) => {
            const language = event.target.value
            if (language === 'python' || language === 'r' || language === 'compute')
              onChange({ ...value, language })
          }}
        >
          <option value="python">{t('Python')}</option>
          <option value="r">{t('R')}</option>
          <option value="compute">{t('Compute')}</option>
        </select>
      </label>
      <label className="block">
        {t('Source chat')}
        <select
          aria-label={t('Source chat')}
          className={inputClass}
          value={value.sourceSessionId}
          disabled={disabled}
          onChange={(e) => {
            onChange({
              ...value,
              sourceSessionId: e.target.value,
              promptMessageId: '',
              sourceReady: false,
              prompt: ''
            })
          }}
        >
          <option value="">{t('Choose a source chat')}</option>
          {choices.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title || s.id}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        {t('Source task')}
        <select
          aria-label={t('Source task')}
          className={inputClass}
          value={selected?.id ?? ''}
          disabled={disabled || !loaded}
          onChange={(e) => {
            const message = messages.find((m) => m.id === e.target.value)
            onChange({
              ...value,
              promptMessageId: e.target.value,
              sourceReady: !!message,
              prompt: message?.content ?? ''
            })
          }}
        >
          <option value="">{t('Choose an original Notebook task')}</option>
          {messages.map((m) => (
            <option key={m.id} value={m.id}>
              {m.content.slice(0, 160)}
            </option>
          ))}
        </select>
      </label>
      {loaded && !messages.length && <p>{t('No supported Notebook tasks in this chat.')}</p>}
      {error && (
        <ErrorNotice
          role="alert"
          level="error"
          description={t('Source chat could not be loaded.')}
        />
      )}
    </div>
  )
}
