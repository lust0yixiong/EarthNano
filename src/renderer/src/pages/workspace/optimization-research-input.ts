import {
  normalizeOutputChecks,
  type OutputCheckSpec
} from '../../../../shared/earthnano/research-outcome'

export interface JsonCheckDraft {
  enabled: boolean
  path: string
  pointer: string
  expected: string
}
export const emptyJsonCheckDraft = (): JsonCheckDraft => ({
  enabled: false,
  path: 'result.json',
  pointer: '',
  expected: ''
})
export function draftOutputChecks(draft: JsonCheckDraft): OutputCheckSpec[] | undefined {
  if (!draft.enabled) return undefined
  return normalizeOutputChecks([
    {
      kind: 'json-value',
      path: draft.path,
      pointer: draft.pointer,
      expected: JSON.parse(draft.expected)
    }
  ])
}
