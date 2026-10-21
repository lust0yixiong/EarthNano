import {
  normalizeCandidateArtifactFile,
  type CandidateArtifactFile,
  type CandidateBinaryArtifactFile
} from '../../shared/earthnano/candidate-artifact'
import { notebookLanguageForTools } from '../../shared/earthnano/notebook-profile'
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
  CandidateTextFile,
  CandidateContextAsset
} from './candidate-snapshot'
import { requestDigest, validateRequest } from './execution-contract'
import { assertClaudeCandidateText } from '../acp/claude-candidate-preparation'
import { assertExecutionTimeout } from './execution-timeout'
import { sameExecutionInputs } from './optimization-resume'
import { outputDigest } from './output-checks'
import {
  assertHarnessBindingV2Identity,
  harnessBindingV2Slot,
  HARNESS_BINDING_V2,
  type HarnessBindingV2Identity
} from './harness-binding-v2'
import {
  HarnessProcessFailure,
  type HarnessFailureCategory
} from './optimization-failure-diagnostics'
import {
  MAX_HARNESS_FRAME_BYTES,
  MAX_HARNESS_EVIDENCE_BYTES,
  MAX_HARNESS_EVIDENCE_FILES,
  MAX_HARNESS_DIAGNOSTIC_BYTES
} from './harness-binding-limits'

