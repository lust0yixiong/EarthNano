import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it as baseIt, onTestFinished, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false } }))
vi.mock('../desktop-surface-declarations', () => ({
  registerDesktopOptimizationIpcHandlers: vi.fn()
}))
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import {
  createComputeWorkflowFixture,
  type ComputeWorkflowFixture
} from '../../../test/earthnano/compute-workflow'
import { createEarthnanoMessagesProvider } from '../../../e2e/fixtures/earthnano-messages-provider'
import {
  createDesktopSweepOptions,
  createDesktopSweepPreview,
  type DesktopOptimizationDependencies
} from '../composition/desktop-optimization'
import { disconnectProjectDbClient } from '../projects/prisma-client'
import { loadSessionMutationAuthority } from '../session-persistence/repository'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import { NotebookRunRepository } from '../notebook/repository'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ArtifactRepository } from '../artifacts/repository'
import {
  DesktopOptimizationManager,
  readDesktopOptimizationResume,
  type DesktopOptimizationManagerOptions
} from './desktop-optimization-manager'
import { createPersistentCandidateOwners } from './persistent-candidate-owner'
import { runPersistentOptimization } from './run-persistent-optimization'
import type { ExecutionRecord } from '../../shared/earthnano/execution-port'
import type { StartDesktopSweep } from '../../shared/earthnano/optimization-sweep'
import type { OptimizationProgress } from '../../shared/earthnano/desktop-optimization'
import type { ExecutionState } from './execution-core'

const it = baseIt.skipIf(process.platform === 'win32')

configureTestRuntimeMetadata()

// The transport creates protocol files without executing a remote command. This acceptance proves
// the original Desktop/Harness/Core/Compute/persistence composition, not SSH or scientific accuracy.
const sourcePrompt = [
  'This is an explicitly controlled Compute protocol fixture, not remote science.',
  "Use repl_execute with this exact positional API call: await host.compute.create('ssh:fixture').submitJob('EarthNano controlled protocol fixture','printf protocol-workload',{outputs:['metrics.json','figure.png'],timeoutSeconds:30}). Do not replace those three positional arguments with one object.",
  'Submit exactly once. End the initial Turn after its receipt. Await the original background result delivery.',
  "In that continuation use the original exact API await host.compute.create('ssh:fixture').attachJob(the_delivered_job_id).result(), require result_final, then use require('node:fs') to read the harvested metrics.json at '../'+its featured_files path.",
  'Read the exact harvested metrics.json bytes with fs.readFileSync and write that Buffer unchanged to metrics-source.json with fs.writeFileSync. Compute count, sum and arithmetic mean from its actual values array. Write research-results.json in the current directory with exactly the three numeric fields count, sum and mean; put no metadata or additional fields in that report.',
  'Use the same readFileSync/writeFileSync Buffer operations to copy the harvested figure.png to measurements.png. Publish metrics-source.json, research-results.json and measurements.png through write_artifact_file with localPath sources and the actual repl_execute producerRunId returned by the original tool.',
  'Never resubmit an existing Job or invent a producer ID. The PNG is a fixture asset, not a newly computed plot.'
].join('\n')

