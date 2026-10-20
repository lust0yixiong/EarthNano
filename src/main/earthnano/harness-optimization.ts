import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import type {
  ArtifactReference,
  ExecutionPort,
  ExecutionRecord,
  ExecutionRequest,
  ExecutionRole
} from '../../shared/earthnano/execution-port'
import type {
  CandidateSnapshotInput,
  CandidateSnapshotStore,
  CandidateTextFile
} from './candidate-snapshot'
import { requestDigest, validateRequest } from './execution-contract'
import { assertClaudeCandidateText } from '../acp/claude-candidate-preparation'
import { assertExecutionTimeout } from './execution-timeout'

/** Read exclusively from the original Session and immutable ArtifactVersion owners. */
export interface PersistentExecutionExport {
  executionId: string
  artifacts: ArtifactReference[]
  replyText: string
  trajectoryText: string
  files: Array<CandidateTextFile & { digest: string; artifactRef: ArtifactReference }>
}
export interface HarnessOptimizationBindingOptions {
  core: ExecutionPort
  snapshots: CandidateSnapshotStore
  input: CandidateSnapshotInput
  projectId: string
  optimizationId: string
  taskId: string
  budgetRef: string
  timeoutMs: number
  exportResult(record: ExecutionRecord): Promise<PersistentExecutionExport>
}

