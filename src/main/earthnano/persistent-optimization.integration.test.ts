import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, chmod, lstat, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: true } }))
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { DesktopOptimizationManager } from './desktop-optimization-manager'
import type { PersistentOptimizationOptions } from './run-persistent-optimization'
import { ReviewRepository } from '../reviewer/repository'
import { runPersistentOptimization } from './run-persistent-optimization'
import { createPersistentCandidateOwners } from './persistent-candidate-owner'
import { FileExecutionStore } from './execution-store'
import { ExecutionCore } from './execution-core'
import { initDataRoot } from '../storage-root'

const stream = (
  response: ServerResponse,
  model: string,
  content: { text: string } | { name: string; input: unknown }
): void => {
  const id = randomUUID(),
    tool = 'name' in content
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id,
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
          ? { type: 'tool_use', id: `call_${id}`, name: content.name, input: {} }
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
        usage: { output_tokens: 10 }
      }
    ],
    ['message_stop', { type: 'message_stop' }]
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  )
}

async function exercise(live: boolean, desktop = false, stopEarly = false): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'earthnano-persistent-loop-'))
  const dataRoot = join(root, 'data'),
    configRoot = join(root, 'config')
  await mkdir(configRoot)
  await mkdir(dataRoot)
  initDataRoot(dataRoot)
  const client = createProjectDbClient(configRoot)
  const controllers = new Set<AbortController>()
  let requests = 0,
    rejects = 0
  const usage = { input: 0, cacheRead: 0, output: 0 }
  const readInputs = new Set<string>()
  const loopbackKey = randomUUID()
  let apiKey = ''
  const server = createServer(async (request, response) => {
    const reject = (): void => {
      rejects++
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'Bounded optimization test rejected this request'
          }
        })
      )
    }
    if (
      request.method !== 'POST' ||
      new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/v1/messages' ||
      request.headers.authorization !== `Bearer ${loopbackKey}`
    )
      return reject()
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 512_000) return reject()
        chunks.push(Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const userText = body.messages
        .filter((message: { role: string }) => message.role === 'user')
        .flatMap((message: { content: unknown }) =>
          typeof message.content === 'string'
            ? [message.content]
            : Array.isArray(message.content)
              ? message.content.filter((block) => block.type === 'text').map((block) => block.text)
              : []
        )
        .join('\n')
      const role = /EarthNano execution role: ([a-z]+)\./.exec(userText)?.[1]
      if (!role) {
        if (live) return reject()
        stream(response, body.model, { text: 'background' })
        return
      }
      const inputDirectory = /^INPUT: (.+)$/m.exec(userText)?.[1]?.trim()
      const allBlocks = body.messages.flatMap((message: { content: unknown }) =>
        Array.isArray(message.content) ? message.content : []
      )
      const readIds = new Set(
        allBlocks
          .filter(
            (block: {
              type?: string
              name?: string
              id?: string
              input?: { file_path?: string }
            }) =>
              block.type === 'tool_use' &&
              block.name === 'Read' &&
              inputDirectory &&
              block.input?.file_path === join(inputDirectory, 'values.csv')
          )
          .map((block: { id: string }) => block.id)
      )
      if (
        inputDirectory &&
        (role === 'baseline' || role === 'candidate') &&
        allBlocks.some(
          (block: { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }) =>
            block.type === 'tool_result' &&
            readIds.has(block.tool_use_id) &&
            !block.is_error &&
            JSON.stringify(block.content).includes('three,3')
        )
      )
        readInputs.add(inputDirectory)
      if (
        requests >= (desktop ? 48 : 32) ||
        body.model !== 'deepseek-flash' ||
        body.stream !== true
      )
        return reject()
      requests++
      if (stopEarly && role === 'baseline') return // Hold the real native prompt until Stop cancels it.
      if (live) {
        const controller = new AbortController()
        controllers.add(controller)
        const disconnected = (): void => {
          if (!response.writableEnded) controller.abort()
        }
        response.on('close', disconnected)
        try {
          body.max_tokens = Math.min(body.max_tokens ?? 1536, 1536)
          body.thinking = { type: 'disabled' }
          const upstream = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'anthropic-version': '2023-06-01',
              authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify(body),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)])
          })
          if (!upstream.ok || !upstream.body) {
            await upstream.body?.cancel()
            return reject()
          }
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          let pending = '',
            currentOutput = 0
          for await (const chunk of upstream.body) {
            response.write(chunk)
            pending += Buffer.from(chunk).toString('utf8')
            let newline: number
            while ((newline = pending.indexOf('\n')) !== -1) {
              const line = pending.slice(0, newline).trim()
              pending = pending.slice(newline + 1)
              if (!line.startsWith('data: ')) continue
              let event
              try {
                event = JSON.parse(line.slice(6))
              } catch {
                continue
              }
              if (event.type === 'message_start') {
                usage.input += event.message.usage?.input_tokens ?? 0
                usage.cacheRead += event.message.usage?.cache_read_input_tokens ?? 0
              }
              if (event.type === 'message_delta')
                currentOutput = event.usage?.output_tokens ?? currentOutput
            }
          }
          usage.output += currentOutput
          response.end()
        } finally {
          controllers.delete(controller)
          response.off('close', disconnected)
        }
      } else {
        const output = /^OUTPUT: (.+)$/m.exec(userText)?.[1]?.trim()
        if (!output) return reject()
        const alreadyWrote = body.messages.some(
          (message: { role: string; content: unknown }) =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.some((block) => block.type === 'tool_use' && block.name === 'Write')
        )
        if (alreadyWrote) {
          stream(response, body.model, {
            text: 'Completed the requested work and checked the output.'
          })
          return
        }
        if (role === 'reviewer') {
          const artifacts = JSON.parse(
            await readFile(join(inputDirectory!, 'evidence/artifacts.json'), 'utf8')
          )
          const criteria = JSON.parse(
            await readFile(join(inputDirectory!, 'evidence/criteria.json'), 'utf8')
          )
          const file = artifacts[0]
          stream(response, body.model, {
            name: 'Write',
            input: {
              file_path: join(output, 'assessment.json'),
              content: JSON.stringify({
                schemaVersion: 1,
                score: 100,
                outcome: 'pass',
                rationale:
                  'The JSON has count 3 and sum 6, matching independent recomputation from input rows.',
                checks: criteria.criteria.map((criterion: { id: string }) => ({
                  criterionId: criterion.id,
                  status: 'pass',
                  evidence: [
                    {
                      path: file.path,
                      artifactRef: file.artifactRef,
                      quote: file.content.trim()
                    }
                  ]
                }))
              })
            }
          })
          return
        }
        const editing = role === 'proposer' || role === 'composer'
        stream(response, body.model, {
          name: 'Write',
          input: {
            file_path: join(output, editing ? 'context/harness/instructions.md' : 'result.json'),
            content: editing
              ? `Read the frozen CSV; calculate count and sum; verify both values and write compact JSON. Revision ${role}-${requests}.`
              : '{"count":3,"sum":6}\n'
          }
        })
      }
    } catch {
      if (!response.headersSent) reject()
      else response.end()
    }
  })
  onTestFinished(async () => {
    for (const controller of controllers) controller.abort()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await client.$disconnect()
    const unlock = async (path: string): Promise<void> => {
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) return
      if (stat.isDirectory()) {
        await chmod(path, 0o700)
        for (const entry of await readdir(path)) await unlock(join(path, entry))
      }
    }
    await unlock(root)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    // This isolated test worker owns the root for its lifetime.
  })
  if (live) {
    const keys = new Set(
      (await readFile(process.env.EARTHNANO_LIVE_DEEPSEEK_KEY_FILE!, 'utf8')).match(
        /\bsk-[A-Za-z0-9_-]+\b/g
      ) ?? []
    )
    if (keys.size !== 1) throw new Error('Expected one API token in explicitly supplied key file')
    apiKey = [...keys][0]
  }
  await migrateApplicationDatabase(client)
  const project = await client.project.create({
    data: { name: 'Synthetic optimization validation' }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const native = createRequire(import.meta.url).resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`
  )
  const ownerOptions = { dataRoot, configRoot, getClient: async () => client }
  const runOptions: PersistentOptimizationOptions = {
    projectId: project.id,
    taskId: 'synthetic-csv',
    workRoot: join(root, 'run'),
    harnessRoot: resolve('vendor/harness2'),
    ownerOptions,
    executionLimit: 10,
    executionTimeoutMs: 120_000,
    timeoutMs: 480_000,
    input: {
      task: {
        prompt:
          'Read INPUT/values.csv using the Read tool. Calculate the number of data rows and sum of the value column. Write only a JSON object with count and sum to OUTPUT/result.json, using the Write tool. Do not create other deliverables.',
        files: [{ path: 'values.csv', content: 'id,value\none,1\ntwo,2\nthree,3\n' }]
      },
      harness: {
        instructions: 'Read the input carefully and produce the requested JSON deliverable.',
        skills: [],
        tools: 'workspace-only'
      },
      agent: {
        backend: 'claude-code',
        model: 'deepseek-flash',
        providerRef: live ? 'explicit-deepseek-live' : 'local-deterministic',
        runtimeVersion: '2.1.232'
      },
      environment: { isolation: 'directory-process', network: 'provider-only' }
    },
    binding: async (agent) => ({
      executablePath: native,
      runtimeVersion: '2.1.232',
      providerRef: agent.providerRef,
      provider: {
        type: 'custom',
        model: agent.model,
        key: loopbackKey,
        baseUrl,
        apiEndpoints: ['messages']
      }
    })
  }
  let result!: Awaited<ReturnType<typeof runPersistentOptimization>>
  let desktopRunId: string | undefined
  const observedStates = new Set<string>()
  const criteria =
    'The result reports the correct number of data rows, excluding the header.\nThe result reports the correct arithmetic sum of the value column.'
  if (desktop) {
    const sourceSessionId = randomUUID()
    await client.session.create({
      data: {
        id: sourceSessionId,
        number: 1,
        projectId: project.id,
        title: 'Desktop source task',
        status: 'idle',
        presentedStatus: 'idle',
        createdAtMs: BigInt(Date.now()),
        updatedAtMs: BigInt(Date.now())
      }
    })
    const managerOptions = {
      root: join(root, 'desktop'),
      validateSession: async (projectId: string, sessionId: string) => {
        const session = await client.session.findFirst({
          where: { id: sessionId, projectId, deletedAtMs: null, archivedAtMs: null }
        })
        if (!session) throw new Error('Source Session unavailable')
      },
      createOptions: async () => runOptions,
      run: async (options: PersistentOptimizationOptions) => {
        result = await runPersistentOptimization(options)
        return result
      }
    }
    const manager = new DesktopOptimizationManager(managerOptions)
    onTestFinished(async () => {
      await manager.shutdown()
    })
    const initial = await manager.start({
      projectId: project.id,
      sourceSessionId,
      requestKey: 'desktop-synthetic',
      prompt: runOptions.input.task.prompt,
      files: runOptions.input.task.files,
      criteria,
      executionLimit: 10
    })
    desktopRunId = initial.runId
    if (stopEarly) {
      await vi.waitFor(() => expect(requests).toBe(1), { timeout: 30_000, interval: 100 })
      expect(
        (await manager.stop({ projectId: project.id, sourceSessionId, runId: initial.runId })).state
      ).toBe('stopping')
      await vi.waitFor(
        async () => {
          const final = await manager.get({
            projectId: project.id,
            sourceSessionId,
            runId: initial.runId
          })
          expect(final.state).toBe('cancelled')
          expect(final.budget.admitted).toBe(1)
          expect(final.budget.active).toBe(0)
          expect(final.executions.every((execution) => execution.role === 'baseline')).toBe(true)
        },
        { timeout: 30_000, interval: 100 }
      )
      expect(await manager.shutdown()).toEqual({ reaped: true })
      expect(requests).toBe(1)
      return
    }
    await vi.waitFor(
      async () => {
        const progress = await manager.get({
          projectId: project.id,
          sourceSessionId,
          runId: initial.runId
        })
        observedStates.add(progress.state)
        expect(['failed', 'interrupted', 'cancelled']).not.toContain(progress.state)
        expect(progress.state).toBe('completed')
        expect(progress.budget).toEqual({ limit: 10, admitted: 9, completed: 9, active: 0 })
        expect(progress.assessments?.baseline.reviewId).toBeTruthy()
        expect(progress.assessments?.candidate.reviewId).toBeTruthy()
      },
      { timeout: 480_000, interval: 200 }
    )
    expect(observedStates.has('assessing')).toBe(true)
    expect(await manager.shutdown()).toEqual({ reaped: true })
    const restarted = new DesktopOptimizationManager({
      ...managerOptions,
      run: async () => {
        throw new Error('Desktop restart must not replay')
      }
    })
    expect((await restarted.latest({ projectId: project.id, sourceSessionId }))?.state).toBe(
      'completed'
    )
    await restarted.shutdown()
  } else result = await runPersistentOptimization(runOptions)
  expect(result.records).toHaveLength(desktop ? 9 : 7)
  expect(result.records.filter((record) => record.request.role === 'baseline')).toHaveLength(1)
  expect(result.records.filter((record) => record.request.role === 'candidate')).toHaveLength(3)
  expect(result.records.filter((record) => record.request.role === 'proposer')).toHaveLength(2)
  expect(result.records.filter((record) => record.request.role === 'composer')).toHaveLength(1)
  expect(result.methodResult).toMatchObject({ configurationChanged: true, fallbackStages: [] })
  expect(result.records.every((record) => record.evidence.artifacts.length > 0)).toBe(true)
  const sessionIds = new Set(result.records.map((record) => record.identity.sessionId))
  expect(sessionIds.size).toBe(desktop ? 9 : 7)
  if (live) expect(readInputs.size).toBe(4)
  await client.$disconnect()
  const reopened = createProjectDbClient(configRoot)
  const owners = await createPersistentCandidateOwners({
    ...ownerOptions,
    getClient: async () => reopened
  })
  const journal = new FileExecutionStore(
    desktop
      ? join(root, 'desktop', desktopRunId!, 'execution/execution.json')
      : join(root, 'run/execution.json')
  )
  const core = new ExecutionCore(journal, {
    execute: async () => {
      throw new Error('Reopening must not launch any execution')
    }
  })
  let versionCount = 0,
    reviewCount = 0
  try {
    for (const record of result.records) {
      const restored = await core.get(record.executionId)
      expect(restored).toEqual(record)
      const exported = await owners.exportResult(restored)
      const reviews = await owners.readReviews(restored)
      expect(exported.files.length).toBeGreaterThan(0)
      expect(reviews.length).toBeGreaterThan(0)
      versionCount += exported.files.length
      reviewCount += reviews.length
      if (record.request.role === 'baseline' || record.request.role === 'candidate')
        expect(
          JSON.parse(exported.files.find((file) => file.path === 'result.json')!.content)
        ).toEqual({ count: 3, sum: 6 })
    }
    if (desktop) {
      expect(result.assessments).toBeTruthy()
      const repository = new ReviewRepository(async () => reopened, {
        snapshotStorageRoot: dataRoot
      })
      for (const assessment of Object.values(result.assessments!)) {
        const target = result.records.find(
          (record) => record.executionId === assessment.targetExecutionId
        )!
        const rows = await repository.getReviewsForProjectSession(
          project.id,
          target.identity.sessionId!
        )
        const semantic = rows.find((review) => review.id === assessment.reviewId)!
        expect(semantic.lifecycle).toBe('complete')
        expect(semantic.checks.length).toBe(1)
        expect(assessment.score).toBeGreaterThanOrEqual(0)
        reviewCount++
      }
    }
  } finally {
    core.dispose()
    journal.close()
    await owners.shutdown()
    await reopened.$disconnect()
  }
  if (live && process.env.EARTHNANO_LIVE_DEEPSEEK_REPORT)
    await writeFile(
      process.env.EARTHNANO_LIVE_DEEPSEEK_REPORT,
      JSON.stringify(
        {
          status: 'passed',
          model: 'deepseek-flash',
          executions: result.records.length,
          roles: result.records.map((record) => record.request.role),
          sessions: sessionIds.size,
          versionCount,
          reviewCount,
          verifiedInputReads: readInputs.size,
          reopened: true,
          configurationChanged: true,
          fallbackStages: [],
          ...(desktop
            ? {
                desktop: true,
                observedStates: [...observedStates],
                assessments: result.assessments,
                sharedBudget: { limit: 10, admitted: 9 }
              }
            : {}),
          requests,
          rejects,
          usage,
          testOverrides: {
            thinking: 'disabled',
            maxOutputTokens: 1536,
            requestLimit: desktop ? 48 : 32
          },
          limitations: [
            'Deterministic integrity/JSON review, not semantic scientific assessment',
            'k1 trivial selection; no LLM selector',
            'Real model via test-only bounded observer',
            'No paid cancellation/adversarial replay'
          ]
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    )
}

it.skipIf(process.platform === 'win32')(
  'persists actual Sessions, versions and reviews through the original seven-stage Harness method and reopens them',
  () => exercise(false),
  480_000
)
it.skipIf(
  process.platform === 'win32' ||
    process.env.EARTHNANO_LIVE_DEEPSEEK !== '1' ||
    !process.env.EARTHNANO_LIVE_DEEPSEEK_KEY_FILE
)(
  'validates the persisted original Harness method with explicitly authorized DeepSeek',
  () => exercise(true),
  480_000
)

it.skipIf(process.platform === 'win32')(
  'runs desktop admission, progress and shared budget with independently persisted semantic reviews',
  () => exercise(false, true),
  480_000
)
it.skipIf(
  process.platform === 'win32' ||
    process.env.EARTHNANO_LIVE_DEEPSEEK !== '1' ||
    !process.env.EARTHNANO_LIVE_DEEPSEEK_KEY_FILE
)(
  'validates desktop optimization and independent semantic review with authorized DeepSeek',
  () => exercise(true, true),
  480_000
)

it.skipIf(process.platform === 'win32')(
  'stops a desktop optimization during a real native baseline without admitting later stages',
  () => exercise(false, true, true),
  90_000
)
