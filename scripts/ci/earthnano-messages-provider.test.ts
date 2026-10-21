import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createEarthnanoMessagesProvider } from '../../e2e/fixtures/earthnano-messages-provider'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const setup = async (
  upstreamFetch: typeof fetch,
  scientificCompute = false
): Promise<Awaited<ReturnType<typeof createEarthnanoMessagesProvider>>> => {
  const root = await mkdtemp(join(tmpdir(), 'earthnano-proxy-counter-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const keyFile = join(root, 'fixture.key')
  await writeFile(keyFile, ['sk', 'fixture-only'].join('-'), { mode: 0o600 })
  const provider = await createEarthnanoMessagesProvider(true, true, false, {
    keyFile,
    upstreamFetch,
    scientificCompute
  })
  cleanups.push(() => provider.close())
  return provider
}
const body = {
  model: 'deepseek-flash',
  stream: true,
  max_tokens: 64,
  messages: [{ role: 'user', content: 'EarthNano execution role: proposer.' }]
}
const request = (
  provider: Awaited<ReturnType<typeof setup>>,
  signal?: AbortSignal
): Promise<Response> =>
  fetch(`${provider.url}/v1/messages`, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${provider.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

it('counts deliberate real-client Stop disconnects separately and retains incomplete upstream usage', async () => {
  const upstream = vi.fn<typeof fetch>(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener(
          'abort',
          () => reject(new DOMException('Stopped', 'AbortError')),
          { once: true }
        )
      })
  )
  const provider = await setup(upstream),
    controller = new AbortController()
  const pending = request(provider, controller.signal).catch((error: unknown) => error)
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce())
  controller.abort()
  await pending
  await vi.waitFor(() => expect(provider.stats.cancelledUpstreamRequests).toBe(1))
  expect(provider.stats).toMatchObject({
    requests: 1,
    upstreamRequests: 1,
    rejected: 0,
    usage: { input: 0, output: 0, incompleteRequests: 1 }
  })
})

it('keeps unexpected upstream failures rejected instead of reclassifying them as cancellation', async () => {
  const provider = await setup(
    vi.fn<typeof fetch>(async () => new Response('Unavailable', { status: 503 }))
  )
  expect((await request(provider)).status).toBe(400)
  expect(provider.stats).toMatchObject({
    upstreamRequests: 1,
    rejected: 1,
    rejectionReasons: { 'upstream-http-5xx': 1 },
    upstreamStatuses: { '503': 1 },
    cancelledUpstreamRequests: 0
  })
})

it('retains the exact body limit and distinguishes oversized input before forwarding', async () => {
  const upstream = vi.fn<typeof fetch>(async () => new Response('data: [DONE]\n\n'))
  const provider = await setup(upstream)
  const empty = JSON.stringify({ ...body, padding: '' })
  const bounded = JSON.stringify({ ...body, padding: 'x'.repeat(1_000_000 - empty.length) })
  expect(Buffer.byteLength(bounded)).toBe(1_000_000)
  const send = (payload: string): Promise<Response> =>
    fetch(`${provider.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${provider.token}`, 'content-type': 'application/json' },
      body: payload
    })
  const accepted = await send(bounded)
  expect(accepted.status).toBe(200)
  await accepted.text()
  const rejected = await send(`${bounded} `)
  expect(rejected.status).toBe(400)
  expect(await rejected.text()).toBe('Bounded scientific acceptance request rejected')
  expect(upstream).toHaveBeenCalledOnce()
  expect(provider.stats).toMatchObject({
    requests: 1,
    upstreamRequests: 1,
    rejected: 1,
    rejectionReasons: { 'body-limit': 1 },
    upstreamStatuses: { '200': 1 }
  })
})