const fail = (): never => {
  throw new Error('Invalid or out-of-scope optimization binding input')
}
const plain = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
const string = (value: unknown, max = 256_000): string => {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > max)
    return fail()
  return value
}
const safePath = (value: unknown): string => {
  const path = string(value, 1024)
  if (
    !path ||
    /[\\:*?"<>|]/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))
  )
    return fail()
  return path
}
const textFiles = (value: unknown): CandidateTextFile[] => {
  if (!Array.isArray(value) || value.length > 128) return fail()
  let bytes = 0
  const names = new Set<string>()
  return value.map((item) => {
    const file = plain(item)
    if (Object.keys(file).sort().join(',') !== 'content,path') return fail()
    const path = safePath(file.path),
      content = string(file.content)
    bytes += Buffer.byteLength(content)
    const normalized = path.normalize('NFC').toLowerCase()
    if (
      bytes > 512_000 ||
      names.has(normalized) ||
      [...names].some(
        (other) => other.startsWith(normalized + '/') || normalized.startsWith(other + '/')
      )
    )
      return fail()
    names.add(normalized)
    return { path, content }
  })
}
const roles: ExecutionRole[] = [
  'baseline',
  'candidate',
  'proposer',
  'composer',
  'selector',
  'reflection'
]

/** One trusted local optimization scope. Python offers text, never authoritative refs or credentials.
 * Read/submit authorization survives only for this instance; reconnect cannot replay a lost submit. */
export class HarnessOptimizationBinding {
  private readonly options: HarnessOptimizationBindingOptions
  private readonly frozen = new Map<string, string>()
  private readonly admitted = new Set<string>()
  private stopped = false
  constructor(options: HarnessOptimizationBindingOptions) {
    this.options = { ...options, input: structuredClone(options.input) }
    assertExecutionTimeout(options.timeoutMs)
  }
  get executionIds(): string[] {
    return [...this.admitted]
  }
  async stop(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.admitted].map((id) => this.options.core.cancel(id)))
  }
  async dispatch(operation: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.stopped) throw new Error('Optimization binding stopped')
    const { core } = this.options
    if (operation === 'freezeInvocation') return this.freeze(args)
    if (operation === 'submit') {
      validateRequest(args.request)
      const request = args.request as ExecutionRequest
      if (this.frozen.get(request.requestKey) !== requestDigest(request)) return fail()
      const handle = await core.submit(request)
      this.admitted.add(handle.executionId)
      if (this.stopped) await core.cancel(handle.executionId)
      return handle
    }
    const id = string(args.executionId, 256)
    if (!this.admitted.has(id)) return fail()
    switch (operation) {
      case 'get':
        return core.get(id)
      case 'cancel':
        return core.cancel(id)
      case 'events': {
        const after = args.afterSequence ?? 0
        if (!Number.isSafeInteger(after) || (after as number) < 0) return fail()
        const events = []
        for await (const event of core.events(id, after as number)) events.push(event)
        return events
      }
      case 'readResult': {
        const record = await core.get(id)
        if (record.phase !== 'completed' || record.cleanup !== 'confirmed') return fail()
        const result = await this.options.exportResult(record)
        if (
          result.executionId !== id ||
          JSON.stringify(result.artifacts) !== JSON.stringify(record.evidence.artifacts)
        )
          return fail()
        for (const file of result.files) {
          safePath(file.path)
          if (
            !result.artifacts.some(
              (ref) => JSON.stringify(ref) === JSON.stringify(file.artifactRef)
            ) ||
            file.digest !== `sha256:${createHash('sha256').update(file.content).digest('hex')}`
          )
            return fail()
        }
        return result
      }
      default:
        return fail()
    }
  }
  private async freeze(args: Record<string, unknown>): Promise<ExecutionRequest> {
    const { snapshots, input, projectId, optimizationId, taskId, budgetRef, timeoutMs } =
      this.options
    const invocation = plain(args.invocation)
    if (invocation.taskId !== taskId || !roles.includes(invocation.role as ExecutionRole))
      return fail()
    const role = invocation.role as ExecutionRole
    const label = string(invocation.label, 256),
      stageLabel = string(invocation.stageLabel, 256)
    if (!label || !stageLabel || !string(invocation.scope, 256)) return fail()
    const mission = string(invocation.mission),
      system = string(invocation.system ?? '')
    const context = textFiles(args.contextFiles),
      harness = textFiles(args.harnessFiles)
    const retryOf = string(invocation.retryOfExecutionId ?? '', 256)
    if (retryOf && !this.admitted.has(retryOf)) return fail()
    if (invocation.harvest != null && invocation.harvest !== 'context/harness') return fail()
    const proposed = harness.length
      ? {
          instructions: harness.find((file) => file.path === 'instructions.md')?.content ?? fail(),
          skills: harness
            .filter((file) => file.path !== 'instructions.md')
            .map((file) => {
              if (!/^skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md$/.test(file.path)) return fail()
              return { path: file.path.slice('skills/'.length), content: file.content }
            }),
          tools: 'workspace-only' as const
        }
      : input.harness
    const refs = await snapshots.freeze({ ...input, harness: proposed })
    // Role context belongs to the invocation, not a newly invented research TaskSnapshot.
    const roleMission = [
      `EarthNano execution role: ${role}.`,
      system,
      mission,
      'The following JSON contains frozen, read-only context files; interpret their relative paths inside this evidence package, not on the host filesystem.',
      // Preserve evidence bytes losslessly while keeping native file/shell expansion syntax
      // out of the actual prompt. This is JSON encoding, not a change to the evidence text.
      JSON.stringify(context).replaceAll('@', '\\u0040').replaceAll('`', '\\u0060'),
      ['proposer', 'composer'].includes(role)
        ? 'Emit the complete revised harness as files beneath OUTPUT/context/harness/: instructions.md and optional skills/name/SKILL.md. OUTPUT is the absolute output directory supplied by the Session owner. Read the current harness from the frozen JSON context; do not modify INPUT or any original context directory. Preserve unchanged harness files in the emitted tree. Finish with a short explanation of your changes.'
        : 'Write task deliverables only beneath the absolute OUTPUT directory supplied by the Session owner.'
    ]
      .filter(Boolean)
      .join('\n\n')
    assertClaudeCandidateText(roleMission)
    const invocationRef = await snapshots.freezeInvocation({
      taskSnapshotRef: refs.taskSnapshotRef,
      harnessRevisionRef: refs.harnessRevisionRef,
      mission: roleMission
    })
    const request: ExecutionRequest = {
      contractVersion: 1,
      requestKey: `${optimizationId}:${randomUUID()}`,
      projectId,
      ...refs,
      invocationRef,
      role,
      origin: {
        kind: 'optimization',
        optimizationId,
        stageId: stageLabel,
        ...(retryOf ? { retryOfExecutionId: retryOf } : {})
      },
      interactionPolicy: 'deny-unresolved',
      budgetRef,
      timeoutMs:
        typeof invocation.timeoutMs === 'number' &&
        Number.isSafeInteger(invocation.timeoutMs) &&
        invocation.timeoutMs > 0
          ? Math.min(timeoutMs, invocation.timeoutMs)
          : timeoutMs
    }
    validateRequest(request)
    if (this.stopped) throw new Error('Optimization binding stopped during freezing')
    this.frozen.set(request.requestKey, requestDigest(request))
    return request
  }
}

