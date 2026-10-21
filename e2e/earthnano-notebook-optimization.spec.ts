import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { expect } from '@playwright/test'
import { isArtifactNotebookProducer } from '../src/shared/artifact-provenance'
import { hasImmutableExecutionFileEvidenceReference } from '../src/shared/execution-file-evidence'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import type { CandidateInvocation } from '../src/main/earthnano/candidate-snapshot'
import type { ExecutionState } from '../src/main/earthnano/execution-core'
import type { ExecutionRecord } from '../src/shared/earthnano/execution-types'
import { sanitizeAcpTurnTokenUsage } from '../src/shared/acp'
import { summarizeExecutionUsage } from '../src/shared/earthnano/execution-usage'
import { test } from './fixtures/electron-app'
import { createProject, openProjectSession } from './certification/helpers'
import { submitPromptViaUi } from './fixtures/conversation'
import { createEarthnanoMessagesProvider } from './fixtures/earthnano-messages-provider'

const language = process.env.EARTHNANO_NOTEBOOK_LANGUAGE ?? 'python'
if (language !== 'python' && language !== 'r')
  throw new Error('Explicit supported Notebook language required')
const computationMarker = language === 'r' ? 'read.csv' : 'statistics'
const binaryAcceptance = process.env.EARTHNANO_E2E_BINARY === '1'
if (binaryAcceptance && language !== 'r') throw new Error('Binary desktop acceptance requires R')
const artifactCount = binaryAcceptance ? 2 : 1
const live = process.env.EARTHNANO_LIVE_DEEPSEEK === '1'
const resumeAcceptance = process.env.EARTHNANO_E2E_RESUME === '1'
const dualModeAcceptance = process.env.EARTHNANO_E2E_SWEEP === '1'
const optimizationExecutions = live || resumeAcceptance ? 24 : 20
const verifyOriginalUsage = (record: ExecutionRecord, session: PersistedChatSession): void => {
  expect(record.usage.status).toBe('known')
  expect(record.usage.source).toMatchObject({
    scope: 'logical-prompt',
    sessionId: session.id,
    promptMessageId: record.identity.promptMessageId
  })
  const owner = session.conversationGraph?.messages.find(
    (message) => message.id === record.usage.source!.ownerMessageId
  )
  expect(owner?.status).toBe('complete')
  const original = sanitizeAcpTurnTokenUsage(owner?.turnUsage)
  expect(original).toBeDefined()
  expect(record.usage).toMatchObject({
    inputTokens: original!.inputTokens,
    cacheTokens: original!.cacheTokens,
    outputTokens: original!.outputTokens,
    ...(original!.turnCount === undefined ? {} : { modelTurns: original!.turnCount })
  })
  expect(record.usage.apiRequests).toBeUndefined()
  expect(record.usage.costMicrousd).toBeUndefined()
}
test('runs the identical scientific task in ordinary Send and isolated Harness baseline/candidates through the original Notebook owners', async ({
  app
}, testInfo) => {
  test.skip(process.platform === 'win32', 'The current optimization profile supports POSIX hosts')
  test.skip(
    process.env.OPEN_SCIENCE_E2E_ISOLATE_HOME !== '1',
    'Native scientific acceptance requires an explicitly isolated test home'
  )
  test.setTimeout(900_000)
  const provider = await createEarthnanoMessagesProvider(live, true, resumeAcceptance, {
    scientificLanguage: language,
    ...(binaryAcceptance ? { scientificFigure: true } : {})
  })
  let report: object = { status: 'failed', live, language }
  let acceptancePassed = false
  let runtime: object = {}
  let executionRoot: string | undefined
  let ordinaryRoot: string | undefined
  let readSessionsForDiagnostics: (() => Promise<unknown>) | undefined
  try {
    runtime = {
      notebookLanguage: language,
      source: {
        head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).length > 0
      },
      // Record actual built entrypoint bytes as well as source identity; a source commit alone
      // cannot prove a previously built desktop binary contains the same implementation.
      bundleEntrypointSha256: Object.fromEntries(
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
      )
    }
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
      ...runtime,
      electron: await page.evaluate(() => /Electron\/([^ ]+)/.exec(navigator.userAgent)?.[1]),
      claude: claudeVersion,
      nodeRunner: process.version,
      model: 'deepseek-flash'
    }
    const interpreter =
      language === 'r'
        ? process.env.EARTHNANO_E2E_R_INTERPRETER
        : execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
            encoding: 'utf8'
          }).trim()
    if (!interpreter || !isAbsolute(interpreter))
      throw new Error('Explicit absolute scientific interpreter required')
    await page.evaluate(
      async ({ language, path }) => {
        await window.api.runtime.registerInterpreter(language, path)
        const environments = await window.api.runtime.listEnvironments()
        const entry = environments[language].find(
          (entry) => entry.envId === path || entry.interpreterPath === path
        )
        if (!entry) throw new Error('Scientific interpreter missing')
        await window.api.runtime.setEnvironmentEnabled(language, entry.envId, true)
      },
      { language, path: interpreter } as const
    )
    const externalRuntimeRoot = process.env.EARTHNANO_E2E_R_READONLY_ROOT
    if (language === 'r' && externalRuntimeRoot) {
      // A conda Rscript starts lib/R/bin/R outside its bin directory. Exercise the original
      // user's explicit Files read-only grant, rather than widening the runtime sandbox.
      const root = await realpath(externalRuntimeRoot)
      const interpreterWithinRoot = relative(root, await realpath(interpreter))
      if (
        root === '/' ||
        interpreterWithinRoot.startsWith('..') ||
        isAbsolute(interpreterWithinRoot)
      )
        throw new Error('The explicit read-only R root must contain the selected interpreter')
      const grants = await page.evaluate(
        (path) => window.api.localFs.grantRoot({ path, access: 'ro' }),
        root
      )
      expect(grants.find((grant) => grant.path === root)).toMatchObject({ access: 'ro' })
      runtime = { ...runtime, externalRuntimeAccess: { path: root, access: 'ro' } }
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.addLocatorHandler(page.getByTestId('permission-card'), async (card) => {
      await card.getByTestId('allow-primary').click()
    })
    const projectId = await createProject(page, 'EarthNano Notebook optimization')
    const dataRoot = await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)
    executionRoot = join(dataRoot, 'earthnano', 'desktop-runs')
    ordinaryRoot = join(dataRoot, 'executions', 'session-attempts')
    readSessionsForDiagnostics = () =>
      page.evaluate(
        async (projectId) =>
          (await window.api.sessions.loadAll()).sessions.filter(
            (entry) => entry.projectId === projectId
          ),
        projectId
      )
    await page.locator('input[type="file"][multiple]').setInputFiles({
      name: 'measurements.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('sample,value\nA,2\nB,4\nC,6\n')
    })
    const textPrompt =
      language === 'r'
        ? 'Analyze the attached measurements.csv with the Notebook R tools using explicit language r. List runtimes and bind the enabled external R runtime. Read the uploaded CSV using read.csv, calculate row count, sum and arithmetic mean with base R. Save research-results.json with numeric keys count, sum, mean using jsonlite::write_json(auto_unbox=TRUE). Publish this exact local file using write_artifact_file with the Notebook producerRunId. Do not use native Bash or native Write, and do not create extra artifacts. After successful publication reply: Research analysis complete.'
        : 'Analyze the attached measurements.csv with the Notebook Python tools. List runtimes and bind the enabled external Python runtime. Read the uploaded CSV, calculate row count, sum and arithmetic mean using Python csv and statistics. Save research-results.json with numeric keys count, sum, mean. Publish this exact local file using write_artifact_file with the Notebook producerRunId. Do not use native Bash or native Write, and do not create extra artifacts. After successful publication reply: Research analysis complete.'
    const prompt = binaryAcceptance
      ? textPrompt.replace(
          'Do not use native Bash or native Write, and do not create extra artifacts.',
          "Also save measurements.png using grDevices::png(type='cairo') and plot the observations. Publish this exact PNG using write_artifact_file with the same actual Notebook producerRunId. Publish only the JSON report and PNG. Do not use native Bash or native Write."
        )
      : textPrompt
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
      .toBe(artifactCount)
    const source = (await loadSource())!,
      artifact = source.artifacts!.find((entry) => entry.name === 'research-results.json')!
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
          run.kernelKind === language &&
          run.status === 'completed' &&
          run.script.includes(computationMarker) &&
          run.inputFiles?.some((file) => file.filename === 'measurements.csv')
      )
    ).toBe(true)
    console.info('Scientific workflow: Notebook verified')
    const readOrdinary = async (): Promise<ExecutionState[]> => {
      const states: ExecutionState[] = []
      for (const generation of await readdir(ordinaryRoot!))
        for (const name of await readdir(join(ordinaryRoot!, generation)))
          if (name.endsWith('.json')) {
            const state = JSON.parse(
              await readFile(join(ordinaryRoot!, generation, name), 'utf8')
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
      .toEqual([{ phase: 'completed', cleanup: 'confirmed', artifacts: artifactCount }])
    console.info('Scientific workflow: ordinary Core verified')
    const ordinaryRecord = (await readOrdinary()).flatMap((state) =>
      Object.values(state.records)
    )[0]
    verifyOriginalUsage(ordinaryRecord, (await loadSource())!)
    if (binaryAcceptance) {
      expect(source.artifacts!.map((entry) => entry.name).sort()).toEqual([
        'measurements.png',
        'research-results.json'
      ])
      for (const output of source.artifacts!) {
        expect(ordinaryRecord.evidence.artifacts).toContainEqual({
          artifactId: output.artifactId,
          versionId: output.versionId,
          checksum: output.sha256
        })
        const producer = await page.evaluate(
          (request) => window.api.artifacts.getVersionProvenance(request),
          {
            projectId,
            appSessionId: source.id,
            artifactId: output.artifactId!,
            versionId: output.versionId!
          }
        )
        if ('failure' in producer)
          throw new Error('Ordinary ArtifactVersion provenance unavailable')
        expect(producer.contentStatus).toMatchObject({ state: 'available' })
        expect(isArtifactNotebookProducer(producer.evidence.producer)).toBe(true)
        const runId = isArtifactNotebookProducer(producer.evidence.producer)
          ? producer.evidence.producer.producer_run_id
          : undefined
        expect(
          hasImmutableExecutionFileEvidenceReference(
            notebookRuns.find((run) => run.runId === runId)?.fileEvidence
          )
        ).toBe(true)
        expect(notebookRuns.find((run) => run.runId === runId)).toMatchObject({
          kernelKind: language,
          status: 'completed',
          inputFiles: expect.arrayContaining([
            expect.objectContaining({
              sourceFileId: source.messages.find(
                (message) => message.role === 'user' && message.content === prompt
              )!.uploads![0].id,
              inputFileVersionId: source.messages.find(
                (message) => message.role === 'user' && message.content === prompt
              )!.uploads![0].versionId,
              checksum: source.messages.find(
                (message) => message.role === 'user' && message.content === prompt
              )!.uploads![0].sha256
            })
          ])
        })
      }
    }
    // Only the explicitly interactive ordinary task receives test-user approvals.
    await page.removeLocatorHandler(page.getByTestId('permission-card'))
    const panel = page.getByTestId('task-optimization-panel')
    await panel.locator('summary').click()
    console.info('Scientific workflow: optimization panel open')
    await panel.getByLabel('Repeat this task with Notebook', { exact: true }).check()
    await panel.getByLabel('Notebook language', { exact: true }).selectOption(language)
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
    await panel
      .getByLabel('Recursion parameter (k)', { exact: true })
      .fill(dualModeAcceptance ? '1' : '2')
    if (dualModeAcceptance)
      await panel.getByLabel('Compare both optimization modes', { exact: true }).check()
    await panel.getByLabel('Concurrent executions', { exact: true }).fill('2')
    await panel
      .getByLabel(
        dualModeAcceptance
          ? 'Shared execution limit (all task assessments and reflections)'
          : 'Execution limit (includes two assessments)',
        { exact: true }
      )
      .fill(String(optimizationExecutions))
    const callsBeforePreview = provider.stats.requests
    await panel.getByRole('button', { name: 'Preview task stream', exact: true }).click()
    await expect(panel.getByTestId('optimization-sweep-preview')).toBeVisible()
    expect(provider.stats.requests).toBe(callsBeforePreview)
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
      profile: 'original-sweep-v2',
      modes: dualModeAcceptance ? ['parallel', 'sequential'] : ['parallel'],
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
    const modeSummaries = completed.sweep?.domains.map(({ mode, summary }) => ({
      mode,
      task: summary.tasks[0]!
    }))
    const primarySummary = modeSummaries![0]!.task
    const assessments = primarySummary.assessments!
    const outcome = primarySummary.outcome!
    const frozenSweep = JSON.parse(
      await readFile(
        join(dataRoot, 'earthnano', 'desktop-runs', completed.runId, 'execution', 'resume.json'),
        'utf8'
      )
    ).identity.sweep
    expect(frozenSweep.request.previewPlanDigest).toBe(completed.sweep!.planDigest)
    const notebook = {
      source: { promptMessageId: frozenSweep.tasks[0].sourcePromptMessageId },
      inputs: frozenSweep.tasks[0].input.task.managedInputs,
      runtime: frozenSweep.tasks[0].input.environment.notebook.runtime
    }
    {
      expect(completed.sweep?.modes).toEqual(
        dualModeAcceptance ? ['parallel', 'sequential'] : ['parallel']
      )
      expect(completed.sweep?.order).toEqual([{ domain: 'research', taskIds: ['task-0001'] }])
      expect(modeSummaries).toHaveLength(dualModeAcceptance ? 2 : 1)
      expect(
        new Set(modeSummaries!.map(({ task }) => task.assessments!.baseline.executionId)).size
      ).toBe(1)
      expect(
        new Set(modeSummaries!.map(({ task }) => task.assessments!.candidate.executionId)).size
      ).toBe(dualModeAcceptance ? 2 : 1)
      expect(
        Object.values(methodJournal.records).filter(
          (record) => record.request.role === 'baseline' && record.phase === 'completed'
        )
      ).toHaveLength(dualModeAcceptance ? 1 : 2)
      expect(
        Object.values(methodJournal.records).filter(
          (record) => record.request.role === 'reviewer' && record.phase === 'completed'
        )
      ).toHaveLength(dualModeAcceptance ? 3 : 2)
      expect(frozenSweep.plan.bindingIdentity.modes).toEqual(
        dualModeAcceptance ? ['agg', 'seq'] : ['agg']
      )
      const routing = JSON.parse(
        await readFile(
          join(
            dataRoot,
            'earthnano',
            'desktop-runs',
            completed.runId,
            'execution',
            'request-tasks.json'
          ),
          'utf8'
        )
      )
      expect(routing.schemaVersion).toBe(2)
      for (const { mode, task } of modeSummaries!) {
        expect(task.selection).toMatchObject({
          trivial: dualModeAcceptance,
          candidateCount: dualModeAcceptance ? 1 : 2
        })
        expect(task.outcome?.artifact.status).toBe('passed')
        expect(task.assessments!.baseline.outcome).toBe('pass')
        expect(task.assessments!.candidate.outcome).toBe('pass')
        if (task.experience) {
          const record = methodJournal.records[task.experience.reflectionExecutionId]!
          expect(routing.entries[record.requestKey].scope).toBe(
            frozenSweep.plan.bindingIdentity.modeScopes[mode === 'parallel' ? 'agg' : 'seq']
          )
        }
      }
      report = {
        ...report,
        sweep: {
          sharedBaseline: true,
          sharedBaselineAssessment: true,
          separateModeAssessments: true,
          originalRunSweep: true,
          namespaceVersion: 2,
          summaries: modeSummaries
        }
      }
    }
    expect(completed.error).toBeUndefined()
    expect(completed.state).toBe('completed')
    const usageSessions = (await readSessionsForDiagnostics!()) as PersistedChatSession[]
    const completedRecords = Object.values(methodJournal.records).filter(
      (record) => record.phase === 'completed'
    )
    // A Core cancellation or later publication failure can still have an exact completed
    // original usage owner. Verify those counters too; phase never implies free execution.
    const knownUsageRecords = Object.values(methodJournal.records).filter(
      (record) => record.usage.status === 'known'
    )
    for (const record of knownUsageRecords) {
      const session = usageSessions.find((session) => session.id === record.identity.sessionId)
      expect(session).toBeDefined()
      verifyOriginalUsage(record, session!)
    }
    for (const record of completedRecords.filter((record) => record.usage.status === 'unknown')) {
      expect(record.usage).toEqual({ status: 'unknown' })
      // A file-only method turn can legitimately lack a complete original usage owner.
      expect(['baseline', 'candidate', 'reviewer']).not.toContain(record.request.role)
    }
    expect(completed.usage).toEqual(summarizeExecutionUsage(Object.values(methodJournal.records)))
    expect(completed.usage?.ambiguousExecutions).toBe(0)
    expect(completed.usage?.tokens.coveredExecutions).toBe(knownUsageRecords.length)
    expect(completed.usage?.apiRequests.status).toBe('unknown')
    expect(completed.usage?.costMicrousd.status).toBe('unknown')
    report = {
      ...report,
      usage: {
        ordinary: ordinaryRecord.usage,
        optimization: completed.usage,
        originalOwnerCountersVerified: knownUsageRecords.length + 1,
        scope: 'Original root logical-prompt provider facts; incomplete cancellation usage excluded'
      }
    }
    if (!dualModeAcceptance)
      expect(primarySummary.selection).toMatchObject({ trivial: false, candidateCount: 2 })
    expect(outcome?.artifact.status).toBe('passed')
    // Integration acceptance must not require the live model to improve its configuration.
    // A real score regression must retain the original blocked decision, not be rerolled away.
    expect(assessments?.baseline.outcome).toBe('pass')
    expect(assessments?.candidate.outcome).toBe('pass')
    const regressed = assessments.candidate.score < assessments.baseline.score
    expect(outcome?.configuration).toMatchObject({
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
          run.kernelKind === language &&
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
    expect(notebook).toMatchObject({
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
      runtime: { language, source: 'external' }
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
    expect(sourceEvidence).toHaveLength(dualModeAcceptance ? 3 : 2)
    for (const evidence of sourceEvidence) expect(evidence).toEqual(sourceEvidence[0])
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
          run.kernelKind === language &&
          run.status === 'completed' &&
          run.script.includes(computationMarker) &&
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
      expect(record.evidence.artifacts).toHaveLength(artifactCount)
      const artifactProducers: Array<{
        output: ExecutionRecord['evidence']['artifacts'][number]
        producerRunId: string | undefined
        notebookPreviewReopenedWithoutRestart: true
      }> = []
      if (binaryAcceptance) {
        const session = usageSessions.find((entry) => entry.id === record.identity.sessionId)!
        expect(session.artifacts!.map((entry) => entry.name).sort()).toEqual([
          'measurements.png',
          'research-results.json'
        ])
        for (const output of session.artifacts!)
          expect(record.evidence.artifacts).toContainEqual({
            artifactId: output.artifactId,
            versionId: output.versionId,
            checksum: output.sha256
          })
      }
      for (const output of record.evidence.artifacts) {
        const producer = await page.evaluate(
          (request) => window.api.artifacts.getVersionProvenance(request),
          {
            projectId,
            appSessionId: record.identity.sessionId!,
            artifactId: output.artifactId,
            versionId: output.versionId
          }
        )
        if ('failure' in producer)
          throw new Error('Published ArtifactVersion provenance unavailable')
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
            run.kernelKind === language &&
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
          'Artifact producer is an original completed Run in the frozen language and this same fixed-input Session'
        ).toBeDefined()
        if (binaryAcceptance)
          expect(hasImmutableExecutionFileEvidenceReference(producingRun!.fileEvidence)).toBe(true)
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
        artifactProducers.push({
          output,
          producerRunId,
          notebookPreviewReopenedWithoutRestart: true
        })
      }
      scientificRuns.push({
        executionId: record.executionId,
        role: record.request.role,
        sessionId: record.identity.sessionId,
        computationRunId: computation!.runId,
        producerRunId: artifactProducers[0].producerRunId,
        notebookPreviewReopenedWithoutRestart: true,
        ...(binaryAcceptance ? { artifactProducers } : {}),
        taskSnapshotRef: record.request.taskSnapshotRef,
        environmentSpecRef: record.request.environmentSpecRef,
        inputFiles: computation!.inputFiles,
        artifacts: record.evidence.artifacts
      })
    }
    if (binaryAcceptance) {
      const assetEvidence: Array<{
        executionId: string
        role: string
        asset: NonNullable<CandidateInvocation['assets']>[number]
        inputPath: string
        sizeBytes: number
        sha256: string
      }> = []
      const selectorExecutions = completedRecords.filter(
        (record) => record.request.role === 'selector'
      )
      if (!dualModeAcceptance) expect(selectorExecutions.length).toBeGreaterThan(0)
      for (const record of completedRecords) {
        const ref = record.request.invocationRef
        const raw = await readFile(
          join(
            executionRoot!,
            completed.runId,
            'execution',
            'snapshots',
            'objects',
            `${ref.digest.slice(7)}.json`
          )
        )
        expect(`sha256:${createHash('sha256').update(raw).digest('hex')}`).toBe(ref.digest)
        const invocation = JSON.parse(raw.toString('utf8')).value as CandidateInvocation
        if (!invocation.assets) {
          if (record.request.role === 'selector')
            throw new Error('Selector binary invocation assets missing')
          continue
        }
        expect(invocation.assets.length).toBeGreaterThan(0)
        if (record.request.role === 'selector') expect(invocation.assets).toHaveLength(2)
        for (const asset of invocation.assets) {
          const original = methodJournal.records[asset.sourceExecutionId]
          expect(original).toBeDefined()
          expect(original.phase).toBe('completed')
          expect(original.cleanup).toBe('confirmed')
          expect(['baseline', 'candidate']).toContain(original.request.role)
          expect(original.evidence.artifacts).toContainEqual(asset.artifact.artifactRef)
          const sourceSession = usageSessions.find(
            (entry) => entry.id === original.identity.sessionId
          )!
          expect(sourceSession.artifacts).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: 'measurements.png',
                artifactId: asset.artifact.artifactRef.artifactId,
                versionId: asset.artifact.artifactRef.versionId,
                sha256: asset.artifact.artifactRef.checksum
              })
            ])
          )
          expect(asset.artifact).toMatchObject({
            path: 'measurements.png',
            representation: 'binary',
            contentType: 'image/png'
          })
          expect(asset.artifact).not.toHaveProperty('content')
          const inputPath = await realpath(
            join(
              executionRoot!,
              completed.runId,
              'execution',
              'candidates',
              record.executionId,
              'workspace',
              'inputs',
              asset.path
            )
          )
          const bytes = await readFile(inputPath)
          expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
          expect(bytes.length).toBe(asset.artifact.sizeBytes)
          const sha256 = createHash('sha256').update(bytes).digest('hex')
          expect(`sha256:${sha256}`).toBe(asset.artifact.digest)
          expect(sha256).toBe(asset.artifact.artifactRef.checksum)
          if (record.request.role === 'selector') {
            expect(provider.stats.imageToolResults).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  role: 'selector',
                  path: inputPath,
                  mediaType: 'image/png',
                  sourceType: 'base64',
                  sizeBytes: bytes.length,
                  sha256
                })
              ])
            )
          }
          assetEvidence.push({
            executionId: record.executionId,
            role: record.request.role,
            asset,
            inputPath,
            sizeBytes: bytes.length,
            sha256
          })
        }
      }
      expect(assetEvidence.length).toBeGreaterThan(0)
      if (!dualModeAcceptance) {
        expect(provider.stats.imageToolResults?.length).toBeGreaterThan(0)
        expect(assetEvidence.some((entry) => entry.role === 'proposer')).toBe(true)
      }
      // These facts prove transport/read identity, not a scientific or visual semantic verdict.
      report = {
        ...report,
        binary: {
          artifactCount,
          assets: assetEvidence,
          nativeImageToolResults: provider.stats.imageToolResults,
          imageSemanticAssessment: 'not-performed'
        }
      }
    }
    report = {
      ...report,
      scientificRuns,
      sameScientificTask: true,
      sourceVersionsPreserved: true,
      nativeNotebookProducersVerified: true,
      inputAccessEvidence:
        'Exact original source Versions attached to each Run; external runtime file-access evidence may be partial. No complete dependency-proof claim.'
    }
    // Inherited candidate scopes must not be charged or journaled again by ordinary Send.
    expect((await readOrdinary()).flatMap((state) => Object.values(state.records))).toHaveLength(1)
    const candidate = completed.executions.find(
      (execution) => execution.executionId === assessments.candidate.targetExecutionId
    )!
    const reviews = await page.evaluate((request) => window.api.reviewer.getForSession(request), {
      projectId,
      appSessionId: candidate.sessionId!
    })
    expect(
      reviews.some(
        (review) =>
          review.id === assessments.candidate.reviewId &&
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
          'sweep-sources.json'
        ),
        'utf8'
      )
    )
    expect(manifest.tasks[0]).toMatchObject({
      taskId: 'task-0001',
      domain: 'research',
      sourceSessionId: source.id,
      task: { prompt, managedInputs: notebook.inputs }
    })
    const settledPanel = page.getByTestId('task-optimization-panel')
    if (resumeAcceptance) {
      // Reopening deliberately does not copy private experiment criteria into a new editable task.
      // Enter a new draft criterion to verify admission is released, without starting another run.
      await settledPanel
        .getByLabel('Acceptance criteria (one per line)', { exact: true })
        .fill('The published report matches the fixed source observations.')
    }
    await settledPanel.getByRole('button', { name: 'Preview task stream', exact: true }).click()
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
    if (ordinaryRoot) {
      try {
        for (const generation of await readdir(ordinaryRoot))
          for (const name of await readdir(join(ordinaryRoot, generation)))
            if (name.endsWith('.json'))
              await writeFile(
                testInfo.outputPath(`final-ordinary-journal-${generation}-${name}`),
                await readFile(join(ordinaryRoot, generation, name))
              )
      } catch {
        // An absent journal must not suppress the independent Session diagnostics below.
      }
    }
    if (executionRoot) {
      try {
        for (const runId of await readdir(executionRoot)) {
          const privateRoot = join(executionRoot, runId, 'execution')
          try {
            const journal = await readFile(join(privateRoot, 'execution.json'))
            await writeFile(testInfo.outputPath(`final-journal-${runId}.json`), journal)
          } catch {
            // Preparation can fail before the first Core journal is created.
          }
          // Keep only known host diagnostics and immutable routing; candidate output trees can
          // contain arbitrary model files and are not part of this diagnostic projection.
          for (const name of ['failure-diagnostics.jsonl', 'resume.json', 'request-tasks.json']) {
            try {
              await writeFile(
                testInfo.outputPath(`final-private-${runId}-${name}`),
                await readFile(join(privateRoot, name))
              )
            } catch {
              // Older or pre-admission attempts may not have each optional host record.
            }
          }
        }
      } catch {
        // The optimization directory does not exist if ordinary Send fails first.
      }
    }
    if (readSessionsForDiagnostics) {
      try {
        const sessions = await readSessionsForDiagnostics()
        await writeFile(
          testInfo.outputPath('final-scientific-sessions.json'),
          JSON.stringify(
            sessions,
            binaryAcceptance
              ? (key: string, value: unknown) => {
                  // Keep Session identities and artifact facts, not native image payloads, in
                  // external diagnostics. The actual Read receipts retain only size and digest.
                  if (['images', 'image', 'rawOutput'].includes(key)) return undefined
                  if (key === 'data' && typeof value === 'string') return undefined
                  return value
                }
              : undefined,
            2
          )
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
