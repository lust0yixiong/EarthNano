import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import type { OptimizationProgress } from '../src/shared/earthnano/desktop-optimization'
import { test } from './fixtures/electron-app'
import { createProject, openProjectSession } from './certification/helpers'
import { createEarthnanoMessagesProvider } from './fixtures/earthnano-messages-provider'

const live = process.env.EARTHNANO_LIVE_DEEPSEEK === '1'
for (const trial of ['openscience-case16', 'harness2-ledger'] as const) {
  test(`runs bundled ${trial} through the original desktop owners`, async ({ app }, testInfo) => {
    test.skip(process.platform === 'win32', 'Windows remains deferred to 0.2-Alpha')
    test.skip(process.env.OPEN_SCIENCE_E2E_ISOLATE_HOME !== '1', 'Requires an isolated test home')
    test.setTimeout(900_000)
    const provider = await createEarthnanoMessagesProvider(live, true, false, { trialCase: trial })
    const report: Record<string, unknown> = { status: 'failed', trial, live }
    try {
      let page = await app.completeOnboarding()
      await page.evaluate(
        async ({ url, token }) => {
          const detected = await window.api.settings.detectClaude()
          if (!detected.found) throw new Error('Native Claude Code runtime required')
          const snapshot = await window.api.settings.upsertProvider({
            type: 'custom',
            name: 'EarthNano trial acceptance',
            apiEndpoints: ['messages'],
            baseUrl: url,
            key: token,
            model: 'deepseek-flash'
          })
          const provider = snapshot.providers.find(
            (entry) => entry.name === 'EarthNano trial acceptance'
          )!
          await window.api.settings.setActiveProvider({ id: provider.id, model: 'deepseek-flash' })
          await window.api.settings.setAgentFramework({ id: 'claude-code' })
          await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
          await window.api.settings.setDefaultPermissionProfile({ profile: 'ask' })
        },
        { url: provider.url, token: provider.token }
      )
      const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
        encoding: 'utf8'
      }).trim()
      await page.evaluate(async (path) => {
        await window.api.runtime.registerInterpreter('python', path)
        const environments = await window.api.runtime.listEnvironments()
        const entry = environments.python.find(
          (item) => item.envId === path || item.interpreterPath === path
        )
        if (!entry) throw new Error('Registered Python unavailable')
        await window.api.runtime.setEnvironmentEnabled('python', entry.envId, true)
      }, python)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.addLocatorHandler(page.getByTestId('permission-card'), async (card) => {
        await card.getByTestId('allow-primary').click()
      })
      const projectId = await createProject(page, 'EarthNano trial examples')
      await page.getByTestId('upstream-trials').locator('summary').click()
      await page.getByTestId(`trial-${trial}`).click()
      const prompt = await readFile(`resources/trials/${trial}/prompt.md`, 'utf8')
      await expect(page.getByRole('textbox', { name: 'Ask anything' })).toHaveText(prompt.trim())
      expect(provider.stats.requests).toBe(0)
      const before = await page.evaluate(
        async () => (await window.api.sessions.loadAll()).sessions.length
      )
      expect(before).toBe(0)
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled({
        timeout: 30_000
      })
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const loadSource = async (): Promise<PersistedChatSession | undefined> =>
        page.evaluate(
          async ({ projectId, prompt }) =>
            (await window.api.sessions.loadAll()).sessions.find(
              (entry) =>
                entry.projectId === projectId &&
                entry.messages.some(
                  (message) => message.role === 'user' && message.content.trim() === prompt.trim()
                )
            ),
          { projectId, prompt }
        )
      const names =
        trial === 'openscience-case16'
          ? ['trial_calculations.csv', 'availability_summary.csv']
          : ['ledger-results.json']
      await expect
        .poll(async () => (await loadSource())?.artifacts?.length, { timeout: 240_000 })
        .toBe(names.length)
      const source = (await loadSource())!
      const user = source.messages.find((message) => message.role === 'user')!
      expect(user.uploads).toHaveLength(2)
      const runs = await app.readNotebookFixtureRuns(projectId, source.id)
      expect(runs.some((run) => run.kernelKind === 'python' && run.status === 'completed')).toBe(
        true
      )
      report.notebookRuns = runs.map((run) => ({ id: run.runId, status: run.status }))
      const published: object[] = []
      for (const name of names) {
        const artifact = source.artifacts!.find((entry) => entry.name === name)!
        const provenance = await page.evaluate(
          (request) => window.api.artifacts.getVersionProvenance(request),
          {
            projectId,
            appSessionId: source.id,
            artifactId: artifact.artifactId!,
            versionId: artifact.versionId!
          }
        )
        expect(provenance).toMatchObject({
          contentStatus: { state: 'available' },
          evidence: { producer: { state: 'available', producer_run_id: expect.any(String) } }
        })
        const path = artifact.path
        const bytes = await readFile(path)
        if (trial === 'openscience-case16')
          expect(bytes.equals(await readFile(`resources/trials/openscience-case16/${name}`))).toBe(
            true
          )
        else
          expect(JSON.parse(bytes.toString())).toEqual({
            'ledger-1': { count: 3, total: '85.15' },
            'ledger-2': { count: 3, total: '20.25' }
          })
        published.push({
          name,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          artifactId: artifact.artifactId,
          versionId: artifact.versionId
        })
      }
      report.artifacts = published
      if (trial === 'harness2-ledger') {
        await page.removeLocatorHandler(page.getByTestId('permission-card'))
        const panel = page.getByTestId('task-optimization-panel')
        await panel.locator('summary').click()
        await panel.getByLabel('Repeat this task with Notebook', { exact: true }).check()
        await panel.getByLabel('Notebook runtime', { exact: true }).selectOption('python')
        await expect(panel.getByLabel('Task description', { exact: true })).toHaveValue(
          prompt.trim()
        )
        await expect(panel.getByLabel('Task description', { exact: true })).toBeDisabled()
        await panel
          .getByLabel('Acceptance criteria (one per line)', { exact: true })
          .fill(
            'Both signed ledgers are summed with Decimal, including every positive and negative value; each has three source observations.'
          )
        await panel.getByLabel('Check expected JSON output', { exact: true }).check()
        await panel.getByLabel('Output JSON file', { exact: true }).fill('ledger-results.json')
        await panel
          .getByLabel('Expected JSON value', { exact: true })
          .fill(
            JSON.stringify({
              'ledger-1': { count: 3, total: '85.15' },
              'ledger-2': { count: 3, total: '20.25' }
            })
          )
        await panel.getByLabel('Optimization mode', { exact: true }).selectOption('sequential')
        await panel.getByLabel('Recursion parameter (k)', { exact: true }).fill('1')
        await panel
          .getByLabel('Execution limit (includes two assessments)', { exact: true })
          .fill('20')
        await panel.getByRole('button', { name: 'Preview task stream', exact: true }).click()
        await expect(panel.getByTestId('optimization-sweep-preview')).toBeVisible()
        await panel.getByRole('button', { name: 'Start optimization', exact: true }).click()
        const latest = async (): Promise<OptimizationProgress | null> =>
          page.evaluate((request) => window.api.optimization.latest(request), {
            projectId,
            sourceSessionId: source.id
          })
        await expect
          .poll(async () => (await latest())?.state, { timeout: 600_000 })
          .toBe('completed')
        const completed = (await latest())!
        expect(completed.error).toBeUndefined()
        expect(
          completed.executions.some(
            (entry) => entry.role === 'baseline' && entry.phase === 'completed'
          )
        ).toBe(true)
        expect(
          completed.executions.some(
            (entry) => entry.role === 'candidate' && entry.phase === 'completed'
          )
        ).toBe(true)
        const summaries = completed.sweep!.domains.flatMap((domain) => domain.summary.tasks)
        expect(summaries).toHaveLength(1)
        expect(summaries[0].assessments?.baseline).toBeDefined()
        expect(summaries[0].assessments?.candidate).toBeDefined()
        report.optimization = completed
      }
      const requestsBeforeRestart = provider.stats.requests
      page = await app.restart()
      await openProjectSession(page, projectId, source.id)
      expect(provider.stats.requests).toBe(requestsBeforeRestart)
      expect((await loadSource())?.artifacts).toHaveLength(names.length)
      report.status = 'passed'
    } finally {
      report.provider = provider.stats
      await writeFile(testInfo.outputPath('upstream-trial.json'), JSON.stringify(report, null, 2))
      await provider.close()
    }
  })
}
