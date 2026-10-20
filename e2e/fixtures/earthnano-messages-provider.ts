import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

type Block = { type: string; name?: string; input?: Record<string, unknown>; content?: unknown }
type Body = {
  model: string
  stream: boolean
  max_tokens: number
  thinking?: unknown
  tools?: Array<{ name: string }>
  messages: Array<{ role: string; content: string | Block[] }>
}
const emit = (
  response: ServerResponse,
  model: string,
  content: { text: string } | { name: string; input: object }
): void => {
  const tool = 'name' in content,
    id = randomUUID()
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
const nested = (value: unknown, key: string): unknown => {
  if (typeof value === 'string') {
    try {
      return nested(JSON.parse(value), key)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object') return undefined
  if (key in value) return (value as Record<string, unknown>)[key]
  for (const item of Object.values(value)) {
    const result = nested(item, key)
    if (result !== undefined) return result
  }
  return undefined
}

/** Only model choices are substituted offline. Live mode forwards the same native Claude requests
 * to the explicitly authorized provider; no scientific tool or persistence response is fabricated. */
export async function createEarthnanoMessagesProvider(
  live: boolean,
  scientificOptimization = false,
  pauseFirstProposer = false,
  testOptions: { keyFile?: string; upstreamFetch?: typeof fetch } = {}
): Promise<{
  url: string
  token: string
  stats: {
    requests: number
    rejected: number
    unsupportedTokenCountRequests: number
    rejectedRoutes: Record<string, number>
    healthRequests: number
    nativeTitleRequests: number
    pausedBeforeForward: number
    upstreamRequests: number
    cancelledUpstreamRequests: number
    roles: Record<string, number>
    toolNames: string[]
    usage: { input: number; cacheRead: number; output: number; incompleteRequests: number }
  }
  close(): Promise<void>
}> {
  const token = randomUUID(),
    controllers = new Set<AbortController>()
  const stats = {
    requests: 0,
    rejected: 0,
    unsupportedTokenCountRequests: 0,
    rejectedRoutes: {} as Record<string, number>,
    healthRequests: 0,
    nativeTitleRequests: 0,
    pausedBeforeForward: 0,
    upstreamRequests: 0,
    cancelledUpstreamRequests: 0,
    roles: {} as Record<string, number>,
    toolNames: [] as string[],
    usage: { input: 0, cacheRead: 0, output: 0, incompleteRequests: 0 }
  }
  let key = ''
  if (live) {
    const keys = new Set(
      (
        await readFile(testOptions.keyFile ?? process.env.EARTHNANO_LIVE_DEEPSEEK_KEY_FILE!, 'utf8')
      ).match(/\bsk-[A-Za-z0-9_-]+\b/g) ?? []
    )
    if (keys.size !== 1) throw new Error('Expected one explicitly supplied API key')
    key = [...keys][0]
  }
  const server = createServer(async (request, response) => {
    if (request.method === 'HEAD' && request.url === '/api/hello') {
      stats.healthRequests++
      response.writeHead(200)
      response.end()
      return
    }
    // Claude's optional remote token-count probe is not a model execution. Preserve the native
    // client's explicit unsupported-endpoint fallback instead of fabricating an API token count.
    if (
      request.method === 'POST' &&
      request.url?.startsWith('/v1/messages/count_tokens') &&
      request.headers.authorization === `Bearer ${token}`
    ) {
      stats.unsupportedTokenCountRequests++
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'not_found_error',
            message: 'Token-count probe is unavailable in the bounded acceptance provider'
          }
        })
      )
      request.resume()
      return
    }
    const reject = (): void => {
      stats.rejected++
      const route = `${request.method} ${new URL(request.url ?? '/', 'http://localhost').pathname}`
      stats.rejectedRoutes[route] = (stats.rejectedRoutes[route] ?? 0) + 1
      if (!response.headersSent) response.writeHead(400)
      response.end('Bounded scientific acceptance request rejected')
    }
    try {
      if (
        request.method !== 'POST' ||
        !request.url?.startsWith('/v1/messages') ||
        request.headers.authorization !== `Bearer ${token}`
      )
        return reject()
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 1_000_000) return reject()
        chunks.push(Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
      if (
        body.model !== 'deepseek-flash' ||
        !body.stream ||
        ++stats.requests > (scientificOptimization ? 160 : 120)
      )
        return reject()
      const userText = body.messages
        .filter((message) => message.role === 'user')
        .map((message) =>
          typeof message.content === 'string'
            ? message.content
            : message.content
                .filter((block) => block.type === 'text')
                .map((block) => (block as unknown as { text: string }).text)
                .join('\n')
        )
        .join('\n')
      const role = /EarthNano execution role: ([a-z]+)\./.exec(userText)?.[1] ?? 'ordinary'
      stats.roles[role] = (stats.roles[role] ?? 0) + 1
      const nativeTitle =
        role === 'ordinary' &&
        !body.tools?.length &&
        userText.startsWith('<session>') &&
        userText.includes('</session>')
      if (nativeTitle) stats.nativeTitleRequests++
      const blocks = body.messages.flatMap((message) =>
        Array.isArray(message.content) ? message.content : []
      )
      for (const block of blocks)
        if (block.type === 'tool_use' && block.name && !stats.toolNames.includes(block.name))
          stats.toolNames.push(block.name)
      // A deterministic cancellation seam before a paid request. It never substitutes a tool,
      // scientific result or owner receipt; the real native client must disconnect on Stop.
      if (pauseFirstProposer && role === 'proposer' && stats.pausedBeforeForward === 0) {
        stats.pausedBeforeForward++
        await new Promise<void>((resolve) => response.once('close', resolve))
        return
      }
      if (live) {
        const controller = new AbortController()
        controllers.add(controller)
        const disconnect = (): void => {
          if (!response.writableEnded) controller.abort()
        }
        response.on('close', disconnect)
        try {
          body.max_tokens = Math.min(body.max_tokens ?? 2048, 2048)
          body.thinking = { type: 'disabled' }
          stats.upstreamRequests++
          const upstream = await (testOptions.upstreamFetch ?? fetch)(
            'https://api.deepseek.com/anthropic/v1/messages',
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'anthropic-version': '2023-06-01',
                authorization: `Bearer ${key}`
              },
              body: JSON.stringify(body),
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)])
            }
          )
          if (!upstream.ok || !upstream.body) {
            await upstream.body?.cancel()
            return reject()
          }
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          let pending = '',
            output = 0
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
                stats.usage.input += event.message.usage?.input_tokens ?? 0
                stats.usage.cacheRead += event.message.usage?.cache_read_input_tokens ?? 0
              }
              if (event.type === 'message_delta') output = event.usage?.output_tokens ?? output
            }
          }
          stats.usage.output += output
          response.end()
        } catch (error) {
          if (controller.signal.aborted && response.destroyed) {
            // The real client deliberately disconnected during Stop. Keep this separately from
            // malformed/unauthorized requests; partial or missing token totals remain incomplete.
            stats.cancelledUpstreamRequests++
            stats.usage.incompleteRequests++
            return
          }
          throw error
        } finally {
          controllers.delete(controller)
          response.off('close', disconnect)
        }
        return
      }
      const write = (path: string, content: string): void =>
        emit(response, body.model, { name: 'Write', input: { file_path: path, content } })
      if (
        role === 'ordinary' ||
        (scientificOptimization && ['baseline', 'candidate'].includes(role))
      ) {
        if (nativeTitle) {
          emit(response, body.model, { text: 'Measurements analysis' })
          return
        }
        const called = (suffix: string): boolean =>
          blocks.some((block) => block.type === 'tool_use' && block.name?.endsWith(suffix))
        const call = (suffix: string, input: object): void => {
          const tool = body.tools?.find((tool) => tool.name.endsWith(suffix))
          if (!tool) throw new Error('Production scientific MCP tool unavailable')
          emit(response, body.model, { name: tool.name, input })
        }
        if (!called('list_notebook_runtimes')) return call('list_notebook_runtimes', {})
        if (
          role === 'ordinary' &&
          !called('notebook_bind_runtime') &&
          body.tools?.some((tool) => tool.name.endsWith('notebook_bind_runtime'))
        ) {
          const runtimes = nested(
            blocks.filter((block) => block.type === 'tool_result'),
            'runtimes'
          ) as Array<{ language: string; source: string; runnable: boolean; runtimeId: string }>
          const python = runtimes?.find(
            (runtime) =>
              runtime.language === 'python' && runtime.source === 'external' && runtime.runnable
          )
          if (!python) throw new Error('Explicit Python interpreter unavailable')
          return call('notebook_bind_runtime', { language: 'python', runtimeId: python.runtimeId })
        }
        if (!called('notebook_execute')) {
          const inputs =
            /<open_science_notebook_inputs>\s*([\s\S]*?)\s*<\/open_science_notebook_inputs>/.exec(
              userText
            )?.[1]
          const source =
            inputs &&
            JSON.parse(inputs).find(
              (input: { filename: string }) => input.filename === 'measurements.csv'
            )
          if (!source) throw new Error('Uploaded scientific input unavailable')
          return call('notebook_execute', {
            language: 'python',
            code: `import csv, statistics, json\nfrom pathlib import Path\nwith open(${JSON.stringify(source.notebookPath)}, newline='', encoding='utf-8') as source:\n    values = [float(row['value']) for row in csv.DictReader(source)]\nreport = dict(count=len(values), sum=sum(values), mean=statistics.mean(values))\nPath('research-results.json').write_text(json.dumps(report), encoding='utf-8')\nprint(json.dumps(report))`
          })
        }
        if (!called('write_artifact_file')) {
          const runId = nested(
            blocks.filter((block) => block.type === 'tool_result'),
            'runId'
          )
          if (typeof runId !== 'string') throw new Error('Notebook producer identity missing')
          return call('write_artifact_file', {
            filename: 'research-results.json',
            mimeType: 'application/json',
            source: { kind: 'localPath', path: 'research-results.json' },
            producerRunId: runId
          })
        }
        emit(response, body.model, { text: 'Research analysis complete.' })
        return
      }
      const input = /^INPUT: (.+)$/m.exec(userText)?.[1]?.trim(),
        output = /^OUTPUT: (.+)$/m.exec(userText)?.[1]?.trim()
      if (!input || !output) return reject()
      if (blocks.some((block) => block.type === 'tool_use' && block.name === 'Write')) {
        emit(response, body.model, {
          text:
            role === 'selector'
              ? '```choice\nB\n```\n<why>Both finals satisfy the frozen research input.</why>'
              : 'Completed the requested work.'
        })
        return
      }
      if (role === 'selector')
        return write(
          join(output, 'selection.md'),
          '```choice\nB\n```\n<why>Both finals satisfy the frozen research input.</why>'
        )
      if (role === 'proposer' || role === 'composer')
        return write(
          join(output, 'context/harness/instructions.md'),
          scientificOptimization
            ? `Use the original Notebook Python tools to read the fixed measurements.csv input, compute count, sum and arithmetic mean with csv and statistics, and publish research-results.json through write_artifact_file using the actual Notebook producerRunId. Follow the original task. Revision ${stats.requests}.`
            : `Read the frozen research report, check arithmetic consistency, and preserve count, sum and mean in result.json. Revision ${stats.requests}.`
        )
      if (role === 'reviewer') {
        const artifacts = JSON.parse(await readFile(join(input, 'evidence/artifacts.json'), 'utf8'))
        const plan = JSON.parse(await readFile(join(input, 'evidence/criteria.json'), 'utf8'))
        const file = artifacts.find(
          (file: { path: string }) =>
            file.path === (scientificOptimization ? 'research-results.json' : 'result.json')
        )
        const value = JSON.parse(file.content),
          pass = value.count === 3 && value.sum === 12 && value.mean === 4
        return write(
          join(output, 'assessment.json'),
          JSON.stringify({
            schemaVersion: 1,
            score: pass ? 100 : 0,
            outcome: pass ? 'pass' : 'flagged',
            rationale: 'Recomputed arithmetic and checked the fixed result bytes.',
            checks: plan.criteria.map((criterion: { id: string }) => ({
              criterionId: criterion.id,
              status: pass ? 'pass' : 'fail',
              evidence: [
                { path: file.path, artifactRef: file.artifactRef, quote: file.content.trim() }
              ]
            }))
          })
        )
      }
      const report = JSON.parse(await readFile(join(input, 'research-results.json'), 'utf8'))
      write(join(output, 'result.json'), JSON.stringify(report))
    } catch {
      reject()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token,
    stats,
    close: async () => {
      for (const controller of controllers) controller.abort()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
