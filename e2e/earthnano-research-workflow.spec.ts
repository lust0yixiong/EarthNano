import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import type { ExecutionState } from '../src/main/earthnano/execution-core'
import { test } from './fixtures/electron-app'
import { createProject, openProjectSession } from './certification/helpers'
import { submitPromptViaUi } from './fixtures/conversation'
import { createEarthnanoMessagesProvider } from './fixtures/earthnano-messages-provider'

const live = process.env.EARTHNANO_LIVE_DEEPSEEK === '1'
test('accepts a scientific desktop workflow through Notebook, fixed versions, original Harness selection and independent Reviews', async ({
  app
}, testInfo) => {
  test.skip(process.platform === 'win32', 'The current optimization profile supports POSIX hosts')
  test.skip(
    process.env.OPEN_SCIENCE_E2E_ISOLATE_HOME !== '1',
    'Native scientific acceptance requires an explicitly isolated test home'
  )
  test.setTimeout(900_000)
  const provider = await createEarthnanoMessagesProvider(live)
  let report: object = { status: 'failed', live }
  let acceptancePassed = false
  let runtime: object = {}
  try {
    let page = await app.completeOnboarding()
    page.setDefaultTimeout(30_000)
    console.info('Scientific workflow: configuring native Claude')
    const claudeVersion = await page.evaluate(
      async ({ url, token }) => {
        const detected = await window.api.settings.detectClaude()
        if (!detected.found)
          throw new Error('Install a supported Claude Code runtime before this acceptance test')
        const snapshot = await window.api.settings.upsertProvider({
          type: 'custom',
          name: 'Bounded EarthNano acceptance',
          apiEndpoints: ['messages'],
          baseUrl: url,
          key: token,
          model: 'deepseek-flash'
        })
        const selected = snapshot.providers.find(
          (provider) => provider.name === 'Bounded EarthNano acceptance'
        )!
        await window.api.settings.setActiveProvider({ id: selected.id, model: 'deepseek-flash' })
        await window.api.settings.setAgentFramework({ id: 'claude-code' })
        await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
        await window.api.settings.setDefaultPermissionProfile({ profile: 'ask' })
        return detected.version
      },
      { url: provider.url, token: provider.token }
    )
    runtime = {
      electron: await page.evaluate(() => /Electron\/([^ ]+)/.exec(navigator.userAgent)?.[1]),
      claude: claudeVersion,
      nodeRunner: process.version,
      model: 'deepseek-flash'
    }
    const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8'
    }).trim()
    await page.evaluate(async (path) => {
      await window.api.runtime.registerInterpreter('python', path)
      const environments = await window.api.runtime.listEnvironments()
      const entry = environments.python.find(
        (entry) => entry.envId === path || entry.interpreterPath === path
      )
      if (!entry) throw new Error('Scientific Python interpreter missing')
      await window.api.runtime.setEnvironmentEnabled('python', entry.envId, true)
    }, python)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.addLocatorHandler(page.getByTestId('permission-card'), async (card) => {
      await card.getByTestId('allow-primary').click()
    })
    const projectId = await createProject(page, 'EarthNano scientific workflow')
    await page.locator('input[type="file"][multiple]').setInputFiles({
      name: 'measurements.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('sample,value\nA,2\nB,4\nC,6\n')
    })
    const prompt =
      'Analyze the attached measurements.csv with the Notebook Python tools. List runtimes and bind the enabled external Python runtime. Read the uploaded CSV, calculate row count, sum and arithmetic mean using Python csv and statistics. Save research-results.json with numeric keys count, sum, mean. Publish this exact local file using write_artifact_file with the Notebook producerRunId. Do not use native Bash or native Write, and do not create extra artifacts. After successful publication reply: Research analysis complete.'
    await submitPromptViaUi(page, prompt)
    await expect(
      page
        .getByRole('region', { name: 'Conversation' })
        .getByText('Research analysis complete.', { exact: true })
    ).toBeVisible({ timeout: 180_000 })
    console.info('Scientific workflow: ordinary reply received')
    const loadSource = async (): Promise<PersistedChatSession | undefined> =>
      page.evaluate(
        async ({ projectId, prompt }) =>
          (await window.api.sessions.loadAll()).sessions.find(
            (session) =>
              session.projectId === projectId &&
              session.messages.some(
                (message) => message.role === 'user' && message.content === prompt
              )
          ),
        { projectId, prompt }
      )
    await expect
      .poll(async () => (await loadSource())?.artifacts?.length, { timeout: 30_000 })
      .toBe(1)
    const source = (await loadSource())!,
      artifact = source.artifacts![0]
    expect(artifact).toMatchObject({
      name: 'research-results.json',
      artifactId: expect.any(String),
      versionId: expect.any(String),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    console.info('Scientific workflow: fixed source Session loaded')
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
    console.info('Scientific workflow: producer verified')
    const notebookRuns = await app.readNotebookFixtureRuns(projectId, source.id)
    expect(
      notebookRuns.some(
        (run) =>
          run.kernelKind === 'python' &&
          run.status === 'completed' &&
          run.script.includes('statistics') &&
          run.inputFiles?.some((file) => file.filename === 'measurements.csv')
      )
    ).toBe(true)
    console.info('Scientific workflow: Notebook verified')
    const dataRoot = await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)
    const readOrdinary = async (): Promise<ExecutionState[]> => {
      const root = join(dataRoot, 'executions', 'session-attempts'),
        states: ExecutionState[] = []
      for (const generation of await readdir(root))
        for (const name of await readdir(join(root, generation)))
          if (name.endsWith('.json')) {
            const state = JSON.parse(
              await readFile(join(root, generation, name), 'utf8')
            ) as ExecutionState
            states.push(state)
          }
      return states
    }
    await expect
      .poll(
        async () =>
          (await readOrdinary())
            .flatMap((state) => Object.values(state.records))
            .map((record) => ({
              phase: record.phase,
              cleanup: record.cleanup,
              artifacts: record.evidence.artifacts.length
            })),
        { timeout: 30_000 }
      )
      .toEqual([{ phase: 'completed', cleanup: 'confirmed', artifacts: 1 }])
    console.info('Scientific workflow: ordinary Core verified')
    const panel = page.getByTestId('task-optimization-panel')
    await panel.locator('summary').click()
    console.info('Scientific workflow: optimization panel open')
    await panel.getByLabel('research-results.json · version 1', { exact: true }).check()
    await panel
      .getByLabel('Task description', { exact: true })
      .fill(
        'Read research-results.json from the frozen input. Check count, sum and mean for arithmetic consistency and write result.json preserving these three numeric values. Do not invent or alter observations. The output must contain exactly count, sum, mean.'
      )
    await panel
      .getByLabel('Acceptance criteria (one per line)', { exact: true })
      .fill(
        'The output faithfully preserves the fixed source report and satisfies mean = sum / count.'
      )
    await panel.getByLabel('Check expected JSON output', { exact: true }).check()
    await panel.getByLabel('Output JSON file', { exact: true }).fill('result.json')
    await panel
      .getByLabel('Expected JSON value', { exact: true })
      .fill('{"count":3,"sum":12,"mean":4}')
    await panel.getByLabel('Optimization mode', { exact: true }).selectOption('parallel')
    await panel.getByLabel('Recursion parameter (k)', { exact: true }).fill('2')
    await panel.getByLabel('Concurrent executions', { exact: true }).fill('2')
    await panel.getByLabel('Execution limit (includes two assessments)', { exact: true }).fill('20')
    await panel.getByRole('button', { name: 'Start optimization', exact: true }).click()
    console.info('Scientific workflow: optimization submitted')
    const latest = async (): Promise<
      import('../src/shared/earthnano/desktop-optimization').OptimizationProgress | null
    > =>
      page.evaluate((request) => window.api.optimization.latest(request), {
        projectId,
        sourceSessionId: source.id
      })
    await expect
      .poll(async () => (await latest())?.state, { timeout: 600_000, intervals: [1000, 2000] })
      .toMatch(/^(completed|failed|cancelled|interrupted)$/)
    const completed = (await latest())!
    report = {
      status: 'incomplete',
      optimizationState: completed.state,
      live,
      progress: completed,
      sourceArtifact: {
        artifactId: artifact.artifactId,
        versionId: artifact.versionId,
        checksum: artifact.sha256
      },
      notebookRuns: notebookRuns.map((run) => ({
        runId: run.runId,
        kernelKind: run.kernelKind,
        status: run.status
      }))
    }
    expect(completed.error).toBeUndefined()
    expect(completed.state).toBe('completed')
    expect(completed.selection).toMatchObject({ trivial: false, candidateCount: 2 })
    expect(completed.outcome?.artifact.status).toBe('passed')
    expect(completed.outcome?.configuration.status).toBe('eligible')
    expect(completed.inputArtifacts).toEqual([
      {
        artifactId: artifact.artifactId,
        versionId: artifact.versionId,
        checksum: artifact.sha256,
        path: artifact.name
      }
    ])
    expect(completed.budget.admitted).toBeLessThanOrEqual(20)
    expect(completed.budget.active).toBe(0)
    const methodJournal = JSON.parse(
      await readFile(
        join(dataRoot, 'earthnano', 'desktop-runs', completed.runId, 'execution', 'execution.json'),
        'utf8'
      )
    ) as ExecutionState
    expect(Object.keys(methodJournal.records).sort()).toEqual(
      completed.executions.map((execution) => execution.executionId).sort()
    )
    for (const record of Object.values(methodJournal.records)) {
      expect(record).toMatchObject({ phase: 'completed', cleanup: 'confirmed' })
      expect(
        methodJournal.events[record.executionId].filter(
          (event) => event.type === 'session-admitted'
        )
      ).toHaveLength(1)
      expect(
        methodJournal.events[record.executionId].filter(
          (event) => event.type === 'provider-accepted'
        )
      ).toHaveLength(1)
    }
    // Inherited candidate scopes must not be charged or journaled again by ordinary Send.
    expect((await readOrdinary()).flatMap((state) => Object.values(state.records))).toHaveLength(1)
    const candidate = completed.executions.find(
      (execution) => execution.executionId === completed.assessments!.candidate.targetExecutionId
    )!
    const reviews = await page.evaluate((request) => window.api.reviewer.getForSession(request), {
      projectId,
      appSessionId: candidate.sessionId!
    })
    expect(
      reviews.some(
        (review) =>
          review.id === completed.assessments!.candidate.reviewId &&
          review.lifecycle === 'complete' &&
          review.outcome === 'pass'
      )
    ).toBe(true)
    const manifest = JSON.parse(
      await readFile(
        join(
          dataRoot,
          'earthnano',
          'desktop-runs',
          completed.runId,
          'execution',
          'input-artifacts.json'
        ),
        'utf8'
      )
    )
    expect(manifest).toMatchObject({
      projectId,
      sourceSessionId: source.id,
      artifacts: completed.inputArtifacts
    })
    await page.screenshot({ path: testInfo.outputPath('scientific-workflow.png') })
    const requestCount = provider.stats.requests
    page = await app.restart()
    // Candidate Sessions remain inspectable in the original project. Their newer timestamps may
    // fill Home's five recent rows, so reopen the scientific source through its project.
    await openProjectSession(page, 'EarthNano scientific workflow', prompt)
    expect(await latest()).toEqual(completed)
    expect((await loadSource())?.artifacts).toEqual(source.artifacts)
    const reopenedReviews = await page.evaluate(
      (request) => window.api.reviewer.getForSession(request),
      { projectId, appSessionId: candidate.sessionId! }
    )
    expect(reopenedReviews).toEqual(reviews)
    expect(provider.stats.requests).toBe(requestCount)
    report = {
      ...report,
      reopened: true,
      noPaidReplay: true,
      sourceProducerVerified: true,
      ordinaryCoreVerified: true,
      independentReviewsReopened: true
    }
    expect(provider.stats.rejected).toBe(0)
    acceptancePassed = true
  } finally {
    const result = {
      ...report,
      status: acceptancePassed ? 'passed' : 'failed',
      acceptancePassed,
      provider: provider.stats,
      bounds: {
        apiRequests: 120,
        maxOutputTokensPerRequest: 2048,
        upstreamDeadlineMs: 90_000,
        optimizationExecutions: 20
      },
      runtime: { ...runtime, backend: 'native Claude Code' }
    }
    await writeFile(testInfo.outputPath('research-workflow.json'), JSON.stringify(result, null, 2))
    if (live && process.env.EARTHNANO_LIVE_RESEARCH_REPORT)
      await writeFile(process.env.EARTHNANO_LIVE_RESEARCH_REPORT, JSON.stringify(result, null, 2))
    await provider.close()
  }
})
