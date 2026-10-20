import { useTranslation } from 'react-i18next'
import { draftOutputChecks, type JsonCheckDraft } from './optimization-research-input'

export function ExpectedJsonCheckEditor({
  value,
  onChange,
  disabled,
  inputClass
}: {
  value: JsonCheckDraft
  onChange(value: JsonCheckDraft): void
  disabled: boolean
  inputClass: string
}): React.JSX.Element {
  const { t } = useTranslation()
  let valid = true
  if (value.enabled) {
    try {
      draftOutputChecks(value)
    } catch {
      valid = false
    }
  }
  return (
    <div className="space-y-2 rounded border border-border p-2">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label={t('Check expected JSON output')}
          checked={value.enabled}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
        />
        {t('Check expected JSON output')}
      </label>
      {value.enabled && (
        <>
          <label className="block">
            {t('Output JSON file')}
            <input
              aria-label={t('Output JSON file')}
              className={inputClass}
              value={value.path}
              maxLength={180}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, path: event.target.value })}
            />
          </label>
          <label className="block">
            {t('JSON pointer (empty checks the whole file)')}
            <input
              aria-label={t('JSON pointer (empty checks the whole file)')}
              className={inputClass}
              value={value.pointer}
              maxLength={512}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, pointer: event.target.value })}
            />
          </label>
          <label className="block">
            {t('Expected JSON value')}
            <textarea
              aria-label={t('Expected JSON value')}
              className={inputClass}
              value={value.expected}
              rows={2}
              maxLength={16000}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, expected: event.target.value })}
            />
          </label>
          {!valid && (
            <p className="text-xs text-text-400">
              {t('Enter a valid JSON value, output path and JSON pointer.')}
            </p>
          )}
        </>
      )}
    </div>
  )
}
