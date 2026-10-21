import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, chmod, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import type { ExecutionRequest, Ref } from '../../shared/earthnano/execution-port'
import { defaultFileDurability } from '@aipoch/durable-files'
import {
  normalizeCandidateArtifactFile,
  type CandidateBinaryArtifactFile
} from '../../shared/earthnano/candidate-artifact'
import {
  assertDiskReserve,
  copyOpenFileWithinBudget,
  digestFileWithinBudget
} from '../bounded-file-io'
import { LOCAL_RESOURCE_BUDGETS, assertWithinResourceBudget } from '../resource-budget'
import { availableBytes } from '../storage/usage'
import {
  normalizeFrozenNotebookInputs,
  notebookLanguageForTools,
  type NotebookToolsProfile,
  normalizeFrozenNotebookRuntime,
  type FrozenNotebookInput,
  type FrozenNotebookRuntime
} from '../../shared/earthnano/notebook-profile'

export type CandidateTextFile = Readonly<{ path: string; content: string }>
export type CandidateTask = Readonly<{
  prompt: string
  files: readonly CandidateTextFile[]
  managedInputs?: readonly FrozenNotebookInput[]
}>
export type CandidateHarness = Readonly<{
  instructions: string
  skills: readonly CandidateTextFile[]
  tools: 'workspace-only' | NotebookToolsProfile
}>
export type CandidateAgent = Readonly<{
  backend: 'claude-code'
  model: string
  providerRef: string
  runtimeVersion: string
}>
export type CandidateEnvironment = Readonly<{
  isolation: 'directory-process'
  network: 'provider-only' | 'provider-and-notebook-policy'
  notebook?: Readonly<{ runtime: FrozenNotebookRuntime }>
}>
export type CandidateSnapshotInput = Readonly<{
  task: CandidateTask
  harness: CandidateHarness
  agent: CandidateAgent
  environment: CandidateEnvironment
}>
export type CandidateSnapshotRefs = Pick<
  ExecutionRequest,
  'taskSnapshotRef' | 'harnessRevisionRef' | 'agentSpecRef' | 'environmentSpecRef'
>
export type CandidateExecutionRefs = CandidateSnapshotRefs & Pick<ExecutionRequest, 'invocationRef'>
export type CandidateInvocation = Readonly<{
  taskSnapshotRef: Ref
  harnessRevisionRef: Ref
  mission: string
  assets?: readonly CandidateContextAsset[]
}>
/** Host-only provenance. The method binding authorizes the exact admitted source before freezing.
 * Source identities are not candidate labels or a model-facing arbitrary file capability. */
export type CandidateContextAsset = Readonly<{
  path: string
  sourceExecutionId: string
  artifact: CandidateBinaryArtifactFile
}>
export type ResolvedCandidateSnapshots = CandidateSnapshotInput &
  Readonly<{ invocation: CandidateInvocation }>
export type CandidateManifestEntry = Readonly<{ path: string; digest: string; bytes: number }>
export type MaterializedCandidate = Readonly<{
  root: string
  cwd: string
  inputDir: string
  outputDir: string
  runtimeHome: string
  harnessDir: string
  instructionsPath: string
  skillsDir: string
  snapshots: ResolvedCandidateSnapshots
  manifest: readonly CandidateManifestEntry[]
  /** Snapshot projection only; native runtime configuration must be attested separately. */
  materializedDigest: string
}>
export interface CandidateSnapshotStore {
  freeze(input: CandidateSnapshotInput): Promise<CandidateSnapshotRefs>
  freezeInvocation(input: CandidateInvocation): Promise<Ref>
  resolve(refs: CandidateExecutionRefs): Promise<ResolvedCandidateSnapshots>
  materialize(input: {
    executionId: string
    refs: CandidateExecutionRefs
    signal?: AbortSignal
  }): Promise<MaterializedCandidate>
}

