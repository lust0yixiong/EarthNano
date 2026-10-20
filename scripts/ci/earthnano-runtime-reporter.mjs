/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { writeFileSync } from 'node:fs'

/** The pinned Vitest JSON reporter omits global errors. Retain those original outcomes in a
 * separate raw report, using the same reviewed observer for original and candidate sources. */
export default class EarthnanoRuntimeReporter {
  onTestRunEnd(_modules, unhandledErrors, reason) {
    if (!process.env.EARTHNANO_CI_RUNTIME_REPORT)
      throw new Error('Original runtime report destination is unavailable')
    writeFileSync(
      process.env.EARTHNANO_CI_RUNTIME_REPORT,
      JSON.stringify({ schemaVersion: 1, reason, unhandledErrors }, null, 2) + '\n'
    )
  }
}
