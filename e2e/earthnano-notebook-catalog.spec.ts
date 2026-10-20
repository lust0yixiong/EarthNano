import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { isArtifactNotebookProducer } from '../src/shared/artifact-provenance'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import type { OptimizationProgress } from '../src/shared/earthnano/desktop-optimization'
import type { ExecutionState } from '../src/main/earthnano/execution-core'
import type { PersistentOptimizationResume } from '../src/main/earthnano/optimization-resume'
import { test } from './fixtures/electron-app'
import { createProject, openProjectSession } from './certification/helpers'
import { submitPromptViaUi } from './fixtures/conversation'
import { createEarthnanoMessagesProvider } from './fixtures/earthnano-messages-provider'

const live = process.env.EARTHNANO_LIVE_DEEPSEEK === '1'
const bounds = { coreAdmissions: 48, modelRequests: 320, maxOutputTokens: 2048 }
const projectName = 'EarthNano independent Notebook sources'

test('runs two independent Notebook sources through one original sweep and resumes without source crossover', async ({
  app
}, testInfo) => {
  test.skip(process.platform === 'win32', 'The current optimization profile supports POSIX hosts')
  test.skip(
    process.env.OPEN_SCIENCE_E2E_ISOLATE_HOME !== '1',
    'Requires an explicitly isolated test home'
  )
  test.setTimeout(900_000)
  const provider = await createEarthnanoMessagesProvider(live, true, true, {
    maxModelRequests: bounds.modelRequests
  })
  let page = await app.completeOnboarding()
  let dataRoot: string | undefined
  let projectId: string | undefined
  const report: Record<string, unknown> = { status: 'failed', live, bounds }
  try {
    report.runtime = {
      source: {
        head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).length > 0
      },
      bundles: Object.fromEntries(
        await Promise.all(
          [
            'out/backend/index.cjs',
            'out/main/index.js',
            'out/preload/index.js',
            'out/renderer/index.html'
          ].map(async (path) => [
            path,
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex')
          ])
        )
      ),
      electron: await page.evaluate(() => /Electron\/([^ ]+)/.exec(navigator.userAgent)?.[1]),
      nodeRunner: process.version,
      claude: await page.evaluate(
        async ({ url, token }) => {
          const detected = await window.api.settings.detectClaude()
          if (!detected.found) throw new Error('Supported Claude Code runtime required')
          const snapshot = await window.api.settings.upsertProvider({
            type: 'custom',
            name: 'Bounded catalog acceptance',
            apiEndpoints: ['messages'],
            baseUrl: url,
            key: token,
            model: 'deepseek-flash'
          })
          const selected = snapshot.providers.find(
            (entry) => entry.name === 'Bounded catalog acceptance'
          )!
          await window.api.settings.setActiveProvider({ id: selected.id, model: 'deepseek-flash' })
          await window.api.settings.setAgentFramework({ id: 'claude-code' })
          await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
          await window.api.settings.setDefaultPermissionProfile({ profile: 'ask' })
          return detected.version
        },
        { url: provider.url, token: provider.token }
      ),
      model: 'deepseek-flash'
    }
    const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8'
    }).trim()
    await page.evaluate(async (path) => {
      await window.api.runtime.registerInterpreter('python', path)
      const entry = (await window.api.runtime.listEnvironments()).python.find(
        (entry) => entry.envId === path || entry.interpreterPath === path
      )
      if (!entry) throw new Error('Enabled external Python required')
      await window.api.runtime.setEnvironmentEnabled('python', entry.envId, true)
    }, python)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.addLocatorHandler(page.getByTestId('permission-card'), async (card) => {
      await card.getByTestId('allow-primary').click()
    })
    projectId = await createProject(page, projectName)
    dataRoot = (await page.evaluate(() => window.api.storage.getInfo())).dataRoot
    const datasets = [
      {
        name: 'Observation set A',
        csv: 'sample,value\nA,2\nB,4\nC,6\n',
        expected: { count: 3, sum: 12, mean: 4 }
      },
      {
        name: 'Observation set B',
        csv: 'sample,value\nX,10\nY,20\n',
        expected: { count: 2, sum: 30, mean: 15 }
      }
    ]
    const sources: Array<{
      session: PersistedChatSession
      prompt: string
      promptMessageId: string
      csv: string
      expected: { count: number; sum: number; mean: number }
    }> = []
    for (const [index, dataset] of datasets.entries()) {
      if (index) await page.getByRole('button', { name: 'New', exact: true }).click()
      await page.locator('input[type="file"][multiple]').setInputFiles({
        name: 'measurements.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(dataset.csv)
      })
      const prompt = `${dataset.name}: Analyze the attached measurements.csv using Notebook Python. List runtimes and bind the enabled external Python runtime. Use Python csv and statistics to calculate count, sum and arithmetic mean. Save numeric count, sum, mean in research-results.json. Publish this exact local file with write_artifact_file and the actual Notebook producerRunId. Do not use native Bash or native Write or create extra artifacts. After publication reply: Research analysis complete.`
      await submitPromptViaUi(page, prompt)
      await expect(
        page
          .getByRole('region', { name: 'Conversation' })
          .getByText('Research analysis complete.', { exact: true })
      ).toBeVisible({ timeout: 180_000 })
      const readSource = (): Promise<PersistedChatSession | undefined> =>
        page.evaluate(
          async ({ projectId, prompt }) =>
            (await window.api.sessions.loadAll()).sessions.find(
              (entry) =>
                entry.projectId === projectId &&
                entry.messages.some(
                  (message) => message.role === 'user' && message.content === prompt
                )
            ),
          { projectId: projectId!, prompt }
        )
      await expect.poll(async () => (await readSource())?.artifacts?.length).toBe(1)
      const session = (await readSource())!
      const message = session.messages.find(
        (message) => message.role === 'user' && message.content === prompt
      )!
      expect(message.uploads).toHaveLength(1)
      const state = await page.evaluate((request) => window.api.notebook.state(request), {
        projectId,
        sessionId: session.id,
        workspaceCwd: session.cwd ?? ''
      })
      expect(state.runtimeBindings?.python).toBeDefined()
      sources.push({
        session,
        prompt,
        promptMessageId: message.id,
        csv: dataset.csv,
        expected: dataset.expected
      })
    }
    expect(sources[0].session.id).not.toBe(sources[1].session.id)
    expect(
      sources[0].session.messages.find((entry) => entry.id === sources[0].promptMessageId)!
        .uploads![0].versionId
    ).not.toBe(
      sources[1].session.messages.find((entry) => entry.id === sources[1].promptMessageId)!
        .uploads![0].versionId
    )
    await page.removeLocatorHandler(page.getByTestId('permission-card'))
    const navigation = sources[1]
    const sourceByTask = new Map([
      ['task-0001', sources[1]],
      ['task-0002', sources[0]]
    ])
    const panel = page.getByTestId('task-optimization-panel')
    await panel.locator('summary').click()
    await panel.getByLabel('Repeat this task with Notebook Python', { exact: true }).check()
    await panel
      .getByLabel('Acceptance criteria (one per line)', { exact: true })
      .fill('The published numeric report matches this task’s fixed source observations.')
    await panel.getByLabel('Check expected JSON output', { exact: true }).check()
    await panel.getByLabel('Output JSON file', { exact: true }).fill('research-results.json')
    await panel
      .getByLabel('Expected JSON value', { exact: true })
      .fill(JSON.stringify(navigation.expected))
    await panel
      .getByRole('button', { name: 'Add Notebook task from another chat', exact: true })
      .click()
    const extra = panel.getByTestId('optimization-catalog-task-task-0002')
    await extra.getByLabel('Source chat', { exact: true }).selectOption(sources[0].session.id)
    await extra.getByLabel('Source task', { exact: true }).selectOption(sources[0].promptMessageId)
    await extra
      .getByLabel('Next task criteria 1', { exact: true })
      .fill('The published numeric report matches this task’s fixed source observations.')
    await extra.getByLabel('Check expected JSON output', { exact: true }).check()
    await extra.getByLabel('Output JSON file', { exact: true }).fill('research-results.json')
    await extra
      .getByLabel('Expected JSON value', { exact: true })
      .fill(JSON.stringify(sources[0].expected))
    await panel.getByLabel('Compare both optimization modes', { exact: true }).check()
    await panel.getByLabel('Recursion parameter (k)', { exact: true }).fill('1')
    await panel.getByLabel('Concurrent executions', { exact: true }).fill('2')
    await panel.getByLabel('Shuffle seed (empty uses original order)', { exact: true }).fill('0')
    await panel.getByLabel('Tasks per domain (empty means all)', { exact: true }).fill('2')
    await panel
      .getByLabel('Shared execution limit (all task assessments and reflections)', { exact: true })
      .fill(String(bounds.coreAdmissions))
    const callsBeforePreview = provider.stats.requests
    await panel.getByRole('button', { name: 'Preview task stream', exact: true }).click()
    await expect(panel.getByTestId('optimization-sweep-preview')).toContainText('36')
    expect(provider.stats.requests).toBe(callsBeforePreview)
    await panel.getByRole('button', { name: 'Start optimization', exact: true }).click()
    const latest = (): Promise<OptimizationProgress | null> =>
      page.evaluate((request) => window.api.optimization.latest(request), {
        projectId: projectId!,
        sourceSessionId: navigation.session.id
      })
    await expect.poll(() => provider.stats.pausedBeforeForward, { timeout: 180_000 }).toBe(1)
    const beforeStop = (await latest())!
    await panel.getByRole('button', { name: 'Stop optimization', exact: true }).click()
    await expect.poll(async () => (await latest())?.resumeAvailable, { timeout: 60_000 }).toBe(true)
    const stopped = (await latest())!
    const work = join(dataRoot, 'earthnano', 'desktop-runs', stopped.runId, 'execution')
    const stoppedJournal = JSON.parse(
      await readFile(join(work, 'execution.json'), 'utf8')
    ) as ExecutionState
    expect(
      Object.values(stoppedJournal.records).some(
        (record) => record.request.role === 'baseline' && record.phase === 'completed'
      )
    ).toBe(true)
    await writeFile(
      testInfo.outputPath('stopped-journal.json'),
      JSON.stringify(stoppedJournal, null, 2)
    )
    const callsBeforeReopen = provider.stats.requests
    page = await app.restart()
    await openProjectSession(page, projectName, navigation.prompt)
    expect(await latest()).toEqual(stopped)
    expect(provider.stats.requests).toBe(callsBeforeReopen)
    const reopenedPanel = page.getByTestId('task-optimization-panel')
    await reopenedPanel.locator('summary').click()
    await reopenedPanel.getByRole('button', { name: 'Resume optimization', exact: true }).click()
    await expect
      .poll(async () => (await latest())?.state, { timeout: 600_000, intervals: [1000, 2000] })
      .toMatch(/^(completed|failed|interrupted)$/)
    const completed = (await latest())!
    report.progress = completed
    expect(completed.error).toBeUndefined()
    expect(completed.state).toBe('completed')
    expect(completed.runId).toBe(beforeStop.runId)
    expect(completed.budget.limit).toBe(bounds.coreAdmissions)
    expect(completed.budget.admitted).toBeLessThanOrEqual(bounds.coreAdmissions)
    expect(completed.budget.active).toBe(0)
    const journal = JSON.parse(
      await readFile(join(work, 'execution.json'), 'utf8')
    ) as ExecutionState
    const manifest = JSON.parse(
      await readFile(join(work, 'resume.json'), 'utf8')
    ) as PersistentOptimizationResume
    const routing = JSON.parse(await readFile(join(work, 'request-tasks.json'), 'utf8')) as {
      schemaVersion: number
      entries: Record<string, { taskId: string; scope: string }>
    }
    expect(routing.schemaVersion).toBe(2)
    expect(manifest.identity.sweep!.request.sweep.stream.seed).toBe(0)
    expect(manifest.identity.sweep!.request.previewPlanDigest).toBe(completed.sweep!.planDigest)
    expect(manifest.identity.sweep!.plan.digest).toBe(completed.sweep!.planDigest)
    expect(completed.sweep!.order.flatMap((domain) => domain.taskIds).sort()).toEqual([
      'task-0001',
      'task-0002'
    ])
    expect(manifest.identity.sweep!.tasks).toHaveLength(2)
    const reviewerSources = new Map<string, string>()
    for (const [taskId, source] of sourceByTask) {
      const originalUpload = source.session.messages.find(
        (entry) => entry.id === source.promptMessageId
      )!.uploads![0]
      const frozen = manifest.identity.sweep!.tasks.find((task) => task.taskId === taskId)!
      expect(frozen.sourceSessionId).toBe(source.session.id)
      expect(frozen.sourcePromptMessageId).toBe(source.promptMessageId)
      expect(frozen.input.task.prompt).toBe(source.prompt)
      expect(frozen.input.task.managedInputs).toMatchObject([
        {
          sourceSessionId: source.session.id,
          inputFileVersionId: originalUpload.versionId,
          checksum: originalUpload.sha256
        }
      ])
      const tasks = completed.sweep!.domains.map(({ mode, summary }) => ({
        mode,
        task: summary.tasks.find((task) => task.taskId === taskId)!
      }))
      expect(tasks).toHaveLength(2)
      expect(tasks.every(({ task }) => task.outcome?.artifact.status === 'passed')).toBe(true)
      expect(new Set(tasks.map(({ task }) => task.assessments!.baseline.executionId)).size).toBe(1)
      expect(new Set(tasks.map(({ task }) => task.assessments!.candidate.executionId)).size).toBe(2)
      for (const { task } of tasks) {
        expect(task.assessments!.baseline.outcome).toBe('pass')
        expect(task.assessments!.candidate.outcome).toBe('pass')
        for (const assessment of [task.assessments!.baseline, task.assessments!.candidate]) {
          const prior = reviewerSources.get(assessment.executionId)
          expect(prior === undefined || prior === taskId).toBe(true)
          reviewerSources.set(assessment.executionId, taskId)
          const record = journal.records[assessment.executionId]
          const target = journal.records[assessment.targetExecutionId]
          const reviews = await page.evaluate(
            (request) => window.api.reviewer.getForSession(request),
            { projectId, appSessionId: target.identity.sessionId! }
          )
          expect(
            reviews.some(
              (review) => review.id === assessment.reviewId && review.lifecycle === 'complete'
            )
          ).toBe(true)
          const snapshot = JSON.parse(
            await readFile(
              join(
                work,
                'snapshots',
                'objects',
                `${record.request.taskSnapshotRef.digest.slice(7)}.json`
              ),
              'utf8'
            )
          )
          const evidence = JSON.parse(
            snapshot.value.files.find(
              (file: { path: string }) => file.path === 'evidence/sources.json'
            ).content
          )
          expect(evidence.inputs).toHaveLength(1)
          expect(evidence.inputs[0]).toMatchObject({
            status: 'available',
            content: source.csv,
            input: { inputFileVersionId: originalUpload.versionId, checksum: originalUpload.sha256 }
          })
        }
      }
      const scientific = Object.values(journal.records).filter(
        (record) =>
          ['baseline', 'candidate'].includes(record.request.role) &&
          record.phase === 'completed' &&
          routing.entries[record.requestKey]?.taskId === taskId
      )
      expect(scientific.filter((record) => record.request.role === 'baseline')).toHaveLength(1)
      expect(scientific.length).toBeGreaterThanOrEqual(3)
      expect(new Set(scientific.map((record) => record.request.taskSnapshotRef.digest)).size).toBe(
        1
      )
      expect(
        new Set(scientific.map((record) => record.request.environmentSpecRef.digest)).size
      ).toBe(1)
      for (const record of scientific) {
        const runs = await app.readNotebookFixtureRuns(projectId, record.identity.sessionId!)
        const computation = runs.find(
          (run) =>
            run.status === 'completed' &&
            run.kernelKind === 'python' &&
            run.script.includes('statistics') &&
            run.inputFiles?.some(
              (input) =>
                input.inputFileVersionId === originalUpload.versionId &&
                input.checksum === originalUpload.sha256
            )
        )
        expect(computation).toBeDefined()
        const otherUpload = [...sourceByTask]
          .find(([other]) => other !== taskId)![1]
          .session.messages.find((entry) => entry.role === 'user')!.uploads![0]
        expect(
          computation!.inputFiles!.some(
            (input) => input.inputFileVersionId === otherUpload.versionId
          )
        ).toBe(false)
        expect(record.evidence.artifacts).toHaveLength(1)
        const artifact = record.evidence.artifacts[0]
        const provenance = await page.evaluate(
          (request) => window.api.artifacts.getVersionProvenance(request),
          {
            projectId,
            appSessionId: record.identity.sessionId!,
            artifactId: artifact.artifactId,
            versionId: artifact.versionId
          }
        )
        expect(provenance).toMatchObject({
          contentStatus: { state: 'available' },
          evidence: { producer: { state: 'available', producer_run_id: expect.any(String) } }
        })
        if ('failure' in provenance || !isArtifactNotebookProducer(provenance.evidence.producer))
          throw new Error('Original Notebook producer receipt unavailable')
        const producerRunId = provenance.evidence.producer.producer_run_id
        const producingRun = runs.find((run) => run.runId === producerRunId)
        expect(producingRun?.status).toBe('completed')
        expect(producingRun?.kernelKind).toBe('python')
        expect(producingRun?.inputFiles).toMatchObject([
          { inputFileVersionId: originalUpload.versionId, checksum: originalUpload.sha256 }
        ])
      }
    }
    expect(reviewerSources.size).toBe(6)
    for (const record of Object.values(journal.records)) expect(record.cleanup).toBe('confirmed')
    for (const record of Object.values(stoppedJournal.records)) {
      expect(journal.records[record.executionId]).toEqual(record)
      expect(journal.events[record.executionId]).toEqual(stoppedJournal.events[record.executionId])
    }
    const snapshotsByTask = [...sourceByTask.keys()].map(
      (taskId) =>
        Object.values(journal.records).find(
          (record) =>
            record.request.role === 'baseline' &&
            record.phase === 'completed' &&
            routing.entries[record.requestKey]?.taskId === taskId
        )!.request.taskSnapshotRef.digest
    )
    expect(new Set(snapshotsByTask).size).toBe(2)
    const callsAfterComplete = provider.stats.requests
    page = await app.restart()
    await openProjectSession(page, projectName, navigation.prompt)
    expect(await latest()).toEqual(completed)
    expect(provider.stats.requests).toBe(callsAfterComplete)
    expect(provider.stats.rejected).toBe(0)
    report.status = 'passed'
    report.sources = [...sourceByTask].map(([taskId, source]) => ({
      taskId,
      sourceSessionId: source.session.id,
      promptMessageId: source.promptMessageId,
      expected: source.expected,
      csvSha256: createHash('sha256').update(source.csv).digest('hex')
    }))
    report.verified = {
      independentFrozenInputs: true,
      sameTaskWithinEachBaselineAndCandidates: true,
      sixIndependentReviewersWithPerTaskSharedBaseline: true,
      actualNotebookAndArtifactOwners: true,
      originalStoppedJournalPreserved: true,
      reopenWithoutPaidReplay: true
    }
  } finally {
    if (dataRoot) {
      try {
        const root = join(dataRoot, 'earthnano', 'desktop-runs')
        for (const runId of await readdir(root))
          for (const name of [
            'execution.json',
            'resume.json',
            'request-tasks.json',
            'failure-diagnostics.jsonl'
          ]) {
            try {
              await writeFile(
                testInfo.outputPath(`final-${runId}-${name}`),
                await readFile(join(root, runId, 'execution', name))
              )
            } catch {
              /* May fail before first Core admission. */
            }
          }
      } catch {
        /* Ordinary Send may fail before the experiment root exists. */
      }
    }
    if (projectId) {
      try {
        await writeFile(
          testInfo.outputPath('final-sessions.json'),
          JSON.stringify(
            await page.evaluate(
              async (id) =>
                (await window.api.sessions.loadAll()).sessions.filter(
                  (entry) => entry.projectId === id
                ),
              projectId
            ),
            null,
            2
          )
        )
      } catch {
        /* Preserve earlier failure even if renderer diagnostics are unavailable. */
      }
    }
    report.provider = provider.stats
    await writeFile(testInfo.outputPath('notebook-catalog.json'), JSON.stringify(report, null, 2))
    if (live && process.env.EARTHNANO_LIVE_CATALOG_REPORT)
      await writeFile(process.env.EARTHNANO_LIVE_CATALOG_REPORT, JSON.stringify(report, null, 2))
    await provider.close()
  }
})
