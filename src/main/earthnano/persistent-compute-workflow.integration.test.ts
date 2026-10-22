import { createRequire } from 'node:module'
import { createServer, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, it as baseIt, onTestFinished, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false } }))
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { createComputeWorkflowFixture } from '../../../test/earthnano/compute-workflow'
import { loadSessionMutationAuthority } from '../session-persistence/repository'
import { NotebookRunRepository } from '../notebook/repository'
import { createCandidateSnapshotStore } from './candidate-snapshot'
import { createPersistentCandidateOwners } from './persistent-candidate-owner'
import { createClaudeCandidateDriver } from './claude-candidate-driver'
import { ExecutionCore } from './execution-core'
import { FileExecutionStore } from './execution-store'
import type { ExecutionRequest } from '../../shared/earthnano/execution-port'

const it = baseIt.skipIf(process.platform === 'win32')

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64'
)
type Block = { type: string; name?: string; content?: unknown; input?: Record<string, unknown> }
type Body = {
  model: string
  tools?: { name: string }[]
  messages: { role: string; content: string | Block[] }[]
}
const emit = (
  response: ServerResponse,
  model: string,
  content: { text: string } | { name: string; input: object }
): void => {
  const tool = 'name' in content
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'local-fixture',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 }
        }
      }
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: tool
          ? { type: 'tool_use', id: `local-${Date.now()}`, name: content.name, input: {} }
          : { type: 'text', text: '' }
      }
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: tool
          ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) }
          : { type: 'text_delta', text: content.text }
      }
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 }
      }
    ],
    ['message_stop', { type: 'message_stop' }]
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  )
}
const nestedRunIds = (value: unknown): string[] => {
  if (typeof value === 'string') {
    try {
      return nestedRunIds(JSON.parse(value))
    } catch {
      return []
    }
  }
  if (Array.isArray(value)) return value.flatMap(nestedRunIds)
  if (!value || typeof value !== 'object') return []
  const object = value as Record<string, unknown>
  return [
    ...(typeof object.runId === 'string' ? [object.runId] : []),
    ...(object.activityKind === 'notebook-run' && typeof object.activityId === 'string'
      ? [object.activityId]
      : []),
    ...Object.values(object).flatMap(nestedRunIds)
  ]
}

configureTestRuntimeMetadata()