it.each([400, 429])('records upstream HTTP %s without retaining its error body', async (status) => {
  const sensitive = 'private-upstream-error-body'
  const cancel = vi.fn()
  const upstream = vi.fn<typeof fetch>(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sensitive))
          },
          cancel
        }),
        { status }
      )
  )
  const provider = await setup(upstream)
  const response = await request(provider)
  expect(response.status).toBe(400)
  expect(await response.text()).toBe('Bounded scientific acceptance request rejected')
  expect(cancel).toHaveBeenCalledOnce()
  expect(provider.stats.rejectionReasons).toEqual({ [`upstream-http-${status}`]: 1 })
  expect(provider.stats.upstreamStatuses).toEqual({ [status]: 1 })
  expect(provider.stats).toMatchObject({
    rejected: 1,
    upstreamRequests: 1,
    cancelledUpstreamRequests: 0
  })
  expect(JSON.stringify(provider.stats)).not.toContain(sensitive)
  expect(JSON.stringify(provider.stats)).not.toContain('sk-fixture-only')
})

it('counts a completed upstream stream once and retains actual reported token totals', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 11, cache_read_input_tokens: 7 } } },
    { type: 'message_delta', usage: { output_tokens: 5 } }
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('')
  const upstream = vi.fn<typeof fetch>(async () => new Response(events, { status: 200 }))
  const provider = await setup(upstream),
    response = await request(provider)
  expect(response.status).toBe(200)
  await response.text()
  expect(upstream.mock.calls[0][0]).toBe('https://api.deepseek.com/anthropic/v1/messages')
  expect(provider.stats).toMatchObject({
    requests: 1,
    upstreamRequests: 1,
    rejected: 0,
    cancelledUpstreamRequests: 0,
    usage: { input: 11, cacheRead: 7, output: 5, incompleteRequests: 0 }
  })
})

it('enforces an explicit model-request ceiling before another upstream request', async () => {
  const upstream = vi.fn<typeof fetch>(async () => new Response('data: [DONE]\n\n'))
  const provider = await createEarthnanoMessagesProvider(true, true, false, {
    keyFile: await (async () => {
      const root = await mkdtemp(join(tmpdir(), 'earthnano-bounded-'))
      cleanups.push(() => rm(root, { recursive: true, force: true }))
      const keyFile = join(root, 'fixture.key')
      await writeFile(keyFile, ['sk', 'fixture-only'].join('-'), { mode: 0o600 })
      return keyFile
    })(),
    upstreamFetch: upstream,
    maxModelRequests: 1
  })
  cleanups.push(() => provider.close())
  await (await request(provider)).text()
  expect((await request(provider)).status).toBe(400)
  expect(upstream).toHaveBeenCalledOnce()
  expect(provider.stats.requests).toBe(2)
  expect(provider.stats.upstreamRequests).toBe(1)
  expect(provider.stats.rejectionReasons).toEqual({ 'request-limit': 1 })
})

it.each([0, 321, 1.5, NaN])(
  'rejects an invalid acceptance ceiling %s',
  async (maxModelRequests) => {
    await expect(
      createEarthnanoMessagesProvider(false, true, false, { maxModelRequests })
    ).rejects.toThrow('Invalid bounded acceptance request limit')
  }
)

