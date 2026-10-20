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
  upstreamFetch: typeof fetch
): Promise<Awaited<ReturnType<typeof createEarthnanoMessagesProvider>>> => {
  const root = await mkdtemp(join(tmpdir(), 'earthnano-proxy-counter-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const keyFile = join(root, 'fixture.key')
  await writeFile(keyFile, ['sk', 'fixture-only'].join('-'), { mode: 0o600 })
  const provider = await createEarthnanoMessagesProvider(true, true, false, {
    keyFile,
    upstreamFetch
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
    cancelledUpstreamRequests: 0
  })
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