/** Runs the installed Harness² entrypoint over private stdio. No HTTP server, shell, secret argv,
 * or automatic recovery/replay. Cancellation is requested on every admitted execution on failure. */
export async function runHarnessProcess(options: {
  binding: HarnessOptimizationBinding
  python: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
}): Promise<unknown> {
  assertExecutionTimeout(options.timeoutMs)
  options.signal?.throwIfAborted()
  const child = spawn(options.python, options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  let pending = Promise.resolve()
  let result: unknown
  let failed = false
  let receivedBytes = 0
  let diagnosticBytes = 0
  const seen = new Set<number>()
  let releaseStop!: () => void
  const stopped = new Promise<void>((resolve) => {
    releaseStop = resolve
  })
  const stop = (): void => {
    failed = true
    releaseStop()
    child.kill('SIGKILL')
    void options.binding.stop()
  }
  const timer = setTimeout(stop, options.timeoutMs)
  options.signal?.addEventListener('abort', stop, { once: true })
  child.stdout.on('data', (data) => {
    receivedBytes += data.length
    if (receivedBytes > 16 * 1024 * 1024) stop()
  })
  // Drain diagnostics without storing provider text or arbitrary Python exception data.
  child.stderr.on('data', (data) => {
    diagnosticBytes += data.length
    if (diagnosticBytes > 1024 * 1024) stop()
  })
  child.stdin.on('error', stop)
  lines.on('line', (line) => {
    pending = pending
      .then(async () => {
        if (failed || Buffer.byteLength(line) > 1024 * 1024) return stop()
        const message = plain(JSON.parse(line))
        if (
          !Number.isSafeInteger(message.id) ||
          (message.id as number) < 1 ||
          seen.has(message.id as number)
        )
          return stop()
        seen.add(message.id as number)
        try {
          let value: unknown
          if (message.operation === 'done') {
            if (result !== undefined) return stop()
            result = message.result
            value = true
          } else {
            if (result !== undefined) return stop()
            value = await options.binding.dispatch(string(message.operation, 64), message)
          }
          if (!failed) child.stdin.write(JSON.stringify({ id: message.id, result: value }) + '\n')
        } catch (error) {
          const code = (error as { code?: string }).code
          const known = [
            'budget-exhausted',
            'request-conflict',
            'cleanup-unconfirmed',
            'not-found'
          ].includes(code ?? '')
          if (!failed)
            child.stdin.write(
              JSON.stringify({
                id: message.id,
                error: {
                  code: known ? code : 'binding-rejected',
                  message: 'Optimization operation rejected; no automatic replay.'
                }
              }) + '\n'
            )
          await options.binding.stop()
          failed = true
          child.kill('SIGKILL')
        }
      })
      .catch(stop)
  })
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    await Promise.race([pending, stopped])
    if (failed || exitCode !== 0 || result === undefined) {
      failed = true
      throw new Error(
        'Harness optimization did not complete; admitted executions remain owned by the core'
      )
    }
    return result
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', stop)
    lines.close()
    if (failed || result === undefined) await options.binding.stop()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}
