import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
