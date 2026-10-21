import { useTranslation } from 'react-i18next'
import type {
  ExecutionUsageSummary,
  UsageMetricSummary
} from '../../../../shared/earthnano/execution-usage'

export function OptimizationUsageView({
  usage
}: {
  usage: ExecutionUsageSummary
}): React.JSX.Element {
  const { t } = useTranslation()
  const value = (metric: UsageMetricSummary, money = false): string => {
    if (metric.total === undefined) return t('Unknown')
    const amount = money
      ? `${Math.floor(metric.total / 1_000_000)}.${String(metric.total % 1_000_000).padStart(6, '0')}`
      : String(metric.total)
    return t('{{value}} ({{covered}}/{{total}} executions)', {
      value: amount,
      covered: metric.coveredExecutions,
      total: usage.admittedExecutions
    })
  }
  return (
    <div className="space-y-1 text-xs text-text-200" data-testid="optimization-usage">
      <p className="font-medium">{t('Provider usage subtotals')}</p>
      <p>
        {t('Input {{input}} · cache {{cache}} · output {{output}} tokens', {
          input: usage.tokens.inputTokens ?? t('Unknown'),
          cache: usage.tokens.cacheTokens ?? t('Unknown'),
          output: usage.tokens.outputTokens ?? t('Unknown')
        })}
      </p>
      <p>
        {t('Token coverage: {{covered}}/{{total}} executions', {
          covered: usage.tokens.coveredExecutions,
          total: usage.admittedExecutions
        })}
      </p>
      <p>{t('Model turns: {{value}}', { value: value(usage.modelTurns) })}</p>
      <p>{t('API requests: {{value}}', { value: value(usage.apiRequests) })}</p>
      <p>{t('Cost (USD): {{value}}', { value: value(usage.costMicrousd, true) })}</p>
      {usage.ambiguousExecutions > 0 && (
        <p>
          {t('Excluded repeated prompt admissions: {{excluded}}', {
            excluded: usage.ambiguousExecutions
          })}
        </p>
      )}
    </div>
  )
}
