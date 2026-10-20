import { readFile, writeFile } from 'node:fs/promises'
import { compareInventories } from './earthnano-source.mjs'
const baseline = JSON.parse(await readFile('test-results/harness-baseline.json', 'utf8'))
const candidate = JSON.parse(await readFile('test-results/harness-candidate.json', 'utf8'))
if (
  baseline.python !== candidate.python ||
  baseline.platform !== candidate.platform ||
  !baseline.tests?.length ||
  !candidate.tests?.length ||
  baseline.testsRun !== baseline.tests.length ||
  candidate.testsRun !== candidate.tests.length
)
  throw new Error('Incomplete or unmatched Harness environment/inventory')
const comparison = compareInventories(baseline.tests, candidate.tests)
await writeFile(
  'test-results/harness-comparison.json',
  JSON.stringify({ schemaVersion: 1, python: baseline.python, ...comparison }, null, 2) + '\n'
)
if (process.env.GITHUB_STEP_SUMMARY)
  await writeFile(
    process.env.GITHUB_STEP_SUMMARY,
    `\nHarness original comparison: ${comparison.conclusion}; baseline failures ${comparison.baselineFailures.length}, skips ${comparison.baselineSkips.length}; candidate failures ${comparison.candidateFailures.length}, skips ${comparison.candidateSkips.length}. This is offline algorithm/equivalence evidence, not model quality evidence.\n`,
    { flag: 'a' }
  )
if (comparison.regressions.length)
  throw new Error('New Harness regressions; inspect the complete inventories')
