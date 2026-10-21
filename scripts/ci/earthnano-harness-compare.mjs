/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareInventories, HARNESS_PIN, HARNESS_TREE } from './earthnano-source.mjs'

export function compareHarnessReports(baseline, candidate) {
  for (const [kind, report] of [
    ['baseline', baseline],
    ['candidate', candidate]
  ]) {
    if (
      !report ||
      report.schemaVersion !== 1 ||
      report.unavailable ||
      report.pins?.harness !== HARNESS_PIN ||
      report.pins?.tree !== HARNESS_TREE ||
      !Array.isArray(report.tests) ||
      !report.tests.length ||
      report.testsRun !== report.tests.length ||
      !Array.isArray(report.collectionErrors) ||
      report.collectionErrors.length ||
      report.tests.some(
        (test) =>
          !test ||
          typeof test.id !== 'string' ||
          !test.id ||
          !['passed', 'failed', 'skipped'].includes(test.status) ||
          test.id.startsWith('unittest.loader._FailedTest.') ||
          /^(setUp|tearDown)(Class|Module)\b/u.test(test.id)
      ) ||
      report.source?.kind !== kind ||
      !/^[a-f0-9]{40}$/u.test(report.source?.commit) ||
      !/^[a-f0-9]{40}$/u.test(report.source?.tree) ||
      !/^[a-f0-9]{64}$/u.test(report.source?.digest) ||
      !/^[a-f0-9]{64}$/u.test(report.source?.licenseDigest) ||
      report.source.scope !== (kind === 'baseline' ? '.' : 'vendor/harness2') ||
      !/^3\.(12|13)\./u.test(report.python) ||
      !['darwin', 'linux', 'win32'].includes(report.platform) ||
      ['python', 'executable', 'arch', 'platform'].some(
        (key) => typeof report[key] !== 'string' || !report[key]
      )
    )
      throw new Error('Incomplete, unpinned or malformed Harness environment/inventory')
  }
  if (
    baseline.source.commit !== HARNESS_PIN ||
    baseline.source.tree !== HARNESS_TREE ||
    ['python', 'executable', 'arch', 'platform'].some((key) => baseline[key] !== candidate[key]) ||
    baseline.source.licenseDigest !== candidate.source.licenseDigest
  )
    throw new Error('Unmatched Harness original pin/environment/license')
  return compareInventories(baseline.tests, candidate.tests)
}

async function main() {
  const baseline = JSON.parse(await readFile('test-results/harness-baseline.json', 'utf8'))
  const candidate = JSON.parse(await readFile('test-results/harness-candidate.json', 'utf8'))
  const comparison = compareHarnessReports(baseline, candidate)
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
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