// Every state owner below is original. Native messages use a fixed local provider; remote wire
// operations and the local cipher port are fixtures, not SSH/Linux/Slurm/OS-keychain certification.
it.each(['authorized', 'no-grant', 'protection-unavailable'] as const)(
  'runs original candidate Compute workflow with %s',
  async (mode) => {
    const sourcePrompt =
      mode === 'authorized' ? 'Compute workflow source from the original fixture.' : undefined
    const fixture = await createComputeWorkflowFixture({
      mode,
      ...(sourcePrompt ? { sourcePrompt } : {})
    })
    const {
      root,
      configRoot,
      projectId,
      sourceSessionId,
      client,
      ports,
      jobs,
      deliveries,
      transport,
      grants,
      approvalId,
      approvalBroadcast,
      service,
      changes,
      frozenCompute,
      sessions
    } = fixture
    expect(jobs.isFieldProtectionAvailable()).toBe(mode !== 'protection-unavailable')
    if (sourcePrompt) {
      expect(fixture.sourcePromptMessageId).toBeTruthy()
      const source = await loadSessionMutationAuthority(sessions, projectId, sourceSessionId)
      expect(source.status).toBe('found')
      if (source.status !== 'found') throw new Error('Missing original source Session')
      expect(
        source.session.conversationGraph?.messages.find(
          (message) => message.id === fixture.sourcePromptMessageId
        )
      ).toMatchObject({ role: 'user', content: sourcePrompt, status: 'complete' })
    } else expect(fixture.sourcePromptMessageId).toBeUndefined()
    const ownerOptions = {
      ...ports,
      dataRoot: root,
      configRoot,
      getClient: fixture.getClient,
      artifactProjectionRoot: join(root, 'projections'),
      notebook: fixture.notebook,
      compute: fixture.compute
    }
    const owners = createPersistentCandidateOwners(ownerOptions)
    const release = fixture.onOwnersReady(owners)
    const idleOwners = createPersistentCandidateOwners(ownerOptions)
    const releaseIdle = fixture.onOwnersReady(idleOwners)
    let stage = 0,
      modelRequests = 0
    const providerErrors: string[] = []
    const server = createServer(async (request, response) => {
      try {
        if (request.method === 'HEAD') {
          response.writeHead(200)
          response.end()
          return
        }
        let text = ''
        for await (const chunk of request) text += chunk
        if (request.url?.includes('count_tokens')) {
          response.writeHead(404)
          response.end()
          return
        }
        const body = JSON.parse(text) as Body
        modelRequests++
        if (!body.tools?.some((tool) => tool.name.endsWith('repl_execute'))) {
          emit(response, body.model, { text: 'Original workflow fixture' })
          return
        }
        const call = (suffix: string, input: object): void => {
          const tool = body.tools!.find((tool) => tool.name.endsWith(suffix))
          if (!tool) throw new Error('Original tool missing')
          emit(response, body.model, { name: tool.name, input })
        }
        const runs = nestedRunIds(body.messages),
          next = stage++
        if (next === 0)
          return call('repl_execute', {
            code: "const receipt=await host.compute.create('ssh:fixture').submitJob('workflow fixture','printf protocol-workload',{outputs:['metrics.json','figure.png'],timeoutSeconds:30});console.log(JSON.stringify(receipt));"
          })
        if (next === 1) {
          emit(response, body.model, { text: 'Submission settled; await original full result.' })
          return
        }
        if (next === 2)
          return call('repl_execute', {
            code: "const result=await host.compute.create('ssh:fixture').attachJob(receipt.job_id).result();if(!result.result_final)throw new Error('Result is not final');const fs=require('node:fs');const metrics=JSON.parse(fs.readFileSync('../'+result.featured_files.find(p=>p.endsWith('metrics.json')),'utf8'));fs.writeFileSync('report.json',JSON.stringify({count:metrics.values.length,mean:metrics.values.reduce((a,b)=>a+b,0)/metrics.values.length}),{flag:'wx'});fs.writeFileSync('derived.png',fs.readFileSync('../'+result.featured_files.find(p=>p.endsWith('figure.png'))),{flag:'wx'});console.log('Derived from original harvested bytes');"
          })
        if (next === 3 || next === 4) {
          const filename = next === 3 ? 'report.json' : 'derived.png'
          return call('write_artifact_file', {
            filename,
            mimeType: next === 3 ? 'application/json' : 'image/png',
            source: { kind: 'localPath', path: filename },
            producerRunId: runs.at(-1)
          })
        }
        emit(response, body.model, {
          text: 'Original state owners completed the protocol workflow.'
        })
      } catch (error) {
        providerErrors.push(String(error))
        response.statusCode = 500
        response.end('Bounded fixture failure')
      }
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const handleOwner: { core?: ExecutionCore } = {}
    const journal = new FileExecutionStore(join(root, 'execution.json'))
    onTestFinished(async () => {
      handleOwner.core?.dispose()
      const retired = await owners.shutdown()
      if (retired.reaped) release?.()
      const idleRetired = await idleOwners.shutdown()
      expect(idleRetired).toEqual({ reaped: true })
      if (idleRetired.reaped) releaseIdle?.()
      journal.close()
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
      await fixture.close()
    })
    const store = await createCandidateSnapshotStore({
      root: join(root, 'snapshots'),
      candidatesRoot: join(root, 'candidates')
    })
    const refs = await store.freeze({
      task: { prompt: 'Compute fixture', files: [] },
      harness: {
        instructions: 'Use original Compute, never fabricate its results.',
        skills: [],
        tools: 'notebook-compute'
      },
      agent: {
        backend: 'claude-code',
        model: 'local-fixture',
        providerRef: 'local-only',
        runtimeVersion: '2.1.232'
      },
      environment: {
        isolation: 'directory-process',
        network: 'provider-and-notebook-policy',
        compute: frozenCompute
      }
    })
    const invocationRef = await store.freezeInvocation({
      taskSnapshotRef: refs.taskSnapshotRef,
      harnessRevisionRef: refs.harnessRevisionRef,
      mission: 'Original asynchronous Compute ownership fixture'
    })
    const core = new ExecutionCore(
      journal,
      createClaudeCandidateDriver({
        snapshots: store,
        openOwner: (input) => owners.openOwner(input),
        binding: async (agent) => ({
          executablePath: createRequire(import.meta.url).resolve(
            `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`
          ),
          runtimeVersion: agent.runtimeVersion,
          providerRef: agent.providerRef,
          provider: {
            type: 'custom',
            model: agent.model,
            key: 'local-fixture-token',
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            apiEndpoints: ['messages']
          }
        })
      })
    )
    handleOwner.core = core
    const request: ExecutionRequest = {
      contractVersion: 1,
      requestKey: 'compute-workflow',
      projectId,
      ...refs,
      invocationRef,
      role: 'candidate',
      origin: {
        kind: 'optimization',
        sessionId: sourceSessionId,
        optimizationId: 'workflow',
        stageId: 'candidate'
      },
      interactionPolicy: 'deny-unresolved',
      budgetRef: 'one',
      timeoutMs: 60_000
    }
    core.configureBudget(projectId, 'one', 1)
    const handle = await core.submit(request)
    if (mode !== 'authorized') {
      const rejected = await core.waitForTerminal(handle.executionId)
      expect(rejected).toMatchObject({ phase: 'failed', cleanup: 'confirmed' })
      expect(
        await jobs.findByOwner({ projectId, sessionId: rejected.identity.sessionId! })
      ).toEqual([])
      const deniedRuns = await new NotebookRunRepository(root).readSessionRuns(
        projectId,
        rejected.identity.sessionId!
      )
      expect(deniedRuns).toHaveLength(1)
      expect(deniedRuns[0].status).toBe('failed')
      expect(deniedRuns[0].script).toContain('.submitJob(')
      expect(deniedRuns[0].text.stderr + deniedRuns[0].text.traceback).toMatch(
        /approval_denied|Approval denied|approval was denied/
      )
      expect(await client.computeJob.count()).toBe(0)
      expect(await client.computeJobOperation.count()).toBe(0)
      expect(transport.calls).toEqual([])
      expect(approvalBroadcast).not.toHaveBeenCalled()
      expect(approvalId).not.toHaveBeenCalled()
      expect(await grants.list()).toHaveLength(mode === 'no-grant' ? 0 : 1)
      expect(providerErrors).toEqual([])
      return
    }
    let privateId = ''
    await vi.waitFor(
      async () => {
        const current = await core!.get(handle.executionId)
        privateId = current.identity.sessionId ?? ''
        const rows = privateId ? await jobs.findByOwner({ projectId, sessionId: privateId }) : []
        expect(
          rows,
          JSON.stringify({
            phase: current.phase,
            error: current.error,
            stage,
            changes,
            transport: transport.calls
          })
        ).toHaveLength(1)
        expect(rows[0]).toMatchObject({ status: 'queued', producer_run_id: expect.any(String) })
      },
      { timeout: 20_000 }
    )
    await vi.waitFor(
      async () => {
        const current = await loadSessionMutationAuthority(sessions, projectId, privateId)
        expect(current.status === 'found' && !current.session.activeRun).toBe(true)
      },
      { timeout: 20_000 }
    )
    const initial = await core.get(handle.executionId)
    expect(initial.phase).toBe('running')
    expect(transport.calls).toEqual([])
    const [queued] = await jobs.findByOwner({ projectId, sessionId: privateId })
    expect(
      await service.getJobStatus(queued.job_id, {
        projectId,
        sessionId: privateId,
        providerId: 'ssh:fixture'
      })
    ).toMatchObject({
      status: 'queued',
      result_final: false,
      queue_blocked_reason: 'runtime_stopped'
    })
    await fixture.start()
    const record = await core.waitForTerminal(handle.executionId)
    expect(
      record,
      JSON.stringify({
        phase: record.phase,
        error: record.error,
        stage,
        changes,
        transport: transport.calls,
        providerErrors
      })
    ).toMatchObject({ phase: 'completed', cleanup: 'confirmed', identity: initial.identity })
    const final = await jobs.get(queued.job_id)
    expect(final).toMatchObject({
      status: 'success',
      exit_code: 0,
      harvested_at: expect.any(Number),
      notified_at: expect.any(Number),
      producer_run_id: queued.producer_run_id
    })
    expect(final?.harvest_error).toBeUndefined()
    const protectedRow = await client.computeJob.findUniqueOrThrow({ where: { id: queued.job_id } })
    expect(protectedRow.command).not.toContain('protocol-workload')
    expect(protectedRow.stdoutTail).not.toContain('protocol-fixture')
    expect(final?.file_evidence).toMatchObject({
      activityKind: 'compute-job',
      activityId: queued.job_id,
      parentActivityId: queued.producer_run_id,
      checksum: expect.any(String)
    })
    expect(changes.map((change) => change.status)).toEqual(
      expect.arrayContaining(['queued', 'submitted', 'running', 'success'])
    )
    expect(transport.calls.map((call) => call.kind)).toEqual(
      expect.arrayContaining(['dispatch', 'poll', 'enumerate', 'download', 'stat'])
    )
    expect(transport.commands).toEqual(['printf protocol-workload'])
    expect(transport.calls.some((call) => call.kind === 'acquire:job_cleanup')).toBe(false)
    expect(await client.computeJobOperation.count()).toBe(0)
    const delivery = await deliveries.findBySource({
      sourceKind: 'compute-job',
      sourceId: queued.job_id,
      projectId,
      sessionId: privateId
    })
    expect(delivery).toMatchObject({ state: 'consumed', continuationMessageId: expect.any(String) })
    const runs = await new NotebookRunRepository(root).readSessionRuns(projectId, privateId)
    expect(runs).toHaveLength(2)
    expect(runs.every((run) => run.status === 'completed' && run.kernelKind === 'repl')).toBe(true)
    expect(new Set(runs.map((run) => run.promptMessageId)).size).toBe(2)
    const exported = await owners.exportResult(record)
    expect(exported.files.map((file) => file.path)).toEqual(['report.json', 'derived.png'])
    const report = exported.files[0]
    if (!('content' in report)) throw new Error('Missing original text report')
    expect(JSON.parse(report.content)).toEqual({ count: 3, mean: 4 })
    expect(
      await readFile(
        (await owners.materializeArtifact!(record, exported.files[1].artifactRef)).assetPath
      )
    ).toEqual(png)
    expect(await owners.readReviews(record)).toHaveLength(1)
    expect(
      await owners.commitDeterministicReview!({
        target: record,
        checks: [{ kind: 'json-value', path: 'report.json', pointer: '/mean', expected: 4 }]
      })
    ).toMatchObject({ outcome: 'pass', reviewId: expect.any(String) })
    expect(journal.load().budgets[JSON.stringify([projectId, 'one'])]).toEqual({
      limit: 1,
      admitted: 1
    })
    expect(approvalBroadcast).not.toHaveBeenCalled()
    expect(approvalId).not.toHaveBeenCalled()
    expect(providerErrors).toEqual([])
    expect(modelRequests).toBeGreaterThan(0)

    const retired = await owners.shutdown()
    expect(retired).toEqual({ reaped: true })
    if (retired.reaped) release?.()
  },
  90_000
)