/** Read exclusively from the original Session and immutable ArtifactVersion owners. */
export interface PersistentExecutionExport {
  executionId: string
  artifacts: ArtifactReference[]
  replyText: string
  trajectoryText: string
  reused?: boolean
  files: CandidateArtifactFile[]
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
  materializeArtifact?(
    record: ExecutionRecord,
    artifactRef: ArtifactReference,
    signal?: AbortSignal
  ): Promise<{ file: CandidateBinaryArtifactFile; assetPath: string }>
  resumeRecords?: ExecutionRecord[]
  resumeSlot?(requestKey: string): string | undefined
  bindingIdentity?: HarnessBindingV2Identity
  resumeScope?(requestKey: string): string | undefined
  onFreeze?(request: ExecutionRequest, slot: string, scope?: string): void
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
  if (!Array.isArray(value) || value.length > MAX_HARNESS_EVIDENCE_FILES) return fail()
  let bytes = 0
  const names = new Set<string>()
  return value.map((item) => {
    const file = plain(item)
    if (Object.keys(file).sort().join(',') !== 'content,path') return fail()
    const path = safePath(file.path),
      content = string(file.content, MAX_HARNESS_EVIDENCE_BYTES)
    bytes += Buffer.byteLength(content)
    const normalized = path.normalize('NFC').toLowerCase()
    if (
      bytes > MAX_HARNESS_EVIDENCE_BYTES ||
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
  private readonly artifactIO = new AbortController()
  private readonly reused = new Set<string>()
  private readonly fresh = new Set<string>()
  private readonly slots = new Map<string, string>()
  private readonly requestSlots = new Map<string, string>()
  private readonly requestScopes = new Map<string, string>()
  private resumeValidated?: Promise<void>
  constructor(options: HarnessOptimizationBindingOptions) {
    this.options = {
      ...options,
      input: structuredClone(options.input),
      ...(options.bindingIdentity
        ? { bindingIdentity: structuredClone(options.bindingIdentity) }
        : {})
    }
    if (this.options.bindingIdentity)
      assertHarnessBindingV2Identity(this.options.bindingIdentity, this.options.bindingIdentity)
    assertExecutionTimeout(options.timeoutMs)
    for (const record of options.resumeRecords ?? []) {
      if (
        record.request.projectId !== options.projectId ||
        record.request.origin.optimizationId !== options.optimizationId ||
        record.request.budgetRef !== options.budgetRef ||
        record.cleanup !== 'confirmed' ||
        !['completed', 'failed', 'cancelled'].includes(record.phase)
      )
        return fail()
      const slot = options.resumeSlot?.(record.requestKey)
      if (!slot) throw new Error('Optimization stage ownership is unavailable')
      if (this.options.bindingIdentity) {
        const scope = options.resumeScope?.(record.requestKey)
        if (!scope || !new RegExp(`^${HARNESS_BINDING_V2}:sha256:[a-f0-9]{64}$`).test(slot))
          return fail()
        this.assertScope(scope, record.request.role)
        this.requestScopes.set(record.requestKey, scope)
      }
      this.slots.set(slot, record.executionId)
      this.requestSlots.set(record.requestKey, slot)
      this.admitted.add(record.executionId)
      if (record.phase === 'completed') this.reused.add(record.executionId)
    }
  }
  get executionIds(): string[] {
    return this.options.resumeRecords === undefined
      ? [...this.admitted]
      : [...new Set([...this.slots.values(), ...this.fresh])]
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.artifactIO.abort()
    await Promise.allSettled([...this.admitted].map((id) => this.options.core.cancel(id)))
  }
  async dispatch(operation: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.stopped) throw new Error('Optimization binding stopped')
    if (this.options.bindingIdentity && this.options.resumeRecords?.length) {
      await this.validateResume()
      if (this.stopped) throw new Error('Optimization binding stopped')
    }
    const { core } = this.options
    if (operation === 'freezeInvocation') return this.freeze(args)
    if (operation === 'taskRecords') {
      if (args.taskId !== this.options.taskId) return fail()
      const records = await Promise.all(this.executionIds.map((id) => core.get(id)))
      if (args.scope === undefined) return records
      if (
        !this.options.bindingIdentity ||
        typeof args.scope !== 'string' ||
        !Object.values(this.options.bindingIdentity.modeScopes).includes(args.scope)
      )
        return fail()
      return records.filter(
        (record) =>
          record.request.role === 'baseline' ||
          this.requestScopes.get(record.requestKey) === args.scope
      )
    }
    if (operation === 'submit') {
      validateRequest(args.request)
      const request = args.request as ExecutionRequest
      if (this.frozen.get(request.requestKey) !== requestDigest(request)) return fail()
      const handle = await core.submit(request)
      this.admitted.add(handle.executionId)
      if (!this.reused.has(handle.executionId)) this.fresh.add(handle.executionId)
      this.slots.set(this.requestSlots.get(request.requestKey)!, handle.executionId)
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
        const result = await this.readResult(record)
        return { ...result, ...(this.reused.has(id) ? { reused: true } : {}) }
      }
      case 'materializeArtifact': {
        if (Object.keys(args).sort().join(',') !== 'artifactRef,executionId') return fail()
        const record = await core.get(id)
        const artifact = await this.binaryArtifact(record, args.artifactRef)
        if (!this.options.materializeArtifact) return fail()
        const result = await this.options.materializeArtifact(
          record,
          artifact.artifactRef,
          this.artifactIO.signal
        )
        if (this.stopped) throw new Error('Optimization binding stopped during materialization')
        if (outputDigest(result.file) !== outputDigest(artifact)) return fail()
        return result
      }
      default:
        return fail()
    }
  }
  private async readResult(record: ExecutionRecord): Promise<PersistentExecutionExport> {
    if (record.phase !== 'completed' || record.cleanup !== 'confirmed') return fail()
    const result = await this.options.exportResult(record)
    if (
      result.executionId !== record.executionId ||
      JSON.stringify(result.artifacts) !== JSON.stringify(record.evidence.artifacts)
    )
      return fail()
    if (result.files.length > MAX_HARNESS_EVIDENCE_FILES) return fail()
    const names: string[] = []
    for (const file of result.files) {
      const path = safePath(file.path).normalize('NFC').toLowerCase()
      if (
        names.some(
          (old) => path === old || path.startsWith(old + '/') || old.startsWith(path + '/')
        )
      )
        return fail()
      names.push(path)
      if (!result.artifacts.some((ref) => JSON.stringify(ref) === JSON.stringify(file.artifactRef)))
        return fail()
      if ('representation' in file) normalizeCandidateArtifactFile(file)
      else if (
        Object.keys(file).sort().join(',') !== 'artifactRef,content,digest,path' ||
        file.digest !== `sha256:${createHash('sha256').update(file.content).digest('hex')}`
      )
        return fail()
    }
    return result
  }
  private async binaryArtifact(
    record: ExecutionRecord,
    ref: unknown
  ): Promise<CandidateBinaryArtifactFile> {
    if (!['baseline', 'candidate'].includes(record.request.role)) return fail()
    const result = await this.readResult(record)
    const matches = result.files.filter(
      (file) => 'representation' in file && outputDigest(file.artifactRef) === outputDigest(ref)
    )
    if (matches.length !== 1) return fail()
    return matches[0] as CandidateBinaryArtifactFile
  }
  private async contextAssets(
    value: unknown,
    context: CandidateTextFile[]
  ): Promise<CandidateContextAsset[]> {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length + context.length > MAX_HARNESS_EVIDENCE_FILES)
      return fail()
    const paths = context.map((entry) => entry.path.normalize('NFC').toLowerCase())
    const assets: CandidateContextAsset[] = []
    for (const item of value) {
      const entry = plain(item)
      if (Object.keys(entry).sort().join(',') !== 'artifact,path,sourceExecutionId') return fail()
      const path = safePath(entry.path)
      const key = path.normalize('NFC').toLowerCase()
      if (
        paths.some((old) => key === old || key.startsWith(old + '/') || old.startsWith(key + '/'))
      )
        return fail()
      paths.push(key)
      const sourceExecutionId = string(entry.sourceExecutionId, 256)
      if (!this.admitted.has(sourceExecutionId)) return fail()
      const record = await this.options.core.get(sourceExecutionId)
      const artifact = await this.binaryArtifact(record, plain(entry.artifact).artifactRef)
      if (outputDigest(entry.artifact) !== outputDigest(artifact)) return fail()
      assets.push({ path, sourceExecutionId, artifact })
    }
    return assets
  }
  private scopeHeader(scope: string): string {
    return `EarthNano logical task: ${this.options.taskId}. Original method scope: ${scope}. Binding identity digest: ${this.options.bindingIdentity!.digest}.`
  }
  private validateResume(): Promise<void> {
    return (this.resumeValidated ??= Promise.all(
      this.options.resumeRecords!.map(async (record) => {
        const snapshots = await this.options.snapshots.resolve(record.request)
        const prefix = `EarthNano execution role: ${record.request.role}.\n\n${this.scopeHeader(this.requestScopes.get(record.requestKey)!)}\n\n`
        if (!snapshots.invocation.mission.startsWith(prefix))
          throw new Error('Optimization task or scope identity changed; paid replay refused')
      })
    ).then(() => undefined))
  }
  private assertScope(scope: string, role: ExecutionRole): void {
    const identity = this.options.bindingIdentity!
    if (
      role === 'baseline'
        ? scope !== identity.baseScope
        : !Object.values(identity.modeScopes).includes(scope)
    )
      return fail()
  }
  private async freeze(args: Record<string, unknown>): Promise<ExecutionRequest> {
    const { snapshots, input, projectId, optimizationId, taskId, budgetRef, timeoutMs } =
      this.options
    if (input.task.managedInputs?.some((entry) => entry.sourceProjectId !== projectId))
      return fail()
    const invocation = plain(args.invocation)
    if (invocation.taskId !== taskId || !roles.includes(invocation.role as ExecutionRole))
      return fail()
    const role = invocation.role as ExecutionRole
    const label = string(invocation.label, 256),
      stageLabel = string(invocation.stageLabel, 256)
    const scope = string(invocation.scope, 256)
    if (!label || !stageLabel || !scope) return fail()
    const v2slot = this.options.bindingIdentity
      ? harnessBindingV2Slot(this.options.bindingIdentity, taskId, {
          taskId: invocation.taskId,
          scope,
          role,
          stageLabel,
          label,
          attempt: invocation.attempt ?? 1
        })
      : undefined
    const mission = string(invocation.mission),
      system = string(invocation.system ?? '')
    const context = textFiles(args.contextFiles),
      harness = textFiles(args.harnessFiles)
    const assets = await this.contextAssets(args.assets, context)
    const retryOf = string(invocation.retryOfExecutionId ?? '', 256)
    if (retryOf && !this.admitted.has(retryOf)) return fail()
    if (
      retryOf &&
      this.options.bindingIdentity &&
      this.requestScopes.get((await this.options.core.get(retryOf)).requestKey) !== scope
    )
      return fail()
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
          tools: input.harness.tools
        }
      : input.harness
    const scientific = role === 'baseline' || role === 'candidate'
    const refs = await snapshots.freeze({
      ...input,
      harness: { ...proposed, tools: scientific ? input.harness.tools : 'workspace-only' },
      environment: scientific
        ? input.environment
        : {
            isolation: input.environment.isolation,
            network: 'provider-only'
          }
    })
    // Role context belongs to the invocation, not a newly invented research TaskSnapshot.
    const roleMission = [
      `EarthNano execution role: ${role}.`,
      ...(this.options.bindingIdentity ? [this.scopeHeader(scope)] : []),
      system,
      mission,
      'The following JSON contains frozen, read-only context files; interpret their relative paths inside this evidence package, not on the host filesystem.',
      // Preserve evidence bytes losslessly while keeping native file/shell expansion syntax
      // out of the actual prompt. This is JSON encoding, not a change to the evidence text.
      JSON.stringify(context).replaceAll('@', '\\u0040').replaceAll('`', '\\u0060'),
      ...(assets.length
        ? [
            'Additional binary assets are available at the listed relative paths under INPUT. The candidate text contains metadata only; inspect the actual assets as supported by your Read tool. Asset availability does not establish scientific correctness.',
            JSON.stringify(
              assets.map(({ path, artifact }) => ({
                path,
                sizeBytes: artifact.sizeBytes,
                ...(artifact.contentType ? { contentType: artifact.contentType } : {})
              }))
            )
              .replaceAll('@', '\\u0040')
              .replaceAll('`', '\\u0060')
          ]
        : []),
      ['proposer', 'composer'].includes(role)
        ? 'Emit the complete revised harness as files beneath OUTPUT/context/harness/: instructions.md and optional skills/name/SKILL.md. OUTPUT is the absolute output directory supplied by the Session owner. Read the current harness from the frozen JSON context; do not modify INPUT or any original context directory. Preserve unchanged harness files in the emitted tree. Finish with a short explanation of your changes.'
        : role === 'selector'
          ? assets.length
            ? 'Choose among the supplied anonymous candidate outputs. The frozen JSON context contains text and explicitly marked binary metadata; actual binary bytes are available under INPUT at the listed relative asset paths. Metadata does not establish binary content or scientific correctness. Use supported Read tools for the actual assets. Preserve the exact choice block and why format requested by the method in your final assistant reply. Return the original reply directly; do not emit a new research deliverable or alter a candidate.'
            : 'Your task is to choose among the supplied anonymous candidate outputs, not to produce another solution to the research task. The frozen JSON context above contains the complete candidate files referenced by the method. Use those files as evidence. Preserve the exact choice block and why format requested by the method in your final assistant reply. The Session owner persists that committed reply as selector-reply.md; return the original reply directly without a separate file transcription. Do not emit a new task deliverable or alter any candidate.'
          : role === 'reflection'
            ? 'Reflect on the supplied experiment evidence using the original method format. Preserve the requested <edits> and <experience> blocks in your final assistant reply (or the original NO_ENTRY outcome). The Session owner persists that committed reply as reflection-reply.md; return the original reply directly without a separate file transcription. Do not create another research deliverable, grade your own work, or invent unavailable verification evidence.'
            : notebookLanguageForTools(input.harness.tools) !== undefined
              ? notebookLanguageForTools(input.harness.tools) === 'r'
                ? 'Execute the scientific task with the original Notebook R tools and the exact managed inputs supplied by the Session owner. Use explicit language r for every Notebook execution. Publish task deliverables using the original Artifact tools. The input versions and R runtime are fixed; do not change them. Do not emit a replacement report through native output files.'
                : 'Execute the scientific task with the original Notebook Python tools and the exact managed inputs supplied by the Session owner. Publish task deliverables using the original Artifact tools. The input versions and Python runtime are fixed; do not change them. Do not emit a replacement report through native output files.'
              : 'Write task deliverables only beneath the absolute OUTPUT directory supplied by the Session owner.'
    ]
      .filter(Boolean)
      .join('\n\n')
    assertClaudeCandidateText(roleMission)
    const invocationRef = await snapshots.freezeInvocation({
      taskSnapshotRef: refs.taskSnapshotRef,
      harnessRevisionRef: refs.harnessRevisionRef,
      mission: roleMission,
      ...(assets.length ? { assets } : {})
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
    const slot = v2slot ?? outputDigest([role, stageLabel, label, invocation.attempt ?? 1])
    const previous = this.options.resumeRecords?.filter(
      (record) => this.options.resumeSlot?.(record.requestKey) === slot
    )
    const completed = previous?.find(
      (record) => record.phase === 'completed' && sameExecutionInputs(record.request, request)
    )
    let frozenRequest = request
    if (completed) {
      // Re-submit the ORIGINAL immutable request: Core returns the same handle without admission.
      await this.options.exportResult(completed)
      frozenRequest = structuredClone(completed.request)
      this.reused.add(completed.executionId)
    } else if (previous?.some((record) => record.phase === 'completed')) {
      throw new Error('Completed optimization stage identity changed; paid replay refused')
    } else if (previous?.length) {
      const last = previous.at(-1)!
      frozenRequest.origin.retryOfExecutionId = last.executionId
    }
    if (this.options.bindingIdentity) {
      this.options.onFreeze?.(frozenRequest, slot, scope)
      this.requestScopes.set(frozenRequest.requestKey, scope)
    } else this.options.onFreeze?.(frozenRequest, slot)
    this.requestSlots.set(frozenRequest.requestKey, slot)
    this.frozen.set(frozenRequest.requestKey, requestDigest(frozenRequest))
    return frozenRequest
  }
}

/** Runs the installed Harness² entrypoint over private stdio. No HTTP server, shell, secret argv,
 * or automatic recovery/replay. Cancellation is requested on every admitted execution on failure. */
export async function runHarnessProcess(options: {
  binding: Pick<HarnessOptimizationBinding, 'dispatch' | 'stop'>
  python: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
  /** Domain streams may expose partial evidence, but their caller still forbids adoption. */
  acceptPartial?: boolean
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
  let frameBytes = 0
  let queuedFrames = 0
  let diagnosticBytes = 0
  let failureCategory: HarnessFailureCategory | undefined
  let bindingCode: string | undefined
  let exitCode: number | null | undefined
  const seen = new Set<number>()
  let releaseStop!: () => void
  const stopped = new Promise<void>((resolve) => {
    releaseStop = resolve
  })
  const stop = (category: HarnessFailureCategory = 'harness-protocol'): void => {
    failureCategory ??= category
    failed = true
    releaseStop()
    child.kill('SIGKILL')
    void options.binding.stop()
  }
  const abort = (): void => stop('harness-cancelled')
  const timer = setTimeout(() => stop('harness-timeout'), options.timeoutMs)
  options.signal?.addEventListener('abort', abort, { once: true })
  child.stdout.on('data', (data: Buffer) => {
    // Protocol bytes are bounded per frame, not cumulatively across a legal multi-round run.
    // Also bound an unterminated frame before readline can accumulate an unlimited line.
    let offset = 0
    while (offset < data.length) {
      const newline = data.indexOf(10, offset)
      frameBytes += (newline < 0 ? data.length : newline + 1) - offset
      if (frameBytes > MAX_HARNESS_FRAME_BYTES) return stop('harness-frame-limit')
      if (newline < 0) break
      frameBytes = 0
      offset = newline + 1
    }
  })
  // Drain diagnostics without storing provider text or arbitrary Python exception data.
  child.stderr.on('data', (data) => {
    diagnosticBytes += data.length
    if (diagnosticBytes > MAX_HARNESS_DIAGNOSTIC_BYTES) stop('harness-diagnostic-limit')
  })
  child.stdin.on('error', () => stop('harness-io'))
  lines.on('line', (line) => {
    if (failed) return
    // The original locked client waits for each response. Bound queued work too, so a peer
    // cannot evade the per-frame memory bound by flooding many valid lines during an await.
    if (++queuedFrames > 2) return stop()
    pending = pending
      .then(async () => {
        if (failed || Buffer.byteLength(line) + 1 > MAX_HARNESS_FRAME_BYTES)
          return stop('harness-frame-limit')
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
          if (!failed) {
            const response = JSON.stringify({ id: message.id, result: value }) + '\n'
            if (Buffer.byteLength(response) > MAX_HARNESS_FRAME_BYTES)
              return stop('harness-frame-limit')
            child.stdin.write(response)
          }
        } catch (error) {
          const code = (error as { code?: string }).code
          const known = [
            'budget-exhausted',
            'request-conflict',
            'cleanup-unconfirmed',
            'not-found'
          ].includes(code ?? '')
          failureCategory ??= 'harness-binding'
          if (known) bindingCode = code
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
      .catch(() => stop())
      .finally(() => {
        queuedFrames--
      })
  })
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    await Promise.race([pending, stopped])
    const partial =
      options.acceptPartial &&
      exitCode === 1 &&
      result !== null &&
      typeof result === 'object' &&
      (result as { status?: string }).status === 'partial'
    if (failed || (exitCode !== 0 && !partial) || result === undefined) {
      failed = true
      throw new HarnessProcessFailure({
        category: failureCategory ?? (exitCode !== 0 ? 'harness-exit' : 'harness-result-missing'),
        exitCode,
        protocolStatus:
          result && typeof result === 'object'
            ? (result as { status?: unknown }).status
            : undefined,
        bindingCode
      })
    }
    return result
  } catch (error) {
    if (error instanceof HarnessProcessFailure) throw error
    throw new HarnessProcessFailure({ category: failureCategory ?? 'harness-spawn', exitCode })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    lines.close()
    if (failed || result === undefined) await options.binding.stop()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}
