import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { isArtifactNotebookProducer } from '../src/shared/artifact-provenance'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import type { ExecutionState } from '../src/main/earthnano/execution-core'
import { test } from './fixtures/electron-app'
import { createProject, openProjectSession } from './certification/helpers'
import { submitPromptViaUi } from './fixtures/conversation'
import { createEarthnanoMessagesProvider } from './fixtures/earthnano-messages-provider'

const live = process.env.EARTHNANO_LIVE_DEEPSEEK === '1'
const resumeAcceptance = process.env.EARTHNANO_E2E_RESUME === '1'
const optimizationExecutions = live || resumeAcceptance ? 24 : 20
test('runs the identical scientific task in ordinary Send and isolated Harness baseline/candidates through the original Notebook owners', async ({
  app
}, testInfo) => {
  test.skip(process.platform === 'win32', 'The current optimization profile supports POSIX hosts')
  test.skip(
    process.env.OPEN_SCIENCE_E2E_ISOLATE_HOME !== '1',
    'Native scientific acceptance requires an explicitly isolated test home'
  )
  test.setTimeout(900_000)
  const provider = await createEarthnanoMessagesProvider(live, true, resumeAcceptance)
  let report: object = { status: 'failed', live }
  let acceptancePassed = false
  let runtime: object = {}
  let executionRoot: string | undefined
  let readSessionsForDiagnostics: (() => Promise<unknown>) | undefined
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
    const projectId = await createProject(page, 'EarthNano Notebook optimization')
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
    executionRoot = join(dataRoot, 'earthnano', 'desktop-runs')
    readSessionsForDiagnostics = () =>
      page.evaluate(
        async (projectId) =>
          (await window.api.sessions.loadAll()).sessions.filter(
            (entry) => entry.projectId === projectId
          ),
        projectId
      )
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
    // Only the explicitly interactive ordinary task receives test-user approvals.
    await page.removeLocatorHandler(page.getByTestId('permission-card'))
    const panel = page.getByTestId('task-optimization-panel')
    await panel.locator('summary').click()
    console.info('Scientific workflow: optimization panel open')
    await panel.getByLabel('Repeat this task with Notebook Python', { exact: true }).check()
    await expect(panel.getByLabel('Task description', { exact: true })).toHaveValue(prompt)
    await expect(panel.getByLabel('Task description', { exact: true })).toBeDisabled()
    await panel
      .getByLabel('Acceptance criteria (one per line)', { exact: true })
      .fill(
        'The published report gives count, sum and arithmetic mean computed from the fixed source observations.'
      )
    await panel.getByLabel('Check expected JSON output', { exact: true }).check()
    await panel.getByLabel('Output JSON file', { exact: true }).fill('research-results.json')
    await panel
      .getByLabel('Expected JSON value', { exact: true })
      .fill('{"count":3,"sum":12,"mean":4}')
    await panel.getByLabel('Optimization mode', { exact: true }).selectOption('parallel')
    await panel.getByLabel('Recursion parameter (k)', { exact: true }).fill('2')
    await panel.getByLabel('Concurrent executions', { exact: true }).fill('2')
    await panel
      .getByLabel('Execution limit (includes two assessments)', { exact: true })
      .fill(String(optimizationExecutions))
    await panel.getByRole('button', { name: 'Start optimization', exact: true }).click()
    console.info('Scientific workflow: optimization submitted')
    const latest = async (): Promise<
      import('../src/shared/earthnano/desktop-optimization').OptimizationProgress | null
    > =>
      page.evaluate((request) => window.api.optimization.latest(request), {
        projectId,
        sourceSessionId: source.id
      })
    let resumeEvidence: object | undefined
    if (resumeAcceptance) {
      await expect
        .poll(
          async () => {
            const state = (await latest())?.state
            return (
              provider.stats.pausedBeforeForward === 1 ||
              !!(state && ['failed', 'cancelled', 'interrupted'].includes(state))
            )
          },
          { timeout: 180_000 }
        )
        .toBe(true)
      expect(provider.stats.pausedBeforeForward).toBe(1)
      const beforeStop = (await latest())!
      const runKey = { projectId, sourceSessionId: source.id, runId: beforeStop.runId }
      await panel.getByRole('button', { name: 'Stop optimization', exact: true }).click()
      await expect
        .poll(async () => (await latest())?.resumeAvailable, { timeout: 60_000 })
        .toBe(true)
      const stopped = (await latest())!
      expect(stopped.state).toBe('cancelled')
      const executionPath = join(
        dataRoot,
        'earthnano',
        'desktop-runs',
        stopped.runId,
        'execution',
        'execution.json'
      )
      const stoppedJournal = JSON.parse(await readFile(executionPath, 'utf8')) as ExecutionState
      const completedBeforeResume = Object.values(stoppedJournal.records).filter(
        (record) => record.phase === 'completed'
      )
      expect(completedBeforeResume.some((record) => record.request.role === 'baseline')).toBe(true)
      const callsBeforeReopen = provider.stats.requests
      page = await app.restart()
      await openProjectSession(page, 'EarthNano Notebook optimization', prompt)
      expect(await latest()).toEqual(stopped)
      expect(provider.stats.requests).toBe(callsBeforeReopen)
      const reopenedPanel = page.getByTestId('task-optimization-panel')
      await reopenedPanel.locator('summary').click()
      await reopenedPanel.getByRole('button', { name: 'Resume optimization', exact: true }).click()
      await expect
        .poll(async () => (await latest())?.state, { timeout: 30_000 })
        .not.toBe('cancelled')
      expect((await latest())?.runId).toBe(runKey.runId)
      resumeEvidence = {
        runId: stopped.runId,
        originalBudget: stopped.budget.limit,
        stoppedAdmissions: stopped.budget.admitted,
        noCallsOnReopen: true,
        completedBeforeResume: completedBeforeResume.map((record) => record.executionId)
      }
      // This list is compared byte-for-byte after the resumed execution finishes below.
      await writeFile(
        testInfo.outputPath('stopped-journal.json'),
        JSON.stringify(stoppedJournal, null, 2)
      )
    }
    await expect
      .poll(async () => (await latest())?.state, { timeout: 600_000, intervals: [1000, 2000] })
      .toMatch(/^(completed|failed|cancelled|interrupted)$/)
    const completed = (await latest())!
    report = {
      status: 'incomplete',
      optimizationState: completed.state,
      ...(resumeEvidence ? { resume: resumeEvidence } : {}),
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
    const methodJournal = JSON.parse(
      await readFile(
        join(dataRoot, 'earthnano', 'desktop-runs', completed.runId, 'execution', 'execution.json'),
        'utf8'
      )
    ) as ExecutionState
    await writeFile(
      testInfo.outputPath('execution-journal.json'),
      JSON.stringify(methodJournal, null, 2)
    )
    report = {
      ...report,
      executionFacts: Object.values(methodJournal.records).map((record) => ({
        executionId: record.executionId,
        role: record.request.role,
        stageId:
          record.request.origin.kind === 'optimization' ? record.request.origin.stageId : undefined,
        phase: record.phase,
        cleanup: record.cleanup,
        error: record.error
      }))
    }
    expect(completed.error).toBeUndefined()
    expect(completed.state).toBe('completed')
    expect(completed.selection).toMatchObject({ trivial: false, candidateCount: 2 })
    expect(completed.outcome?.artifact.status).toBe('passed')
    // Integration acceptance must not require the live model to improve its configuration.
    // A real score regression must retain the original blocked decision, not be rerolled away.
    expect(completed.assessments?.baseline.outcome).toBe('pass')
    expect(completed.assessments?.candidate.outcome).toBe('pass')
    const regressed = completed.assessments!.candidate.score < completed.assessments!.baseline.score
    expect(completed.outcome?.configuration).toMatchObject({
      status: regressed ? 'blocked' : 'eligible',
      reasons: regressed ? ['score-regression'] : []
    })
    expect(completed.inputArtifacts).toBeUndefined()
    const originalUpload = source.messages.find(
      (message) => message.role === 'user' && message.content === prompt
    )!.uploads![0]
    expect(
      notebookRuns.some(
        (run) =>
          run.kernelKind === 'python' &&
          run.status === 'completed' &&
          run.inputFiles?.some(
            (input) =>
              input.sourceFileId === originalUpload.id &&
              input.inputFileVersionId === originalUpload.versionId &&
              input.checksum === originalUpload.sha256
          )
      )
    ).toBe(true)
    expect(
      (await readOrdinary()).flatMap((state) => Object.values(state.records))[0].identity
    ).toMatchObject({
      sessionId: source.id,
      promptMessageId: source.messages.find(
        (message) => message.role === 'user' && message.content === prompt
      )!.id
    })
    expect(completed.notebook).toMatchObject({
      source: {
        promptMessageId: source.messages.find(
          (message) => message.role === 'user' && message.content === prompt
        )!.id
      },
      inputs: [
        {
          sourceKind: 'upload-version',
          sourceProjectId: projectId,
          sourceSessionId: source.id,
          sourceFileId: originalUpload.id,
          inputFileVersionId: originalUpload.versionId,
          checksum: originalUpload.sha256
        }
      ],
      runtime: { language: 'python', source: 'external' }
    })
    expect(completed.budget.admitted).toBeLessThanOrEqual(optimizationExecutions)
    expect(completed.budget.active).toBe(0)
    expect(Object.keys(methodJournal.records).sort()).toEqual(
      completed.executions.map((execution) => execution.executionId).sort()
    )
    const sourceEvidence: unknown[] = []
    for (const reviewer of Object.values(methodJournal.records).filter(
      (record) =>
        record.request.role === 'reviewer' &&
        record.request.origin.stageId?.startsWith('semantic:') &&
        record.phase === 'completed'
    )) {
      const ref = reviewer.request.taskSnapshotRef
      const bytes = await readFile(
        join(
          dataRoot,
          'earthnano',
          'desktop-runs',
          completed.runId,
          'execution',
          'snapshots',
          'objects',
          `${ref.digest.slice(7)}.json`
        )
      )
      expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(ref.digest)
      const snapshot = JSON.parse(bytes.toString('utf8'))
      const evidenceFile = snapshot.value.files.find(
        (file: { path: string }) => file.path === 'evidence/sources.json'
      )
      expect(evidenceFile).toBeDefined()
      const evidence = JSON.parse(evidenceFile.content)
      expect(evidence).toMatchObject({
        schemaVersion: 1,
        profile: 'bounded-utf8-v1',
        inputs: [
          {
            status: 'available',
            content: 'sample,value\nA,2\nB,4\nC,6\n',
            input: {
              sourceFileId: originalUpload.id,
              inputFileVersionId: originalUpload.versionId,
              checksum: originalUpload.sha256
            }
          }
        ]
      })
      sourceEvidence.push(evidence)
    }
    expect(sourceEvidence).toHaveLength(2)
    expect(sourceEvidence[0]).toEqual(sourceEvidence[1])
    report = { ...report, identicalOriginalSourceEvidence: sourceEvidence[0] }
    const stoppedJournal = resumeAcceptance
      ? (JSON.parse(
          await readFile(testInfo.outputPath('stopped-journal.json'), 'utf8')
        ) as ExecutionState)
      : undefined
    for (const record of Object.values(methodJournal.records)) {
      expect(record.cleanup).toBe('confirmed')
      const prior = stoppedJournal?.records[record.executionId]
      if (prior && prior.phase !== 'completed') {
        // Original owners can preserve a failed read-result outcome during explicit cancellation.
        // It is paid/failed history, not a completed cache hit or a post-resume success claim.
        expect(record.cancellationRequested).toBe(true)
        expect(record.phase).toMatch(/^(failed|cancelled)$/)
      } else expect(record.phase).toBe('completed')
      const admissions = methodJournal.events[record.executionId].filter(
        (event) => event.type === 'session-admitted'
      )
      if (record.phase === 'completed') expect(admissions).toHaveLength(1)
      else expect(admissions.length).toBeLessThanOrEqual(1)
      const acceptances = methodJournal.events[record.executionId].filter(
        (event) => event.type === 'provider-accepted'
      )
      if (record.phase === 'completed') expect(acceptances).toHaveLength(1)
      else expect(acceptances.length).toBeLessThanOrEqual(1)
    }
    if (resumeAcceptance) {
      const stopped = stoppedJournal!
      expect(Object.values(stopped.records).some((record) => record.phase === 'cancelled')).toBe(
        true
      )
      for (const record of Object.values(stopped.records)) {
        expect(methodJournal.records[record.executionId]).toEqual(record)
        expect(methodJournal.events[record.executionId]).toEqual(stopped.events[record.executionId])
      }
    }
    const scientificRecords = Object.values(methodJournal.records).filter(
      (record) =>
        ['baseline', 'candidate'].includes(record.request.role) && record.phase === 'completed'
    )
    expect(scientificRecords.length).toBeGreaterThanOrEqual(3)
    expect(
      new Set(scientificRecords.map((record) => JSON.stringify(record.request.taskSnapshotRef)))
        .size
    ).toBe(1)
    expect(
      new Set(scientificRecords.map((record) => JSON.stringify(record.request.environmentSpecRef)))
        .size
    ).toBe(1)
    expect(new Set(scientificRecords.map((record) => record.identity.sessionId)).size).toBe(
      scientificRecords.length
    )
    const scientificRuns: object[] = []
    for (const record of scientificRecords) {
      const runs = await app.readNotebookFixtureRuns(projectId, record.identity.sessionId!)
      const computation = runs.find(
        (run) =>
          run.kernelKind === 'python' &&
          run.status === 'completed' &&
          run.script.includes('statistics') &&
          run.inputFiles?.some(
            (input) =>
              input.sourceFileId === originalUpload.id &&
              input.inputFileVersionId === originalUpload.versionId &&
              input.checksum === originalUpload.sha256
          )
      )
      expect(
        computation,
        `Notebook computation for ${record.request.origin.kind === 'optimization' ? record.request.origin.stageId : record.executionId}`
      ).toBeDefined()
      expect(record.evidence.artifacts).toHaveLength(1)
      const output = record.evidence.artifacts[0]
      const producer = await page.evaluate(
        (request) => window.api.artifacts.getVersionProvenance(request),
        {
          projectId,
          appSessionId: record.identity.sessionId!,
          artifactId: output.artifactId,
          versionId: output.versionId
        }
      )
      if ('failure' in producer) throw new Error('Published ArtifactVersion provenance unavailable')
      expect(producer).toMatchObject({
        contentStatus: { state: 'available' },
        evidence: { producer: { state: 'available', producer_run_id: expect.any(String) } }
      })
      const producerRunId = isArtifactNotebookProducer(producer.evidence.producer)
        ? producer.evidence.producer.producer_run_id
        : undefined
      const producingRun = runs.find(
        (run) =>
          run.runId === producerRunId &&
          run.kernelKind === 'python' &&
          run.status === 'completed' &&
          run.inputFiles?.some(
            (input) =>
              input.sourceFileId === originalUpload.id &&
              input.inputFileVersionId === originalUpload.versionId &&
              input.checksum === originalUpload.sha256
          )
      )
      expect(
        producingRun,
        'Artifact producer is an original completed Python Run in this same fixed-input Session'
      ).toBeDefined()
      const preview = await page.evaluate(
        async ({ projectId, sessionId }) => {
          const session = (await window.api.sessions.loadAll()).sessions.find(
            (entry) => entry.id === sessionId
          )!
          return window.api.notebook.state({
            projectId,
            sessionId,
            workspaceCwd: session.cwd ?? ''
          })
        },
        { projectId, sessionId: record.identity.sessionId! }
      )
      expect(preview.runs.some((run) => run.runId === producerRunId)).toBe(true)
      scientificRuns.push({
        executionId: record.executionId,
        role: record.request.role,
        sessionId: record.identity.sessionId,
        computationRunId: computation!.runId,
        producerRunId,
        notebookPreviewReopenedWithoutRestart: true,
        taskSnapshotRef: record.request.taskSnapshotRef,
        environmentSpecRef: record.request.environmentSpecRef,
        inputFiles: computation!.inputFiles,
        artifacts: record.evidence.artifacts
      })
    }
    report = {
      ...report,
      scientificRuns,
      sameScientificTask: true,
      sourceVersionsPreserved: true,
      nativeNotebookProducersVerified: true,
      inputAccessEvidence:
        'Exact original source Versions attached to each Run; external Python file-access evidence may be partial. No complete dependency-proof claim.'
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
          'notebook-task.json'
        ),
        'utf8'
      )
    )
    expect(manifest).toMatchObject({
      projectId,
      sourceSessionId: source.id,
      task: { prompt, managedInputs: completed.notebook!.inputs }
    })
    const settledPanel = page.getByTestId('task-optimization-panel')
    if (resumeAcceptance) {
      // Reopening deliberately does not copy private experiment criteria into a new editable task.
      // Enter a new draft criterion to verify admission is released, without starting another run.
      await settledPanel
        .getByLabel('Acceptance criteria (one per line)', { exact: true })
        .fill('The published report matches the fixed source observations.')
    }
    await expect(
      settledPanel.getByRole('button', { name: 'Start optimization', exact: true })
    ).toBeEnabled()
    const requestCount = provider.stats.requests
    page = await app.restart()
    // Candidate Sessions remain inspectable in the original project. Their newer timestamps may
    // fill Home's five recent rows, so reopen the scientific source through its project.
    await openProjectSession(page, 'EarthNano Notebook optimization', prompt)
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
    // Retain the original facts even when failure occurs before the interruption barrier or any
    // success assertion. Never discard a failed attempt or fabricate an owner outcome for a report.
    if (executionRoot) {
      try {
        for (const runId of await readdir(executionRoot)) {
          const journal = await readFile(join(executionRoot, runId, 'execution', 'execution.json'))
          await writeFile(testInfo.outputPath(`final-journal-${runId}.json`), journal)
        }
        const sessions = await readSessionsForDiagnostics?.()
        await writeFile(
          testInfo.outputPath('final-scientific-sessions.json'),
          JSON.stringify(sessions, null, 2)
        )
      } catch {
        // Failure to read diagnostics never changes the original failed acceptance result.
      }
    }
    const result = {
      ...report,
      status: acceptancePassed ? 'passed' : 'failed',
      acceptancePassed,
      provider: provider.stats,
      bounds: {
        apiRequests: 160,
        maxOutputTokensPerRequest: 2048,
        upstreamDeadlineMs: 90_000,
        optimizationExecutions
      },
      runtime: { ...runtime, backend: 'native Claude Code' }
    }
    await writeFile(
      testInfo.outputPath('notebook-optimization.json'),
      JSON.stringify(result, null, 2)
    )
    if (live && process.env.EARTHNANO_LIVE_NOTEBOOK_REPORT)
      await writeFile(process.env.EARTHNANO_LIVE_NOTEBOOK_REPORT, JSON.stringify(result, null, 2))
    await provider.close()
  }
})
