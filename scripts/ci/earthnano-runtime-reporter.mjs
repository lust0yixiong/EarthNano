/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { writeFileSync } from 'node:fs'

// Match Vitest 4.1.11 getTests' read-only traversal without resolving packages beside this file.
// Baseline dependencies live in a sibling checkout; the observer itself has no node_modules.
const getTests = (tasks) =>
  tasks.flatMap((task) => (task.type === 'test' ? [task] : getTests(task.tasks)))

/** Keep actual runner outcomes and leaf/ancestor state beside the untouched Vitest JSON report.
 * The same observer runs against both the pinned original and the candidate source trees. */
export default class EarthnanoRuntimeReporter {
  onTestRunEnd(modules, unhandledErrors, reason) {
    if (!process.env.EARTHNANO_CI_RUNTIME_REPORT)
      throw new Error('Original runtime report destination is unavailable')
    const leaves = getTests(modules.map((module) => module.task)).map((task) => {
      const ancestors = []
      let parent = task.suite
      while (parent) {
        ancestors.push({
          name: parent.name,
          mode: parent.mode,
          hasResult: parent.result !== undefined,
          resultState: parent.result?.state ?? null
        })
        parent = parent.suite
      }
      ancestors.reverse()
      const names = ancestors.map((ancestor) => ancestor.name)
      return {
        file: task.file.filepath,
        name: task.name,
        fullName: task.name ? [...names, task.name].join(' ') : names.join(' '),
        mode: task.mode,
        hasResult: task.result !== undefined,
        resultState: task.result?.state ?? null,
        ancestors
      }
    })
    writeFileSync(
      process.env.EARTHNANO_CI_RUNTIME_REPORT,
      JSON.stringify(
        { schemaVersion: 1, reason, unhandledErrors, taskInventory: { schemaVersion: 1, leaves } },
        null,
        2
      ) + '\n'
    )
  }
}