it('runs the frozen Compute task through original desktop sweep, Harness k=2 and independent reviews', async () => {
  const live = process.env.EARTHNANO_LIVE_DEEPSEEK === '1'
  const retainedReportPath = process.env.EARTHNANO_COMPUTE_RESUME_REPORT
  const retained = retainedReportPath
    ? (JSON.parse(await readFile(retainedReportPath, 'utf8')) as {
        sourceSha: string
        fixtureRoot: string
        live: boolean
        controlledModelRequestBudget?: { previouslyUsed: number }
        progress: OptimizationProgress
        journal: ExecutionState
        transport: ComputeWorkflowFixture['transport']['calls']
        provider: Awaited<ReturnType<typeof createEarthnanoMessagesProvider>>['stats']
        resumedFrom?: {
          originalTransport: ComputeWorkflowFixture['transport']['calls']
          originalProvider: Awaited<ReturnType<typeof createEarthnanoMessagesProvider>>['stats']
        }
      })
    : undefined
  if (retained) expect(retained.live).toBe(live)
  const originalTransport = retained?.resumedFrom?.originalTransport ?? retained?.transport
  const originalProvider = retained?.resumedFrom?.originalProvider ?? retained?.provider
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
  if (live && dirty) throw new Error('Live Compute acceptance requires a clean source commit')
  const executablePath = createRequire(import.meta.url).resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`
  )
  const nativeVersion = execFileSync(executablePath, ['--version'], { encoding: 'utf8' }).trim()
  const runtimeVersion = /\b\d+\.\d+\.\d+\b/.exec(nativeVersion)?.[0]
  if (!runtimeVersion) throw new Error('Actual native Claude runtime version unavailable')
  const python = execFileSync(
    process.env.EARTHNANO_RESEARCH_PYTHON ?? 'python3',
    ['-c', 'import sys;print(sys.executable)'],
    { encoding: 'utf8' }
  ).trim()
  const previousModelRequests =
    (retained?.controlledModelRequestBudget?.previouslyUsed ?? 0) +
    (retained?.provider.requests ?? 0)
  const modelRequestsRemaining = 240 - previousModelRequests
  if (!Number.isSafeInteger(modelRequestsRemaining) || modelRequestsRemaining <= 0)
    throw new Error('Original controlled model-request budget is exhausted')
  let loopbackPort: number | undefined
  if (retained) {
    const { manifest } = readDesktopOptimizationResume(
      join(retained.fixtureRoot, 'earthnano', 'desktop-runs', retained.progress.runId, 'execution')
    )
    const wanted = manifest.identity.sweep?.tasks[0].input.agent.providerRef
    // The original fixture chose a random local port and deliberately never persisted credentials.
    // Restore that nonsecret endpoint by its original provider revision, without relaxing identity.
    for (let port = 1; port <= 65535; port++) {
      const digest = createHash('sha256')
        .update(
          JSON.stringify({
            type: 'custom',
            model: 'deepseek-flash',
            baseUrl: `http://127.0.0.1:${port}`,
            apiEndpoints: ['messages']
          })
        )
        .digest('hex')
      if (`desktop-provider:controlled-compute:${digest}` === wanted) {
        loopbackPort = port
        break
      }
    }
    if (!loopbackPort) throw new Error('Original controlled provider endpoint unavailable')
  }
  const provider = await createEarthnanoMessagesProvider(live, true, false, {
    scientificCompute: true,
    scientificFigure: true,
    // Independent transport ceiling for this full k=2 experiment, including original retries and
    // both reviewers and all retained attempts. It never raises the Core admission budget.
    maxModelRequests: modelRequestsRemaining,
    ...(loopbackPort ? { loopbackPort } : {}),
    ...(process.env.EARTHNANO_DEEPSEEK_KEY_FILE
      ? { keyFile: process.env.EARTHNANO_DEEPSEEK_KEY_FILE }
      : {})
  })
  let report: Record<string, unknown> = {
    sourceSha,
    dirty: Boolean(dirty),
    live,
    controlledProviderEndpoint: provider.url,
    controlledModelRequestBudget: {
      limit: 240,
      previouslyUsed: previousModelRequests,
      remainingBeforeRun: modelRequestsRemaining
    },
    native: {
      executablePath,
      nativeVersion,
      sha256: createHash('sha256')
        .update(await readFile(executablePath))
        .digest('hex')
    },
    limitations: [
      'Host composition acceptance; no renderer launch or final package claim.',
      'External Compute connection and cipher are fixtures. No SSH, remote command, Slurm or OS-keychain claim.',
      'Actual harvested fixture bytes are analyzed by original Node. No remote scientific improvement claim.',
      'Proxy counters are observations, not a production cost ledger; API/USD total remains unknown.'
    ]
  }
  onTestFinished(async () => {
    try {
      const reportPath = process.env.EARTHNANO_COMPUTE_ACCEPTANCE_REPORT
      if (reportPath) {
        await mkdir(dirname(reportPath), { recursive: true })
        await writeFile(
          reportPath,
          JSON.stringify({ ...report, provider: provider.stats }, null, 2)
        )
      }
    } finally {
      await provider.close()
      vi.unstubAllEnvs()
    }
  })
  const f = await createComputeWorkflowFixture({
    mode: 'authorized',
    sourcePrompt,
    ...(retained ? { reopenRoot: retained.fixtureRoot } : {})
  })
  if (retained)
    report.resumedFrom = {
      sourceSha: retained.sourceSha,
      reportPath: retainedReportPath,
      runId: retained.progress.runId,
      budget: retained.progress.budget,
      originalTransport,
      originalProvider
    }
  report.fixtureRoot = f.root
  vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', f.configRoot)
  expect(resolveConfigRoot()).toBe(f.configRoot)
  expect(resolveDataRoot()).toBe(f.root)
  const sourceBefore = await loadSessionMutationAuthority(
    f.sessions,
    f.projectId,
    f.sourceSessionId
  )
  const providerSettings = {
    providerId: 'controlled-compute',
    provider: {
      type: 'custom' as const,
      model: 'deepseek-flash',
      key: provider.token,
      baseUrl: provider.url,
      apiEndpoints: ['messages' as const]
    },
    reasoningEffortProfile: { supported: false as const }
  }
  const releases = vi.fn()
  const validateSession = async (projectId: string, sessionId: string): Promise<void> => {
    await f.ports.sessionPersistence!.coordinator.assertSessionAvailable(projectId, sessionId)
    const current = await loadSessionMutationAuthority(f.sessions, projectId, sessionId)
    if (
      current.status !== 'found' ||
      current.session.projectId !== projectId ||
      current.session.archivedAt ||
      current.session.packageOrigin
    )
      throw new Error('Original source authority unavailable')
  }
  const dependencies: DesktopOptimizationDependencies = {
    settings: {
      getStoredSettings: () => f.ports.settings!.getSettings(),
      captureActiveExplicitAgentBackendTarget: async () => ({
        frameworkId: 'claude-code',
        providerId: providerSettings.providerId,
        model: { kind: 'required', id: providerSettings.provider.model },
        reasoningEffort: 'default'
      }),
      resolveIsolatedClaudeProvider: async () => providerSettings,
      resolveIsolatedClaudeExecutable: async () => executablePath
    },
    harnessRoot: resolve('vendor/harness2'),
    resolvePython: async () => python,
    probeClaudeVersion: async () => runtimeVersion,
    validateSession,
    // Standalone owned project: there is no concurrent archive/update UI in this fixture.
    admitSessionWork: () => releases,
    loadSession: async (projectId, sessionId) => {
      const current = await loadSessionMutationAuthority(f.sessions, projectId, sessionId)
      if (current.status !== 'found') throw new Error('Source Session missing')
      return current.session
    },
    versions: f.versions,
    notebook: f.notebook,
    compute: f.compute,
    sessionPersistence: f.ports.sessionPersistence,
    onOwnersReady: f.onOwnersReady
  }
  const executionRoot = join(f.root, 'earthnano', 'desktop-runs')
  const options: DesktopOptimizationManagerOptions = {
    root: join(f.configRoot, 'earthnano-desktop'),
    executionRoot: () => executionRoot,
    readResume: async (runId) =>
      readDesktopOptimizationResume(join(executionRoot, runId, 'execution')),
    validateSession,
    createOptions: async () => {
      throw new Error('Unexpected alternate single-task execution path')
    },
    previewSweep: (request, signal) =>
      createDesktopSweepPreview(request, { ...dependencies, signal }),
    createSweepOptions: async (request, signal) => ({
      ...(await createDesktopSweepOptions(request, { ...dependencies, signal })),
      executionTimeoutMs: 180_000,
      timeoutMs: live ? 1_200_000 : 600_000
    }),
    // Observe the real function's failure before the original manager intentionally sanitizes UI
    // errors. The entire persisted method/Core/driver remains the production implementation.
    run: async (input) => {
      try {
        return await runPersistentOptimization(input)
      } catch (error) {
        report.failure = String(error)
        throw error
      }
    }
  }
  const manager = new DesktopOptimizationManager(options)
  const owned: {
    reader?: ReturnType<typeof createPersistentCandidateOwners>
    key?: { projectId: string; sourceSessionId: string; runId: string }
  } = {}
  onTestFinished(async () => {
    const failures: unknown[] = []
    const attempt = async (work: () => unknown): Promise<void> => {
      try {
        await work()
      } catch (error) {
        failures.push(error)
      }
    }
    await attempt(async () => {
      expect(await manager.shutdown()).toEqual({ reaped: true })
      if (owned.reader) expect(await owned.reader.shutdown()).toEqual({ reaped: true })
    })
    await attempt(async () => {
      if (owned.key) {
        report.progress = await manager.get(owned.key)
        report.journal = JSON.parse(
          await readFile(
            join(executionRoot, owned.key.runId, 'execution', 'execution.json'),
            'utf8'
          )
        )
        try {
          report.failureDiagnostics = await readFile(
            join(executionRoot, owned.key.runId, 'execution', 'failure-diagnostics.jsonl'),
            'utf8'
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      report.changes = f.changes
      report.transport = f.transport.calls
    })
    await attempt(() => disconnectProjectDbClient())
    await attempt(() =>
      f.close({ preserveEvidence: Boolean(process.env.EARTHNANO_COMPUTE_ACCEPTANCE_REPORT) })
    )
    if (failures.length)
      throw new AggregateError(failures, 'Original workflow cleanup/report failed')
  })
  const request: StartDesktopSweep = {
    projectId: f.projectId,
    sourceSessionId: f.sourceSessionId,
    requestKey: 'compute-original-harness-k2',
    // Same bounded headroom as the existing live scientific acceptance. Original proposal retries
    // consume this budget; no experiment can raise its limit after admission.
    executionLimit: 24,
    catalog: [
      {
        taskId: 'compute-fixture',
        domain: 'controlled-protocol',
        sourceSessionId: f.sourceSessionId,
        source: { kind: 'compute', promptMessageId: f.sourcePromptMessageId! },
        criteria:
          'Read the published original metrics-source.json Version and independently recompute count, sum and arithmetic mean from its values array. Verify research-results.json matches those values: count 3, sum 12 and mean 4. Require the source Version as evidence, not an assumed fixture constant.\nThis numerical assessment does not require a visual or scientific conclusion about the PNG. Native Read and separate byte assertions validate the copied fixture asset; it is not a new plot or evidence of remote science.',
        checks: [
          { kind: 'json-value', path: 'research-results.json', pointer: '/count', expected: 3 },
          { kind: 'json-value', path: 'research-results.json', pointer: '/sum', expected: 12 },
          { kind: 'json-value', path: 'research-results.json', pointer: '/mean', expected: 4 }
        ]
      }
    ],
    sweep: {
      modes: ['parallel'],
      k: 2,
      concurrency: 2,
      stream: { seed: 0, onlyDomains: [], onlyTasks: [], maxTasks: null, workers: 1 }
    }
  }
  const preview = await manager.previewSweep({
    projectId: request.projectId,
    sourceSessionId: request.sourceSessionId,
    sweep: request.sweep,
    catalog: request.catalog.map(({ taskId, domain }) => ({ taskId, domain }))
  })
  expect(provider.stats.requests).toBe(0)
  const previousJobs = retained
    ? Object.values(retained.journal.records).filter((record) =>
        ['baseline', 'candidate'].includes(record.request.role)
      ).length
    : 0
  expect(await f.client.computeJob.count()).toBe(previousJobs)
  request.previewPlanDigest = preview.planDigest
  if (!retained) await f.start()
  const started = retained
    ? await manager.resume({
        projectId: f.projectId,
        sourceSessionId: f.sourceSessionId,
        runId: retained.progress.runId
      })
    : await manager.startSweep(request)
  const key = { projectId: f.projectId, sourceSessionId: f.sourceSessionId, runId: started.runId }
  owned.key = key
  await vi.waitFor(
    async () => {
      const progress = await manager.get(key)
      expect(['completed', 'failed', 'cancelled', 'interrupted']).toContain(progress.state)
    },
    { timeout: live ? 1_220_000 : 620_000, interval: 500 }
  )
  const completed = await manager.get(key)
  report.progress = completed
  expect(completed, JSON.stringify(completed)).toMatchObject({ state: 'completed' })
  expect(completed.budget.limit).toBe(request.executionLimit)
  expect(completed.budget.admitted).toBeGreaterThanOrEqual(preview.minimumExecutions)
  expect(completed.budget.admitted).toBeLessThanOrEqual(request.executionLimit)
  expect(completed.budget.active).toBe(0)
  expect(completed.budget.completed).toBe(completed.budget.admitted)
  const journal = readDesktopOptimizationResume(join(executionRoot, key.runId, 'execution'))
  expect(journal.records).toHaveLength(completed.budget.admitted)
  expect(
    journal.records.every(
      (record) => record.phase === 'completed' && record.cleanup === 'confirmed'
    )
  ).toBe(true)
  const state = JSON.parse(
    await readFile(join(executionRoot, key.runId, 'execution', 'execution.json'), 'utf8')
  ) as { records: Record<string, ExecutionRecord> }
  const records = Object.values(state.records)
  for (const role of [
    'baseline',
    'candidate',
    'proposer',
    'composer',
    'selector',
    'reflection',
    'reviewer'
  ])
    expect(
      records.some((record) => record.request.role === role),
      role
    ).toBe(true)
  const taskRecords = records.filter((record) =>
    ['baseline', 'candidate'].includes(record.request.role)
  )
  if (retained) {
    expect(taskRecords).toEqual(
      Object.values(retained.journal.records).filter((record) =>
        ['baseline', 'candidate'].includes(record.request.role)
      )
    )
    expect(
      records
        .filter((record) => !retained.journal.records[record.executionId])
        .every((record) => record.request.role === 'reviewer')
    ).toBe(true)
    expect(Object.keys(provider.stats.roles).every((role) => role === 'reviewer')).toBe(true)
    expect(f.transport.calls).toEqual([])
  }
  expect(new Set(taskRecords.map((record) => record.request.taskSnapshotRef.digest)).size).toBe(1)
  expect(new Set(taskRecords.map((record) => record.request.environmentSpecRef.digest)).size).toBe(
    1
  )
  expect(
    new Set(taskRecords.map((record) => record.request.harnessRevisionRef.digest)).size
  ).toBeGreaterThan(1)
  expect(new Set(taskRecords.map((record) => record.identity.sessionId)).size).toBe(
    taskRecords.length
  )
  const reader = createPersistentCandidateOwners({
    ...f.ports,
    dataRoot: f.root,
    configRoot: f.configRoot,
    getClient: f.getClient,
    artifactProjectionRoot: join(f.root, 'acceptance-artifact-projections'),
    notebook: f.notebook,
    compute: f.compute
  })
  owned.reader = reader
  const nativeRuns = new NotebookRunRepository(f.root)
  const provenance = new ArtifactProvenanceRepository({
    storageRoot: f.root,
    getClient: f.getClient,
    compatibilityRepository: new ArtifactRepository(f.root),
    loadSession: async (projectId, sessionId) => {
      const original = await loadSessionMutationAuthority(f.sessions, projectId, sessionId)
      if (original.status !== 'found') throw new Error('Original producer Session missing')
      return original.session
    }
  })
  const outputs: unknown[] = []
  report.outputs = outputs
  for (const record of taskRecords) {
    const jobs = await f.jobs.findByOwner({
      projectId: f.projectId,
      sessionId: record.identity.sessionId!
    })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      status: 'success',
      exit_code: 0,
      harvested_at: expect.any(Number),
      notified_at: expect.any(Number),
      producer_run_id: expect.any(String)
    })
    expect(jobs[0].harvest_error).toBeUndefined()
    const runs = await nativeRuns.readSessionRuns(f.projectId, record.identity.sessionId!)
    expect(runs.length).toBeGreaterThanOrEqual(2)
    // Original Notebook permits a failed tool call followed by a successful correction. Preserve
    // every attempt, require no in-flight Run, and prove each published Version's actual producer.
    expect(
      runs.every(
        (run) => run.status !== 'queued' && run.status !== 'running' && Number.isFinite(run.endedAt)
      )
    ).toBe(true)
    expect(new Set(runs.map((run) => run.promptMessageId)).size).toBe(2)
    const exported = await reader.exportResult(record)
    const producers: unknown[] = []
    for (const file of exported.files) {
      const { execution } = await provenance.getVersionExecution({
        projectId: f.projectId,
        appSessionId: record.identity.sessionId!,
        artifactId: file.artifactRef.artifactId,
        versionId: file.artifactRef.versionId
      })
      expect(execution).toBeDefined()
      const producer = runs.find((run) => run.runId === execution?.producerRunId)
      expect(producer).toMatchObject({
        status: 'completed',
        endedAt: expect.any(Number),
        promptMessageId: execution!.terminalPromptMessageId
      })
      expect(producer!.promptMessageId).not.toBe(record.identity.promptMessageId)
      producers.push({ artifactRef: file.artifactRef, execution })
    }
    const source = exported.files.find((file) => file.path === 'metrics-source.json')
    if (!source || !('content' in source))
      throw new Error('Original metrics source Version missing')
    expect(jobs[0].remote_workdir).toEqual(expect.any(String))
    const transportMetricsPath = join(jobs[0].remote_workdir!, 'metrics.json')
    expect(originalTransport ?? f.transport.calls).toContainEqual({
      kind: 'download',
      path: transportMetricsPath
    })
    expect(Buffer.from(source.content, 'utf8')).toEqual(await readFile(transportMetricsPath))
    const result = exported.files.find((file) => file.path === 'research-results.json')
    if (!result || !('content' in result)) throw new Error('Original text report missing')
    expect(JSON.parse(result.content)).toEqual({ count: 3, sum: 12, mean: 4 })
    const figure = exported.files.find((file) => file.path === 'measurements.png')
    if (!figure || !('representation' in figure) || figure.representation !== 'binary')
      throw new Error('Original binary figure missing')
    const png = await readFile(
      (await reader.materializeArtifact!(record, figure.artifactRef)).assetPath
    )
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(png).toEqual(await readFile(join(jobs[0].remote_workdir!, 'figure.png')))
    expect((await reader.readReviews(record)).length).toBeGreaterThan(0)
    outputs.push({ record: record.executionId, jobs, runs, exported, producers })
  }
  const summary = completed.sweep?.domains[0].summary.tasks[0]
  expect(summary?.selection).toMatchObject({ trivial: false, fallback: false })
  expect(summary?.assessments?.baseline.outcome).toBe('pass')
  expect(summary?.assessments?.candidate.outcome).toBe('pass')
  expect(summary?.outcome?.artifact.status).toBe('passed')
  const reflection = records.filter((record) => record.request.role === 'reflection')
  expect(reflection).toHaveLength(1)
  const reflected = await reader.exportResult(reflection[0]!)
  const reply = reflected.files.find((file) => file.path === 'reflection-reply.md')
  if (!reply || !('content' in reply)) throw new Error('Original reflection Version missing')
  expect(reply.content).toBe(reflected.replyText)
  expect(reply.digest).toBe('sha256:' + createHash('sha256').update(reply.content).digest('hex'))
  const library = completed.sweep!.domains[0]!.summary.library
  if (library.entries.includes(summary!.taskId)) {
    expect(summary?.experience?.reflectionExecutionId).toBe(reflection[0]!.executionId)
  } else {
    // Original Harness _distil returns {} for NO_ENTRY or an incomplete experience block.
    // Preserve that outcome rather than inventing a lesson or requiring another paid run.
    const block = /<experience>([\s\S]*?)<\/experience>/.exec(reflected.replyText)?.[1]
    const fields = new Map<string, string>()
    for (const line of block?.split(/\r?\n/) ?? []) {
      const colon = line.indexOf(':')
      if (colon >= 0)
        fields.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
    }
    expect(['cue', 'lesson', 'evidence'].every((field) => fields.get(field))).toBe(false)
    expect(library.entries).toEqual([])
    expect(summary?.experience).toBeUndefined()
  }
  report.reflection = {
    executionId: reflection[0]!.executionId,
    exported: reflected,
    retainedLibraryEntry: library.entries.includes(summary!.taskId)
  }
  expect(
    (originalProvider ?? provider.stats).imageToolResults?.some(
      (result) => result.role === 'selector'
    )
  ).toBe(true)
  expect(f.approvalId).not.toHaveBeenCalled()
  expect(f.approvalBroadcast).not.toHaveBeenCalled()
  expect(await f.grants.list()).toHaveLength(1)
  expect(await loadSessionMutationAuthority(f.sessions, f.projectId, f.sourceSessionId)).toEqual(
    sourceBefore
  )
  expect(await f.client.computeJob.count()).toBe(taskRecords.length)
  report = { ...report, preview, outputs, sameFrozenTask: true, originalHarnessK2: true }
  if (retained?.progress.state === 'completed') expect(provider.stats.requests).toBe(0)
  if (live)
    expect(
      provider.stats.upstreamRequests + (originalProvider?.upstreamRequests ?? 0)
    ).toBeGreaterThan(0)
  else expect(provider.stats.upstreamRequests).toBe(0)
  expect(await manager.shutdown()).toEqual({ reaped: true })
  const beforeReopen = structuredClone(provider.stats)
  const reopened = new DesktopOptimizationManager(options)
  expect(await reopened.get(key)).toEqual(completed)
  expect(await reopened.shutdown()).toEqual({ reaped: true })
  expect(provider.stats).toEqual(beforeReopen)
  expect(await f.client.computeJob.count()).toBe(taskRecords.length)
  report.reopenWithoutReplay = true
}, 1_280_000)
