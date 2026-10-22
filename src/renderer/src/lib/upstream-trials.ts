import case16Script from '../../../../resources/trials/openscience-case16/analysis.py?raw'
import case16Source from '../../../../resources/trials/openscience-case16/registry_source.json?raw'
import case16Prompt from '../../../../resources/trials/openscience-case16/prompt.md?raw'
import ledger1 from '../../../../resources/trials/harness2-ledger/ledger-1.csv?raw'
import ledger2 from '../../../../resources/trials/harness2-ledger/ledger-2.csv?raw'
import ledgerPrompt from '../../../../resources/trials/harness2-ledger/prompt.md?raw'

export type UpstreamTrialId = 'openscience-case16' | 'harness2-ledger'

// These are ordinary composer inputs. Session creation, managed uploads, Notebook execution,
// artifacts, Reviews and optimization keep their existing owners; choosing a case never sends it.
export const upstreamTrials = {
  'openscience-case16': {
    prompt: case16Prompt,
    source:
      'https://huggingface.co/datasets/AIPOCH-AI/case-validation/tree/5a775981cc7142651116960b0b96501088670c98/releases/2026-10-13-deidentified/case16',
    files: [
      { name: 'analysis.py', type: 'text/x-python', content: case16Script },
      { name: 'registry_source.json', type: 'application/json', content: case16Source }
    ]
  },
  'harness2-ledger': {
    prompt: ledgerPrompt,
    source:
      'https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/demo.py',
    files: [
      { name: 'ledger-1.csv', type: 'text/csv', content: ledger1 },
      { name: 'ledger-2.csv', type: 'text/csv', content: ledger2 }
    ]
  }
} as const

export const upstreamTrialFiles = (id: UpstreamTrialId): File[] =>
  upstreamTrials[id].files.map(({ name, type, content }) => new File([content], name, { type }))
