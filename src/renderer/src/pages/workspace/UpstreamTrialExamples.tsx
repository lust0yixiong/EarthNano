import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { upstreamTrials, type UpstreamTrialId } from '@/lib/upstream-trials'

export const UpstreamTrialExamples = ({
  onSelect
}: {
  onSelect?: (id: UpstreamTrialId) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const cases = [
    {
      id: 'openscience-case16' as const,
      title: t('OpenScience: reproduce Case16'),
      description: t('Rerun the original registry calculation with its frozen input.')
    },
    {
      id: 'harness2-ledger' as const,
      title: t('Harness²: reconcile signed ledgers'),
      description: t('Run the original demo task, then compare configurations with Optimize task.')
    }
  ]

  return (
    <details className="mt-4 rounded-xl border border-border p-3" data-testid="upstream-trials">
      <summary className="cursor-pointer text-sm font-medium text-text-000">
        {t('Try upstream examples')}
      </summary>
      <p className="mt-2 text-xs text-text-100">
        {t(
          'Choose a case in an empty draft to attach its inputs. Review it before sending; model calls may incur fees.'
        )}
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {cases.map(({ id, title, description }) => (
          <div key={id} className="rounded-lg bg-bg-200 p-3">
            <Button
              variant="outline"
              size="sm"
              disabled={!onSelect}
              onClick={() => onSelect?.(id)}
              data-testid={`trial-${id}`}
            >
              {title}
            </Button>
            <p className="mt-2 text-xs text-text-100">{description}</p>
            <a
              href={upstreamTrials[id].source}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-xs text-primary underline"
            >
              {t('Upstream source')}
            </a>
          </div>
        ))}
      </div>
    </details>
  )
}