it.each([true, false])(
  'offline reviewer uses its own frozen source, correct=%s',
  async (correct) => {
    const root = await mkdtemp(join(tmpdir(), 'earthnano-source-review-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, 'evidence'))
    await writeFile(
      join(root, 'evidence/sources.json'),
      JSON.stringify({
        inputs: [{ status: 'available', content: 'sample,value\nX,10\nY,20\n' }]
      })
    )
    await writeFile(
      join(root, 'evidence/artifacts.json'),
      JSON.stringify([
        {
          path: 'research-results.json',
          artifactRef: 'artifact-ref',
          content: JSON.stringify(
            correct ? { count: 2, sum: 30, mean: 15 } : { count: 3, sum: 12, mean: 4 }
          )
        }
      ])
    )
    await writeFile(
      join(root, 'evidence/criteria.json'),
      JSON.stringify({ criteria: [{ id: 'arithmetic' }] })
    )
    const provider = await createEarthnanoMessagesProvider(false, true)
    cleanups.push(() => provider.close())
    const response = await fetch(`${provider.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${provider.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        messages: [
          {
            role: 'user',
            content: `EarthNano execution role: reviewer.\nINPUT: ${root}\nOUTPUT: ${root}`
          }
        ]
      })
    })
    expect(response.status).toBe(200)
    const events = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
    const instruction = JSON.parse(
      events.find((event) => event.delta?.partial_json)?.delta.partial_json
    )
    const assessment = JSON.parse(instruction.content)
    expect(assessment.outcome).toBe(correct ? 'pass' : 'flagged')
    expect(provider.stats.upstreamRequests).toBe(0)
  }
)

it('offline R decisions bind the explicit R target and execute real R source instead of Python', async () => {
  const provider = await createEarthnanoMessagesProvider(false, true, false, {
    scientificLanguage: 'r'
  })
  cleanups.push(() => provider.close())
  const tools = ['list_notebook_runtimes', 'notebook_bind_runtime', 'notebook_execute'].map(
    (suffix) => ({ name: `mcp__open-science-notebook__${suffix}` })
  )
  const messages = [
    {
      role: 'user',
      content:
        '<open_science_notebook_inputs>[{"filename":"measurements.csv","notebookPath":"/fixed/source.csv"}]</open_science_notebook_inputs>'
    },
    { role: 'assistant', content: [{ type: 'tool_use', name: tools[0].name }] },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content: JSON.stringify({
            runtimes: [
              {
                language: 'python',
                source: 'external',
                runnable: true,
                runtimeId: '/original/python'
              },
              { language: 'r', source: 'external', runnable: true, runtimeId: '/original/R' }
            ]
          })
        }
      ]
    }
  ]
  const send = async (): Promise<Record<string, unknown>> => {
    const response = await fetch(`${provider.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${provider.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, messages, tools })
    })
    expect(response.status).toBe(200)
    const event = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
      .find((event) => event.delta?.partial_json)
    return JSON.parse(event.delta.partial_json)
  }
  expect(await send()).toEqual({ language: 'r', runtimeId: '/original/R' })
  messages.push({ role: 'assistant', content: [{ type: 'tool_use', name: tools[1].name }] })
  const execute = await send()
  expect(execute.language).toBe('r')
  expect(execute.code).toContain('utils::read.csv("/fixed/source.csv"')
  expect(execute.code).toContain('jsonlite::write_json')
  expect(execute.code).not.toContain('import csv')
  expect(provider.stats.upstreamRequests).toBe(0)
})

