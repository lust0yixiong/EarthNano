import { expect } from '@playwright/test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExecutionState } from '../src/main/earthnano/execution-core'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'
import { sendPrompt } from './certification/helpers'

// Real desktop/preload/IPC composition. The ordinary conversation uses the offline ACP fixture;
// optimization must explicitly reject its unsupported OpenCode backend before any paid call.
test('exposes Session task optimization on the desktop and rejects unsupported model routes safely', async ({
  app
}, testInfo) => {
  test.skip(process.platform === 'win32', 'The isolated Claude profile supports POSIX hosts only')
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProjectViaUi(page, 'Desktop optimization validation')
  const prompt = 'Synthetic task for desktop optimization validation'
  await sendPrompt(page, prompt, 'Deterministic reply:')
  const dataRoot = await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)
  // The real renderer Send must enter Core, not just reach the old physical backend path.
  await expect
    .poll(
      async () => {
        const directory = join(dataRoot, 'executions', 'session-attempts')
        let generations: string[]
        try {
          generations = await readdir(directory)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
          throw error
        }
        const matched: object[] = []
        for (const generation of generations) {
          for (const file of await readdir(join(directory, generation))) {
            if (!file.endsWith('.json')) continue
            const state = JSON.parse(
              await readFile(join(directory, generation, file), 'utf8')
            ) as ExecutionState
            for (const record of Object.values(state.records)) {
              if (!record.evidence.text.includes('Deterministic reply:')) continue
              matched.push({
                phase: record.phase,
                cleanup: record.cleanup,
                role: record.request.role,
                admitted: Object.values(state.budgets).reduce(
                  (sum, budget) => sum + budget.admitted,
                  0
                ),
                sessionAdmissions: state.events[record.executionId].filter(
                  (event) => event.type === 'session-admitted'
                ).length,
                providerAcceptances: state.events[record.executionId].filter(
                  (event) => event.type === 'provider-accepted'
                ).length
              })
            }
          }
        }
        return matched
      },
      { timeout: 30_000 }
    )
    .toEqual([
      {
        phase: 'completed',
        cleanup: 'confirmed',
        role: 'task',
        admitted: 1,
        sessionAdmissions: 1,
        providerAcceptances: 1
      }
    ])
  const panel = page.getByTestId('task-optimization-panel')
  await expect(panel).toBeVisible()
  await panel.locator('summary').click()
  await expect(panel.getByLabel('Task description', { exact: true })).toHaveValue(prompt)
  await expect(
    panel.getByLabel('Execution limit (includes two assessments)', { exact: true })
  ).toHaveValue('12')
  expect(
    await page.evaluate(() =>
      (['start', 'get', 'latest', 'stop'] as const).every(
        (name) => typeof window.api.optimization[name] === 'function'
      )
    )
  ).toBe(true)
  await panel
    .getByLabel('Acceptance criteria (one per line)', { exact: true })
    .fill('The result contains the requested synthetic output.')
  await panel.getByRole('button', { name: 'Start optimization', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('Failed')
  await expect(panel.getByRole('alert')).toContainText(
    'Check the selected model and runtime settings.'
  )
  await expect(panel.getByRole('status')).toContainText('Used 0 of 12 executions')
  await page.screenshot({
    path: testInfo.outputPath('desktop-optimization-safe-route-rejection.png')
  })
})