type Kind = 'task' | 'harness' | 'agent' | 'environment' | 'invocation'
const sha256 = (content: string): string =>
  `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const object = (
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> => {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error('Candidate snapshot requires a plain object')
  const result = value as Record<string, unknown>
  if (
    keys.some((key) => !Object.hasOwn(result, key)) ||
    Object.keys(result).some((key) => !keys.includes(key) && !optional.includes(key))
  )
    throw new Error('Candidate snapshot has missing or unsupported fields')
  return result
}

const text = (value: unknown, nonempty = false): string => {
  if (typeof value !== 'string' || value.includes('\0') || (nonempty && !value.trim()))
    throw new Error('Candidate snapshot requires valid text')
  for (const character of value) {
    const point = character.codePointAt(0)!
    if (point >= 0xd800 && point <= 0xdfff) throw new Error('Candidate text has a lone surrogate')
  }
  return value
}

const portablePath = (value: unknown): string => {
  const path = text(value, true)
  const parts = path.split('/')
  if (
    isAbsolute(path) ||
    /[\\:*?"<>|]/.test(path) ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
  )
    throw new Error('Candidate file path is not a portable relative path')
  return path
}

const files = (value: unknown, skills = false): CandidateTextFile[] => {
  if (!Array.isArray(value)) throw new Error('Candidate files must be an array')
  const result = value
    .map((entry) => {
      const file = object(entry, ['path', 'content'])
      const path = portablePath(file.path)
      // This integration supports data and textual Skill resources, never executable harness scripts.
      if (skills && !/\.(md|txt|json|ya?ml|csv|tsv)$/i.test(path))
        throw new Error('Unsupported executable or non-text Skill resource')
      return { path, content: text(file.content) }
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const seen = new Set<string>()
  for (const file of result) {
    const key = file.path.normalize('NFC').toLowerCase()
    if (
      seen.has(key) ||
      [...seen].some((other) => key.startsWith(`${other}/`) || other.startsWith(`${key}/`))
    )
      throw new Error('Candidate files collide or would overwrite a directory')
    seen.add(key)
  }
  return result
}

const ref = (value: unknown, kind: Kind): Ref => {
  const entry = object(value, ['id', 'version', 'digest'])
  const digest = text(entry.digest)
  if (
    !/^sha256:[a-f0-9]{64}$/.test(digest) ||
    entry.version !== '1' ||
    entry.id !== `candidate:${kind}:${digest.slice(7)}`
  )
    throw new Error('Invalid candidate snapshot reference')
  return { id: entry.id as string, version: '1', digest }
}

const sameRef = (left: Ref, right: Ref): boolean => canonical(left) === canonical(right)

const contextAssets = (value: unknown): CandidateContextAsset[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64)
    throw new Error('Candidate assets require a bounded nonempty manifest')
  const result = value.map((item) => {
    const entry = object(item, ['path', 'sourceExecutionId', 'artifact'])
    const artifact = normalizeCandidateArtifactFile(entry.artifact)
    if (!('representation' in artifact))
      throw new Error('Candidate context assets require a binary descriptor')
    const sourceExecutionId = text(entry.sourceExecutionId, true)
    if (
      sourceExecutionId.length > 256 ||
      [...sourceExecutionId].some((character) => {
        const point = character.codePointAt(0)!
        return point < 32 || point === 127
      })
    )
      throw new Error('Invalid candidate asset source identity')
    return { path: portablePath(entry.path), sourceExecutionId, artifact }
  })
  files(result.map(({ path }) => ({ path, content: '' })))
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

const validateInvocationFiles = (task: CandidateTask, invocation: CandidateInvocation): void => {
  if (invocation.assets)
    files([...task.files, ...invocation.assets.map(({ path }) => ({ path, content: '' }))])
}

const normalize = (kind: Kind, value: unknown): unknown => {
  if (kind === 'task') {
    const entry = object(value, ['prompt', 'files'], ['managedInputs'])
    const taskFiles = files(entry.files)
    const managedInputs = Object.hasOwn(entry, 'managedInputs')
      ? normalizeFrozenNotebookInputs(entry.managedInputs)
      : undefined
    if (managedInputs && taskFiles.length)
      throw new Error('Notebook tasks cannot mix immutable managed inputs and inline files')
    return {
      prompt: text(entry.prompt),
      files: taskFiles,
      ...(managedInputs ? { managedInputs } : {})
    } satisfies CandidateTask
  }
  if (kind === 'harness') {
    const entry = object(value, ['instructions', 'skills', 'tools'])
    if (entry.tools !== 'workspace-only' && notebookLanguageForTools(entry.tools) === undefined)
      throw new Error('Unsupported candidate tools profile')
    return {
      instructions: text(entry.instructions),
      skills: files(entry.skills, true),
      tools: entry.tools as CandidateHarness['tools']
    } satisfies CandidateHarness
  }
  if (kind === 'agent') {
    const entry = object(value, ['backend', 'model', 'providerRef', 'runtimeVersion'])
    if (entry.backend !== 'claude-code') throw new Error('Unsupported candidate backend')
    const providerRef = text(entry.providerRef, true)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,255}$/.test(providerRef))
      throw new Error('Candidate providerRef must be an opaque handle, not a URL or path')
    return {
      backend: 'claude-code',
      model: text(entry.model, true),
      providerRef,
      runtimeVersion: text(entry.runtimeVersion, true)
    } satisfies CandidateAgent
  }
  if (kind === 'environment') {
    const entry = object(value, ['isolation', 'network'], ['notebook'])
    const notebook = Object.hasOwn(entry, 'notebook')
      ? { runtime: normalizeFrozenNotebookRuntime(object(entry.notebook, ['runtime']).runtime) }
      : undefined
    if (
      entry.isolation !== 'directory-process' ||
      entry.network !== (notebook ? 'provider-and-notebook-policy' : 'provider-only')
    )
      throw new Error('Unsupported candidate environment profile')
    return {
      isolation: 'directory-process',
      network: entry.network as CandidateEnvironment['network'],
      ...(notebook ? { notebook } : {})
    } satisfies CandidateEnvironment
  }
  const entry = object(value, ['taskSnapshotRef', 'harnessRevisionRef', 'mission'], ['assets'])
  return {
    taskSnapshotRef: ref(entry.taskSnapshotRef, 'task'),
    harnessRevisionRef: ref(entry.harnessRevisionRef, 'harness'),
    mission: text(entry.mission),
    ...(Object.hasOwn(entry, 'assets') ? { assets: contextAssets(entry.assets) } : {})
  } satisfies CandidateInvocation
}

const validateProfile = (
  task: CandidateTask,
  harness: CandidateHarness,
  environment: CandidateEnvironment
): void => {
  const language = notebookLanguageForTools(harness.tools)
  const scientific = language !== undefined
  if (scientific !== Boolean(environment.notebook) || (scientific && !task.managedInputs?.length))
    throw new Error('Notebook tools require fixed managed inputs and a frozen runtime')
  if (scientific && environment.notebook?.runtime.language !== language)
    throw new Error('Notebook tools/runtime language mismatch')
}

const freezeDeep = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

const directory = async (path: string): Promise<{ path: string; assert(): Promise<void> }> => {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Candidate root must be a real directory')
  const resolved = await realpath(path)
  return {
    path: resolved,
    async assert() {
      const current = await lstat(resolved)
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino
      )
        throw new Error('Candidate directory identity changed')
    }
  }
}

const readRegular = async (path: string): Promise<string> => {
  // O_NOFOLLOW is not provided on every supported platform. Keep an explicit no-link check too.
  const observed = await lstat(path)
  if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1)
    throw new Error('Candidate object is not a singly linked regular file')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.dev !== observed.dev ||
      stat.ino !== observed.ino
    )
      throw new Error('Candidate object is not a singly linked regular file')
    const current = await lstat(path)
    if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino)
      throw new Error('Candidate object identity changed while reading')
    const bytes = await handle.readFile()
    const content = bytes.toString('utf8')
    if (!Buffer.from(content, 'utf8').equals(bytes))
      throw new Error('Candidate object is not valid UTF-8')
    return content
  } finally {
    await handle.close()
  }
}

/** Owns immutable text objects and exclusive pre-spawn directory projections, never processes.
 * Directory/process isolation and mode bits are not an OS sandbox against the same user. */
export const createCandidateSnapshotStore = async ({
  root,
  candidatesRoot,
  materializeAsset
}: {
  root: string
  candidatesRoot: string
  /** Host-only original Version owner; never deserialize this callback from a request. */
  materializeAsset?(
    asset: CandidateContextAsset,
    signal?: AbortSignal
  ): Promise<{ file: CandidateBinaryArtifactFile; assetPath: string }>
}): Promise<CandidateSnapshotStore> => {
  const contentRoot = await directory(root)
  const candidateRoot = await directory(candidatesRoot)
  const contains = (parent: string, child: string): boolean => {
    const rel = relative(parent, child)
    return !rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  }
  if (
    contains(contentRoot.path, candidateRoot.path) ||
    contains(candidateRoot.path, contentRoot.path)
  )
    throw new Error('Candidate content and execution directories must not overlap')
  const objects = await directory(join(contentRoot.path, 'objects'))
  const pending = new Map<string, Promise<Ref>>()
  const read = async (reference: Ref, kind: Kind): Promise<unknown> => {
    const checked = ref(reference, kind)
    await contentRoot.assert()
    await objects.assert()
    const body = await readRegular(join(objects.path, `${checked.digest.slice(7)}.json`))
    if (sha256(body) !== checked.digest)
      throw new Error('Candidate snapshot content digest mismatch')
    const envelope = object(JSON.parse(body), ['version', 'kind', 'value'])
    if (envelope.version !== 1 || envelope.kind !== kind)
      throw new Error('Candidate object kind/version mismatch')
    const value = normalize(kind, envelope.value)
    if (canonical({ version: 1, kind, value }) !== body)
      throw new Error('Candidate object is not canonical')
    return freezeDeep(value)
  }
  const put = (kind: Kind, input: unknown): Promise<Ref> => {
    const value = normalize(kind, input)
    const body = canonical({ version: 1, kind, value })
    const digest = sha256(body)
    const reference = { id: `candidate:${kind}:${digest.slice(7)}`, version: '1', digest }
    const existing = pending.get(digest)
    if (existing) return existing
    const writing = (async () => {
      await contentRoot.assert()
      await objects.assert()
      const path = join(objects.path, `${digest.slice(7)}.json`)
      try {
        const handle = await open(path, 'wx', 0o400)
        try {
          await handle.writeFile(body, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        await defaultFileDurability.syncDirectory(objects.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      await read(reference, kind)
      return freezeDeep(reference)
    })()
    pending.set(digest, writing)
    void writing.finally(() => pending.delete(digest)).catch(() => undefined)
    return writing
  }
  const resolve = async (refs: CandidateExecutionRefs): Promise<ResolvedCandidateSnapshots> => {
    const [task, harness, agent, environment, invocation] = (await Promise.all([
      read(refs.taskSnapshotRef, 'task'),
      read(refs.harnessRevisionRef, 'harness'),
      read(refs.agentSpecRef, 'agent'),
      read(refs.environmentSpecRef, 'environment'),
      read(refs.invocationRef, 'invocation')
    ])) as [
      CandidateTask,
      CandidateHarness,
      CandidateAgent,
      CandidateEnvironment,
      CandidateInvocation
    ]
    if (
      !sameRef(invocation.taskSnapshotRef, refs.taskSnapshotRef) ||
      !sameRef(invocation.harnessRevisionRef, refs.harnessRevisionRef)
    )
      throw new Error('Candidate invocation refers to a different task or Harness revision')
    validateProfile(task, harness, environment)
    validateInvocationFiles(task, invocation)
    return freezeDeep({ task, harness, agent, environment, invocation })
  }
  return {
    async freeze(input) {
      object(input, ['task', 'harness', 'agent', 'environment'])
      // Validate the entire bundle before committing any objects.
      for (const kind of ['task', 'harness', 'agent', 'environment'] as const)
        normalize(kind, input[kind])
      validateProfile(input.task, input.harness, input.environment)
      const [taskSnapshotRef, harnessRevisionRef, agentSpecRef, environmentSpecRef] =
        await Promise.all([
          put('task', input.task),
          put('harness', input.harness),
          put('agent', input.agent),
          put('environment', input.environment)
        ])
      return freezeDeep({ taskSnapshotRef, harnessRevisionRef, agentSpecRef, environmentSpecRef })
    },
    async freezeInvocation(input) {
      const checked = normalize('invocation', input) as CandidateInvocation
      const [task] = await Promise.all([
        read(checked.taskSnapshotRef, 'task'),
        read(checked.harnessRevisionRef, 'harness')
      ])
      validateInvocationFiles(task as CandidateTask, checked)
      return put('invocation', checked)
    },
    resolve,
    async materialize({ executionId, refs, signal }) {
      signal?.throwIfAborted()
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(executionId))
        throw new Error('Candidate executionId is not a safe directory identity')
      const snapshots = await resolve(refs)
      if (snapshots.invocation.assets && !materializeAsset)
        throw new Error('Original candidate asset owner is unavailable')
      if (snapshots.invocation.assets) {
        let bytes = snapshots.task.files.reduce(
          (total, file) => total + Buffer.byteLength(file.content, 'utf8'),
          0
        )
        for (const asset of snapshots.invocation.assets) {
          assertWithinResourceBudget(
            'file',
            asset.artifact.sizeBytes,
            LOCAL_RESOURCE_BUDGETS.artifactFileBytes
          )
          bytes += asset.artifact.sizeBytes
          assertWithinResourceBudget('turn', bytes, LOCAL_RESOURCE_BUDGETS.artifactTurnBytes)
        }
      }
      await candidateRoot.assert()
      const projectionRoot = join(candidateRoot.path, executionId)
      await mkdir(projectionRoot, { mode: 0o700 }) // Exclusive. Existing directories/links are never reused.
      const projection = await directory(projectionRoot)
      const cwd = join(projectionRoot, 'workspace')
      const inputDir = join(cwd, 'inputs')
      const outputDir = join(cwd, 'outputs')
      const runtimeHome = join(projectionRoot, 'runtime')
      const harnessDir = join(projectionRoot, 'harness')
      const instructionsPath = join(harnessDir, 'instructions.md')
      const skillsDir = join(harnessDir, 'skills')
      const manifest: CandidateManifestEntry[] = []
      const directories = new Set([inputDir, harnessDir, skillsDir])
      const ensureDirectory = async (path: string): Promise<void> => {
        await projection.assert()
        let current = projectionRoot
        for (const part of relative(projectionRoot, path).split(sep)) {
          current = join(current, part)
          try {
            await mkdir(current, { mode: 0o700 })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          }
          const stat = await lstat(current)
          if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error('Candidate projection contains a link')
        }
      }
      for (const path of [inputDir, outputDir, runtimeHome, skillsDir]) await ensureDirectory(path)
      const write = async (path: string, content: string): Promise<void> => {
        signal?.throwIfAborted()
        const rel = relative(projectionRoot, path).split(sep).join('/')
        let parent = dirname(path)
        await ensureDirectory(parent)
        while (parent !== projectionRoot) {
          directories.add(parent)
          parent = dirname(parent)
        }
        const handle = await open(path, 'wx', 0o400)
        try {
          await handle.writeFile(content, 'utf8')
        } finally {
          await handle.close()
        }
        const persisted = await readRegular(path)
        if (persisted !== content) throw new Error('Candidate projection bytes changed')
        manifest.push({
          path: rel,
          digest: sha256(content),
          bytes: Buffer.byteLength(content, 'utf8')
        })
      }
      for (const file of snapshots.task.files) await write(join(inputDir, file.path), file.content)
      for (const asset of snapshots.invocation.assets ?? []) {
        signal?.throwIfAborted()
        const original = await materializeAsset!(asset, signal)
        signal?.throwIfAborted()
        if (
          canonical(normalizeCandidateArtifactFile(original.file)) !== canonical(asset.artifact) ||
          !isAbsolute(original.assetPath)
        )
          throw new Error('Original candidate asset differs from its frozen Version')
        const path = join(inputDir, asset.path)
        let parent = dirname(path)
        await ensureDirectory(parent)
        while (parent !== projectionRoot) {
          directories.add(parent)
          parent = dirname(parent)
        }
        const observed = await lstat(original.assetPath)
        if (
          !observed.isFile() ||
          observed.isSymbolicLink() ||
          observed.nlink !== 1 ||
          observed.size !== asset.artifact.sizeBytes
        )
          throw new Error('Candidate asset is not the original ordinary file')
        assertWithinResourceBudget('file', observed.size, LOCAL_RESOURCE_BUDGETS.artifactFileBytes)
        assertDiskReserve(
          await availableBytes(inputDir),
          observed.size,
          LOCAL_RESOURCE_BUDGETS.diskReserveBytes
        )
        const handle = await open(
          original.assetPath,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
        )
        let copied = false
        try {
          const before = await handle.stat()
          if (
            !before.isFile() ||
            before.nlink !== 1 ||
            before.dev !== observed.dev ||
            before.ino !== observed.ino
          )
            throw new Error('Candidate asset identity changed while opening')
          const result = await copyOpenFileWithinBudget(
            handle,
            path,
            asset.artifact.sizeBytes,
            signal
          )
          copied = true
          const after = await handle.stat()
          const current = await lstat(original.assetPath)
          if (
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs ||
            current.isSymbolicLink() ||
            current.dev !== before.dev ||
            current.ino !== before.ino ||
            result.sizeBytes !== asset.artifact.sizeBytes ||
            `sha256:${result.checksum}` !== asset.artifact.digest
          )
            throw new Error('Original candidate asset bytes changed')
          await ensureDirectory(dirname(path))
          await chmod(path, 0o400)
          const targetBefore = await lstat(path)
          if (!targetBefore.isFile() || targetBefore.isSymbolicLink() || targetBefore.nlink !== 1)
            throw new Error('Candidate asset projection is linked')
          const persisted = await digestFileWithinBudget(path, asset.artifact.sizeBytes, signal)
          const targetAfter = await lstat(path)
          if (
            targetBefore.dev !== targetAfter.dev ||
            targetBefore.ino !== targetAfter.ino ||
            targetBefore.size !== targetAfter.size ||
            targetBefore.mtimeMs !== targetAfter.mtimeMs ||
            targetBefore.ctimeMs !== targetAfter.ctimeMs ||
            targetAfter.isSymbolicLink() ||
            persisted.sizeBytes !== asset.artifact.sizeBytes ||
            `sha256:${persisted.checksum}` !== asset.artifact.digest
          )
            throw new Error('Candidate asset projection bytes changed')
          manifest.push({
            path: relative(projectionRoot, path).split(sep).join('/'),
            digest: asset.artifact.digest,
            bytes: persisted.sizeBytes
          })
        } catch (error) {
          if (copied) await rm(path, { force: true }).catch(() => undefined)
          throw error
        } finally {
          await handle.close()
        }
      }
      await write(instructionsPath, snapshots.harness.instructions)
      for (const file of snapshots.harness.skills)
        await write(join(skillsDir, file.path), file.content)
      // Lock only immutable inputs/Harness directories. The workspace and outputs remain writable.
      directories.delete(cwd)
      for (const path of [...directories].sort((a, b) => b.length - a.length)) {
        await ensureDirectory(path)
        await chmod(path, 0o500)
      }
      manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      const materializedDigest = sha256(
        canonical({
          version: 1,
          refs: {
            taskSnapshotRef: refs.taskSnapshotRef,
            harnessRevisionRef: refs.harnessRevisionRef,
            agentSpecRef: refs.agentSpecRef,
            environmentSpecRef: refs.environmentSpecRef,
            invocationRef: refs.invocationRef
          },
          manifest
        })
      )
      return freezeDeep({
        root: projectionRoot,
        cwd,
        inputDir,
        outputDir,
        runtimeHome,
        harnessDir,
        instructionsPath,
        skillsDir,
        snapshots,
        manifest,
        materializedDigest
      })
    }
  }
}