it('offline Compute decisions wait for real delivery and publish using the returned control producer', async () => {
  const provider = await createEarthnanoMessagesProvider(false, true, false, {
    scientificCompute: true,
    scientificFigure: true
  })
  cleanups.push(() => provider.close())
  const tools = ['repl_execute', 'write_artifact_file'].map((suffix) => ({
    name: `mcp__original__${suffix}`
  }))
  const messages: Array<{ role: string; content: unknown }> = [
    { role: 'user', content: 'EarthNano execution role: candidate.' }
  ]
  const send = async (): Promise<Array<{ delta?: { partial_json?: string; text?: string } }>> => {
    const response = await fetch(`${provider.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${provider.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, tools, messages })
    })
    expect(response.status).toBe(200)
    return (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
  }
  const input = (events: Awaited<ReturnType<typeof send>>): Record<string, unknown> =>
    JSON.parse(events.find((event) => event.delta?.partial_json)!.delta!.partial_json!)
  const submit = input(await send())
  expect(submit.code).toContain('.submitJob(')
  expect(submit.code).not.toContain('notebook_execute')
  messages.push({
    role: 'assistant',
    content: [{ type: 'tool_use', name: tools[0].name, input: submit }]
  })
  expect((await send()).some((event) => event.delta?.partial_json)).toBe(false)
  messages.push({
    role: 'user',
    content:
      'Compute Job 11111111-2222-3333-4444-555555555555 ended with status success on fixture.'
  })
  const analyze = input(await send())
  expect(analyze.code).toContain('attachJob("11111111-2222-3333-4444-555555555555").result()')
  expect(analyze.code).toContain('result_final')
  expect(analyze.code).toContain('earthnanoValues.reduce')
  expect(analyze.code).toContain(
    "writeFileSync('metrics-source.json',earthnanoMetrics,{flag:'wx'})"
  )
  messages.push(
    { role: 'assistant', content: [{ type: 'tool_use', name: tools[0].name, input: analyze }] },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content: JSON.stringify({
            fileEvidence: { activityKind: 'notebook-run', activityId: 'actual-control-producer' }
          })
        }
      ]
    }
  )
  for (const filename of ['research-results.json', 'metrics-source.json', 'measurements.png']) {
    const publish = input(await send())
    expect(publish).toMatchObject({
      filename,
      source: { kind: 'localPath', path: filename },
      producerRunId: 'actual-control-producer'
    })
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', name: tools[1].name, input: publish }]
    })
  }
  expect(provider.stats.upstreamRequests).toBe(0)
})

it.each([
  {
    source: '{\n "values": [10,20]\n}\n',
    report: { count: 2, sum: 30, mean: 15 },
    outcome: 'pass'
  },
  { source: '{"values":[10,20]}', report: { count: 3, sum: 12, mean: 4 }, outcome: 'flagged' },
  { source: undefined, report: { count: 3, sum: 12, mean: 4 }, outcome: undefined },
  { source: '{"values":["2",4,6]}', report: { count: 3, sum: 12, mean: 4 }, outcome: undefined }
])(
  'offline Compute reviewer requires actual source values: %j',
  async ({ source, report, outcome }) => {
    const root = await mkdtemp(join(tmpdir(), 'earthnano-compute-review-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, 'evidence'))
    await writeFile(
      join(root, 'evidence/artifacts.json'),
      JSON.stringify([
        {
          path: 'research-results.json',
          artifactRef: 'result-version-ref',
          content: JSON.stringify(report)
        },
        ...(source === undefined
          ? []
          : [{ path: 'metrics-source.json', artifactRef: 'source-version-ref', content: source }])
      ])
    )
    await writeFile(
      join(root, 'evidence/criteria.json'),
      JSON.stringify({ criteria: [{ id: 'count' }, { id: 'sum' }, { id: 'mean' }] })
    )
    const provider = await createEarthnanoMessagesProvider(false, true, false, {
      scientificCompute: true
    })
    cleanups.push(() => provider.close())
    const response = await fetch(`${provider.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${provider.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        messages: [
          {
            role: 'user',
            content: `EarthNano execution role: reviewer.\nINPUT: ${root}\nOUTPUT: ${root}`
          }
        ]
      })
    })
    expect(provider.stats.upstreamRequests).toBe(0)
    if (!outcome) {
      expect(response.status).toBe(400)
      expect(provider.stats.rejected).toBe(1)
      await response.text()
      return
    }
    expect(response.status).toBe(200)
    const event = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
      .find((event) => event.delta?.partial_json)
    const assessment = JSON.parse(JSON.parse(event.delta.partial_json).content)
    expect(assessment.outcome).toBe(outcome)
    expect(assessment.score).toBe(outcome === 'pass' ? 100 : 0)
    expect(assessment.checks).toHaveLength(3)
    for (const check of assessment.checks) {
      expect(check.status).toBe(outcome === 'pass' ? 'pass' : 'fail')
      expect(check.evidence).toContainEqual({
        path: 'metrics-source.json',
        artifactRef: 'source-version-ref',
        quote: source!.trim()
      })
    }
  }
)

it('forwards live Compute tools and messages without substituting model decisions', async () => {
  const upstream = vi.fn<typeof fetch>(async () => new Response('data: [DONE]\n\n'))
  const provider = await setup(upstream, true)
  const tools = [{ name: 'mcp__original__repl_execute', input_schema: { type: 'object' } }]
  const response = await fetch(`${provider.url}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${provider.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, tools })
  })
  await response.text()
  const forwarded = JSON.parse(String(upstream.mock.calls[0][1]!.body))
  expect(forwarded.messages).toEqual(body.messages)
  expect(forwarded.tools).toEqual(tools)
  expect(provider.stats.upstreamRequests).toBe(1)
})
