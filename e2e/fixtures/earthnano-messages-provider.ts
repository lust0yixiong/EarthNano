import type { NotebookLanguage } from '../../src/shared/notebook-language-contract'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

type Block = {
  type: string
  id?: string
  tool_use_id?: string
  name?: string
  input?: Record<string, unknown>
  content?: unknown
}
type ImageToolResult = {
  role: string
  toolUseId: string
  path: string
  mediaType: string
  sizeBytes: number
  sha256: string
  sourceType: 'base64'
}
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

type RejectionReason =
  | 'body-limit'
  | 'input-shape'
  | 'request-limit'
  | 'upstream-http-400'
  | 'upstream-http-429'
  | 'upstream-http-5xx'
  | 'upstream-http-other'
  | 'upstream-body-missing'
  | 'route-auth'
  | 'fixture-error'

/** Only model choices are substituted offline. Live mode forwards the same native Claude requests
 * to the explicitly authorized provider; no scientific tool or persistence response is fabricated. */
export async function createEarthnanoMessagesProvider(
  live: boolean,
  scientificOptimization = false,
  pauseFirstProposer = false,
  testOptions: {
    /** Offline decision fixture only; live requests and tools remain untouched. */
    scientificLanguage?: NotebookLanguage
    /** Original Node/Compute decision fixture; live native requests are still forwarded verbatim. */
    scientificCompute?: boolean
    /** Native R binary fixture; production tools and immutable versions remain real. */
    scientificBinary?: boolean
    /** CSV + PNG desktop fixture; native input, Notebook and Artifact owners stay unchanged. */
    scientificFigure?: boolean
    keyFile?: string
    upstreamFetch?: typeof fetch
    /** Explicit bounded capacity for the two-source acceptance; defaults remain unchanged. */
    maxModelRequests?: number
  } = {}
): Promise<{
  url: string
  token: string
  stats: {
    requests: number
    rejected: number
    unsupportedTokenCountRequests: number
    rejectedRoutes: Record<string, number>
    rejectionReasons: Partial<Record<RejectionReason, number>>
    upstreamStatuses: Record<string, number>
    healthRequests: number
    nativeTitleRequests: number
    pausedBeforeForward: number
    upstreamRequests: number
    cancelledUpstreamRequests: number
    roles: Record<string, number>
    toolNames: string[]
    imageToolResults?: ImageToolResult[]
    usage: { input: number; cacheRead: number; output: number; incompleteRequests: number }
  }
  close(): Promise<void>
}> {
  const scientificLanguage = testOptions.scientificLanguage ?? 'python'
  const scientificCompute = testOptions.scientificCompute === true
  if (scientificCompute && (!scientificOptimization || testOptions.scientificBinary))
    throw new Error('Compute acceptance requires its own original scientific profile')
  if (scientificLanguage !== 'python' && scientificLanguage !== 'r')
    throw new Error('Unsupported acceptance scientific language')
  const scientificBinary = testOptions.scientificBinary === true
  if (scientificBinary && (!scientificOptimization || scientificLanguage !== 'r'))
    throw new Error('Binary scientific acceptance requires the original R Notebook profile')
  const scientificFigure = testOptions.scientificFigure === true
  if (
    scientificFigure &&
    (!scientificOptimization || (!scientificCompute && scientificLanguage !== 'r'))
  )
    throw new Error('Scientific figure acceptance requires the original R Notebook profile')
  const publishFigure = scientificBinary || scientificFigure
  const imageToolResults: ImageToolResult[] = []
  const imageResultsSeen = new Set<string>()
  const maxModelRequests = testOptions.maxModelRequests ?? (scientificOptimization ? 160 : 120)
  if (!Number.isSafeInteger(maxModelRequests) || maxModelRequests < 1 || maxModelRequests > 320)
    throw new Error('Invalid bounded acceptance request limit')
  const token = randomUUID(),
    controllers = new Set<AbortController>()
  const stats = {
    requests: 0,
    rejected: 0,
    unsupportedTokenCountRequests: 0,
    rejectedRoutes: {} as Record<string, number>,
    rejectionReasons: {} as Partial<Record<RejectionReason, number>>,
    upstreamStatuses: {} as Record<string, number>,
    healthRequests: 0,
    nativeTitleRequests: 0,
    pausedBeforeForward: 0,
    upstreamRequests: 0,
    cancelledUpstreamRequests: 0,
    roles: {} as Record<string, number>,
    toolNames: [] as string[],
    ...(scientificFigure ? { imageToolResults } : {}),
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
    let failureReason: RejectionReason = 'route-auth'
    const reject = (reason: RejectionReason = failureReason): void => {
      stats.rejected++
      stats.rejectionReasons[reason] = (stats.rejectionReasons[reason] ?? 0) + 1
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
      failureReason = 'input-shape'
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 1_000_000) return reject('body-limit')
        chunks.push(Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
      if (body.model !== 'deepseek-flash' || !body.stream) return reject()
      if (++stats.requests > maxModelRequests) return reject('request-limit')
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
      failureReason = 'fixture-error'
      for (const block of blocks)
        if (block.type === 'tool_use' && block.name && !stats.toolNames.includes(block.name))
          stats.toolNames.push(block.name)
      if (scientificFigure) {
        // Observe the actual native Read result sent back by Claude. Retain byte identity only;
        // never log or persist base64 model payloads, and never fabricate a tool response.
        for (const result of blocks.filter((block) => block.type === 'tool_result')) {
          const call = blocks.find(
            (block) =>
              block.type === 'tool_use' && block.id === result.tool_use_id && block.name === 'Read'
          )
          if (
            !call?.id ||
            typeof call.input?.file_path !== 'string' ||
            !Array.isArray(result.content)
          )
            continue
          for (const [index, item] of result.content.entries()) {
            const source = item?.type === 'image' ? item.source : undefined
            if (source?.type !== 'base64' || typeof source.data !== 'string') continue
            const identity = `${call.id}:${index}`
            if (imageResultsSeen.has(identity)) continue
            const bytes = Buffer.from(source.data, 'base64')
            imageToolResults.push({
              role,
              toolUseId: call.id!,
              path: call.input.file_path,
              mediaType: source.media_type,
              sourceType: 'base64',
              sizeBytes: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex')
            })
            imageResultsSeen.add(identity)
          }
        }
      }
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
          stats.upstreamStatuses[upstream.status] =
            (stats.upstreamStatuses[upstream.status] ?? 0) + 1
          if (!upstream.ok || !upstream.body) {
            const reason: RejectionReason = !upstream.ok
              ? upstream.status === 400
                ? 'upstream-http-400'
                : upstream.status === 429
                  ? 'upstream-http-429'
                  : upstream.status >= 500 && upstream.status <= 599
                    ? 'upstream-http-5xx'
                    : 'upstream-http-other'
              : 'upstream-body-missing'
            failureReason = reason
            await upstream.body?.cancel()
            return reject(reason)
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
        if (scientificCompute) {
          const control = blocks.filter(
            (block) => block.type === 'tool_use' && block.name?.endsWith('repl_execute')
          )
          if (!control.length)
            return call('repl_execute', {
              code: "var earthnanoReceipt=await host.compute.create('ssh:fixture').submitJob('EarthNano controlled protocol fixture','printf protocol-workload',{outputs:['metrics.json','figure.png'],timeoutSeconds:30});console.log(JSON.stringify(earthnanoReceipt));"
            })
          const delivery = /Compute Job ([a-f0-9-]{36}) ended with status/.exec(userText)
          if (!delivery) {
            emit(response, body.model, {
              text: 'Submission settled; await the original background result delivery.'
            })
            return
          }
          if (
            !control.some(
              (block) =>
                typeof block.input?.code === 'string' &&
                block.input.code.includes('earthnanoAnalyzed')
            )
          )
            return call('repl_execute', {
              code: `var earthnanoAnalyzed=await host.compute.create('ssh:fixture').attachJob(${JSON.stringify(delivery[1])}).result();if(!earthnanoAnalyzed.result_final)throw new Error('Compute result is not final');var earthnanoFs=require('node:fs');var earthnanoMetrics=earthnanoFs.readFileSync('../'+earthnanoAnalyzed.featured_files.find(p=>p.endsWith('metrics.json')));earthnanoFs.writeFileSync('metrics-source.json',earthnanoMetrics,{flag:'wx'});var earthnanoValues=JSON.parse(earthnanoMetrics.toString('utf8')).values;var earthnanoSum=earthnanoValues.reduce((a,b)=>a+b,0);earthnanoFs.writeFileSync('research-results.json',JSON.stringify({count:earthnanoValues.length,sum:earthnanoSum,mean:earthnanoSum/earthnanoValues.length}),{flag:'wx'});${publishFigure ? "earthnanoFs.writeFileSync('measurements.png',earthnanoFs.readFileSync('../'+earthnanoAnalyzed.featured_files.find(p=>p.endsWith('figure.png'))),{flag:'wx'});" : ''}console.log('Derived from original harvested bytes');`
            })
          const producer = [...blocks]
            .reverse()
            .filter((block) => block.type === 'tool_result')
            .find((block) => nested(block, 'activityKind') === 'notebook-run')
          const runId = producer && nested(producer, 'activityId')
          if (typeof runId !== 'string')
            throw new Error('Original control producer identity missing')
          const filenames = [
            'research-results.json',
            'metrics-source.json',
            ...(publishFigure ? ['measurements.png'] : [])
          ]
          for (const filename of filenames) {
            if (
              !blocks.some(
                (block) =>
                  block.type === 'tool_use' &&
                  block.name?.endsWith('write_artifact_file') &&
                  block.input?.filename === filename
              )
            )
              return call('write_artifact_file', {
                filename,
                mimeType: filename.endsWith('.png') ? 'image/png' : 'application/json',
                source: { kind: 'localPath', path: filename },
                producerRunId: runId
              })
          }
          emit(response, body.model, { text: 'Original Compute result analysis complete.' })
          return
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
          const target = runtimes?.find(
            (runtime) =>
              runtime.language === scientificLanguage &&
              runtime.source === 'external' &&
              runtime.runnable
          )
          if (!target) throw new Error('Explicit scientific interpreter unavailable')
          return call('notebook_bind_runtime', {
            language: scientificLanguage,
            runtimeId: target.runtimeId
          })
        }
        if (!called('notebook_execute')) {
          const inputs =
            /<open_science_notebook_inputs>\s*([\s\S]*?)\s*<\/open_science_notebook_inputs>/.exec(
              userText
            )?.[1]
          const source =
            inputs &&
            JSON.parse(inputs).find(
              (input: { filename: string }) =>
                input.filename === (scientificBinary ? 'measurements.rds' : 'measurements.csv')
            )
          if (!source) throw new Error('Uploaded scientific input unavailable')
          return call('notebook_execute', {
            language: scientificLanguage,
            code: scientificBinary
              ? [
                  `values <- readRDS(${JSON.stringify(source.notebookPath)})`,
                  'report <- list(count=length(values), sum=sum(values), mean=mean(values))',
                  "jsonlite::write_json(report, 'research-results.json', auto_unbox=TRUE, digits=NA)",
                  "grDevices::png('measurements.png', width=480, height=320, type='cairo')",
                  "graphics::plot(seq_along(values), values, type='b', xlab='Observation', ylab='Value')",
                  'grDevices::dev.off()',
                  'print(report)'
                ].join('\n')
              : scientificFigure
                ? [
                    `values <- utils::read.csv(${JSON.stringify(source.notebookPath)}, check.names=FALSE)$value`,
                    'report <- list(count=length(values), sum=sum(values), mean=mean(values))',
                    "jsonlite::write_json(report, 'research-results.json', auto_unbox=TRUE, digits=NA)",
                    "grDevices::png('measurements.png', width=480, height=320, type='cairo')",
                    "graphics::plot(seq_along(values), values, type='b', xlab='Observation', ylab='Value')",
                    'grDevices::dev.off()',
                    'print(report)'
                  ].join('\n')
                : scientificLanguage === 'r'
                  ? `values <- utils::read.csv(${JSON.stringify(source.notebookPath)}, check.names=FALSE)$value\nreport <- list(count=length(values), sum=sum(values), mean=mean(values))\njsonlite::write_json(report, 'research-results.json', auto_unbox=TRUE, digits=NA)\nprint(report)`
                  : `import csv, statistics, json\nfrom pathlib import Path\nwith open(${JSON.stringify(source.notebookPath)}, newline='', encoding='utf-8') as source:\n    values = [float(row['value']) for row in csv.DictReader(source)]\nreport = dict(count=len(values), sum=sum(values), mean=statistics.mean(values))\nPath('research-results.json').write_text(json.dumps(report), encoding='utf-8')\nprint(json.dumps(report))`
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
        if (
          publishFigure &&
          !blocks.some(
            (block) =>
              block.type === 'tool_use' &&
              block.name?.endsWith('write_artifact_file') &&
              block.input?.filename === 'measurements.png'
          )
        ) {
          const runId = nested(
            blocks.filter((block) => block.type === 'tool_result'),
            'runId'
          )
          if (typeof runId !== 'string') throw new Error('Notebook producer identity missing')
          return call('write_artifact_file', {
            filename: 'measurements.png',
            mimeType: 'image/png',
            source: { kind: 'localPath', path: 'measurements.png' },
            producerRunId: runId
          })
        }
        emit(response, body.model, { text: 'Research analysis complete.' })
        return
      }
      const input = /^INPUT: (.+)$/m.exec(userText)?.[1]?.trim(),
        output = /^OUTPUT: (.+)$/m.exec(userText)?.[1]?.trim()
      if (!input || !output) return reject()
      // Original Harness selection consumes the committed reply. Exercise that contract without
      // a second model-written selection file; the original Session/Artifact owner retains it.
      if (role === 'selector') {
        if (scientificFigure) {
          const paths = (await readdir(input, { recursive: true }))
            .filter((path) => path.endsWith('.png'))
            .sort()
          if (!paths.length) throw new Error('Selector original binary INPUT assets unavailable')
          for (const path of paths) {
            const filePath = join(input, path)
            const readCall = blocks.find(
              (block) =>
                block.type === 'tool_use' &&
                block.name === 'Read' &&
                block.input?.file_path === filePath
            )
            if (!readCall) {
              if (!body.tools?.some((tool) => tool.name === 'Read'))
                throw new Error('Native Read unavailable')
              emit(response, body.model, { name: 'Read', input: { file_path: filePath } })
              return
            }
            if (
              !imageToolResults.some(
                (result) => result.toolUseId === readCall.id && result.path === filePath
              )
            )
              throw new Error('Native PNG Read did not return an actual image tool_result')
          }
        }
        emit(response, body.model, {
          text: scientificCompute
            ? '```choice\nB\n```\n<why>Deterministic protocol selection after reading the original fixture assets; independent verification remains required.</why>'
            : '```choice\nB\n```\n<why>Both finals satisfy the frozen research input.</why>'
        })
        return
      }
      if (role === 'reflection') {
        emit(response, body.model, {
          text: scientificCompute
            ? '<edits>Await the original complete Job delivery before analyzing harvested fixture bytes.</edits>\n<experience>\ncue: Controlled Compute protocol fixture\nlesson: A submission receipt is not completion. Use the original final result and preserve its producer identity.\nevidence: Baseline and candidate published version-bound reports through the original Compute continuation. This is protocol evidence, not remote science.\n</experience>'
            : '<edits>Use the original fixed source and verify the arithmetic.</edits>\n<experience>\ncue: CSV aggregation\nlesson: Compute count, sum and mean from the fixed source using the original Notebook tools.\nevidence: Baseline and chosen candidate published version-bound reports for the same CSV.\n</experience>'
        })
        return
      }
      if (blocks.some((block) => block.type === 'tool_use' && block.name === 'Write')) {
        emit(response, body.model, {
          text: 'Completed the requested work.'
        })
        return
      }
      if (role === 'proposer' || role === 'composer')
        return write(
          join(output, 'context/harness/instructions.md'),
          scientificOptimization
            ? scientificCompute
              ? `Use original repl_execute and host.compute.create('ssh:fixture').submitJob with command 'printf protocol-workload' and outputs metrics.json and figure.png. End the initial Turn after receipt; await original background delivery. In that application Turn use attachJob(job_id).result(), require result_final, read the harvested metrics.json bytes with node:fs, copy those exact bytes to metrics-source.json without parsing/reformatting the copy, then compute count/sum/mean from its values and write research-results.json. ${publishFigure ? 'Copy the harvested figure.png to measurements.png.' : ''} Publish metrics-source.json, research-results.json and the requested PNG through write_artifact_file with localPath sources and the actual original control producerRunId. Never invent remote execution or resubmit an existing Job. Revision ${stats.requests}.`
              : scientificLanguage === 'r'
                ? `Use the original Notebook R tools with explicit language r to read the fixed measurements.csv input using read.csv, compute count, sum and arithmetic mean, and publish research-results.json written by jsonlite::write_json through write_artifact_file using the actual Notebook producerRunId. Follow the original task.${scientificFigure ? ' Also generate measurements.png with grDevices::png(type=cairo) and publish it through write_artifact_file with the same actual Notebook producerRunId.' : ''} Revision ${stats.requests}.`
                : `Use the original Notebook Python tools to read the fixed measurements.csv input, compute count, sum and arithmetic mean with csv and statistics, and publish research-results.json through write_artifact_file using the actual Notebook producerRunId. Follow the original task. Revision ${stats.requests}.`
            : `Read the frozen research report, check arithmetic consistency, and preserve count, sum and mean in result.json. Revision ${stats.requests}.`
        )
      if (role === 'reviewer') {
        const artifacts = JSON.parse(await readFile(join(input, 'evidence/artifacts.json'), 'utf8'))
        const plan = JSON.parse(await readFile(join(input, 'evidence/criteria.json'), 'utf8'))
        const file = artifacts.find(
          (file: { path: string }) =>
            file.path === (scientificOptimization ? 'research-results.json' : 'result.json')
        )
        const value = JSON.parse(file.content)
        let expected = { count: 3, sum: 12, mean: 4 }
        let metricsSource: { path: string; artifactRef: string; content: string } | undefined
        if (scientificCompute) {
          metricsSource = artifacts.find(
            (file: { path: string }) => file.path === 'metrics-source.json'
          )
          if (!metricsSource || typeof metricsSource.content !== 'string')
            throw new Error('Original metrics source Version unavailable for offline assessment')
          const values = JSON.parse(metricsSource.content).values
          if (
            !Array.isArray(values) ||
            !values.length ||
            values.some((number: unknown) => typeof number !== 'number' || !Number.isFinite(number))
          )
            throw new Error('Invalid original metrics source values')
          const sum = values.reduce((total: number, number: number) => total + number, 0)
          expected = { count: values.length, sum, mean: sum / values.length }
        } else if (scientificOptimization) {
          // Only the offline model's decision is substituted. Recompute from the actual
          // independently frozen source evidence, so a second task cannot pass using task one's CSV.
          const sources = JSON.parse(await readFile(join(input, 'evidence/sources.json'), 'utf8'))
          if (sources.inputs.length !== 1 || sources.inputs[0].status !== 'available')
            throw new Error('Expected one available fixed CSV source for offline assessment')
          const [header, ...rows] = sources.inputs[0].content.trim().split(/\r?\n/)
          if (header !== 'sample,value') throw new Error('Unsupported acceptance CSV')
          const values = rows.map((row: string) => Number(row.split(',')[1]))
          if (!values.length || values.some((number: number) => !Number.isFinite(number)))
            throw new Error('Invalid acceptance CSV values')
          const sum = values.reduce((total: number, number: number) => total + number, 0)
          expected = { count: values.length, sum, mean: sum / values.length }
        }
        const pass =
          value.count === expected.count &&
          value.sum === expected.sum &&
          value.mean === expected.mean
        return write(
          join(output, 'assessment.json'),
          JSON.stringify({
            schemaVersion: 1,
            score: pass ? 100 : 0,
            outcome: pass ? 'pass' : 'flagged',
            rationale: scientificCompute
              ? 'Recomputed count, sum and mean from the published metrics-source.json Version; no visual or remote science claim.'
              : 'Recomputed arithmetic and checked the fixed result bytes.',
            checks: plan.criteria.map((criterion: { id: string }) => ({
              criterionId: criterion.id,
              status: pass ? 'pass' : 'fail',
              evidence: [
                { path: file.path, artifactRef: file.artifactRef, quote: file.content.trim() },
                ...(metricsSource
                  ? [
                      {
                        path: metricsSource.path,
                        artifactRef: metricsSource.artifactRef,
                        quote: metricsSource.content.trim()
                      }
                    ]
                  : [])
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
