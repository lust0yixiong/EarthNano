import { createHash } from 'node:crypto'
import type { ArtifactReference, ExecutionRecord } from '../../shared/earthnano/execution-port'
import type {
  DomainOptimizationSummary,
  OptimizationDomainSpec
} from '../../shared/earthnano/research-outcome'
import type { CandidateSnapshotStore } from './candidate-snapshot'
import type { PersistentCandidateOwners } from './persistent-candidate-owner'
import type { OptimizationSelectionSummary } from '../../shared/earthnano/desktop-optimization'
import { canonicalOutput, outputDigest } from './output-checks'
import { chosenExecution } from './research-verification'
import { normalizeOptimizationMethod } from '../../shared/earthnano/optimization-method'
import { MAX_HARNESS_EVIDENCE_BYTES, MAX_HARNESS_EVIDENCE_FILES } from './harness-binding-limits'

export interface DomainMethodTask {
  taskId: string
  status: string
  executionIds: string[]
  chosenArtifacts: ArtifactReference[]
  selection: OptimizationSelectionSummary
  method: unknown
  reflection?: { executionId: string; artifacts: ArtifactReference[] }
}
export interface DomainMethodResult {
  status: string
  domain: string
  order: string[]
  tasks: DomainMethodTask[]
  library: { files: Array<{ path: string; content: string }>; entries: string[] }
}
/** Python's Library is a projection. Every entry must bind back to platform-owned
 * candidate configuration and reflection ArtifactVersions, never to a current workspace. */
export async function prepareDomainSummary(options: {
  result: unknown
  domain: OptimizationDomainSpec
  taskIds: string[]
  recordsForTask(taskId: string): ExecutionRecord[]
  snapshots: CandidateSnapshotStore
  owners: PersistentCandidateOwners
}): Promise<DomainOptimizationSummary> {
  const result = options.result as DomainMethodResult
  if (
    !result ||
    result.domain !== options.domain.name ||
    canonicalOutput(result.order) !== canonicalOutput(options.taskIds) ||
    !Array.isArray(result.tasks) ||
    result.tasks.length !== options.taskIds.length ||
    !result.library ||
    !Array.isArray(result.library.files) ||
    !Array.isArray(result.library.entries)
  )
    throw new Error('Invalid original domain projection')
  const entries = result.library.entries
  if (
    new Set(entries).size !== entries.length ||
    entries.some((id) => !options.taskIds.includes(id))
  )
    throw new Error('Invalid Library task provenance')
  const files = result.library.files
  const modes = result.tasks.map((row) => normalizeOptimizationMethod(row.method).mode)
  if (new Set(modes).size !== 1) throw new Error('Library projection mixes recursion modes')
  const mode = modes[0] === 'parallel' ? 'agg' : 'seq'
  const root = `${mode}/${options.domain.name}/`
  const paths = new Set<string>()
  let bytes = 0
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      typeof file.content !== 'string' ||
      file.path.startsWith('/') ||
      /[\\\0]/.test(file.path) ||
      file.path.split('/').some((p) => !p || p === '.' || p === '..') ||
      paths.has(file.path.normalize('NFC').toLowerCase())
    )
      throw new Error('Invalid Library projection path')
    paths.add(file.path.normalize('NFC').toLowerCase())
    if (file.path !== root + 'INDEX.md') {
      const owner = entries.find((taskId) => file.path.startsWith(`${root}harnesses/${taskId}/`))
      const suffix = owner ? file.path.slice(`${root}harnesses/${owner}/`.length) : ''
      if (
        !owner ||
        !/^(?:EXPERIENCE\.md|harness\/instructions\.md|harness\/skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md)$/.test(
          suffix
        )
      )
        throw new Error('Library file lacks admitted task and text-profile provenance')
    }
    bytes += Buffer.byteLength(file.content)
  }
  if (files.length > MAX_HARNESS_EVIDENCE_FILES || bytes > MAX_HARNESS_EVIDENCE_BYTES)
    throw new Error('Library projection exceeds text profile')
  if (entries.length && !files.some((file) => file.path === root + 'INDEX.md'))
    throw new Error('Library entries lack their original index')
  const tasks = []
  for (const taskId of options.taskIds) {
    const rows = result.tasks.filter((row) => row.taskId === taskId)
    if (rows.length !== 1) throw new Error('Domain task result identity mismatch')
    const row = rows[0]!,
      records = options.recordsForTask(taskId)
    if (
      !Array.isArray(row.executionIds) ||
      new Set(row.executionIds).size !== row.executionIds.length ||
      canonicalOutput([...row.executionIds].sort()) !==
        canonicalOutput(records.map((r) => r.executionId).sort())
    )
      throw new Error('Domain execution ownership mismatch')
    const summary = {
      taskId,
      ...(row.selection ? { selection: structuredClone(row.selection) } : {})
    }
    if (!entries.includes(taskId)) {
      tasks.push(summary)
      continue
    }
    if (row.status !== 'ok' || !row.reflection)
      throw new Error('Library entry lacks adopted execution/reflection evidence')
    const selected = chosenExecution(records, row)
    const reflection = records.find((r) => r.executionId === row.reflection!.executionId)
    if (
      !reflection ||
      reflection.request.role !== 'reflection' ||
      reflection.phase !== 'completed' ||
      reflection.cleanup !== 'confirmed' ||
      canonicalOutput(reflection.evidence.artifacts) !== canonicalOutput(row.reflection.artifacts)
    )
      throw new Error('Reflection version identity mismatch')
    const exported = await options.owners.exportResult(reflection)
    const reflectionFiles = exported.files.map((file) => {
      if ('representation' in file)
        throw new Error('Reflection requires actual persisted UTF-8 text artifacts')
      return file
    })
    if (
      exported.executionId !== reflection.executionId ||
      canonicalOutput(exported.artifacts) !== canonicalOutput(reflection.evidence.artifacts) ||
      reflectionFiles.some(
        (file) =>
          file.digest !== 'sha256:' + createHash('sha256').update(file.content).digest('hex') ||
          !exported.artifacts.some(
            (ref) => canonicalOutput(ref) === canonicalOutput(file.artifactRef)
          )
      )
    )
      throw new Error('Reflection immutable export identity/checksum mismatch')
    const experienceBlock = (text: string): string | undefined =>
      /<experience>[\s\S]*?<\/experience>/.exec(text)?.[0]
    const persisted = reflectionFiles.filter((file) => file.path === 'reflection-reply.md')
    const replyBlock = experienceBlock(exported.replyText)
    if (
      persisted.length !== 1 ||
      !replyBlock ||
      persisted[0]!.content !== exported.replyText ||
      experienceBlock(persisted[0]!.content) !== replyBlock
    )
      throw new Error('Reflection reply lacks its exact persisted artifact')
    const snapshots = await options.snapshots.resolve(selected.request)
    const prefix = `${mode}/${options.domain.name}/harnesses/${taskId}/`
    const inventory = files
      .filter((file) => file.path.startsWith(prefix + 'harness/'))
      .map((file) => ({
        path: file.path.slice((prefix + 'harness/').length),
        content: file.content
      }))
      .sort((a, b) => a.path.localeCompare(b.path, 'en'))
    const expected = [
      { path: 'instructions.md', content: snapshots.harness.instructions },
      ...snapshots.harness.skills.map((file) => ({
        path: 'skills/' + file.path,
        content: file.content
      }))
    ].sort((a, b) => a.path.localeCompare(b.path, 'en'))
    if (canonicalOutput(inventory) !== canonicalOutput(expected))
      throw new Error('Library harness differs from the selected execution configuration')
    const experience = files.find((file) => file.path === prefix + 'EXPERIENCE.md')
    const block = /<experience>([\s\S]*?)<\/experience>/.exec(exported.replyText)?.[1]
    // Match upstream _distil: trim/lower keys around the first colon; later fields win.
    const fields = new Map<string, string>()
    for (const line of block?.split(/\r?\n/) ?? []) {
      const colon = line.indexOf(':')
      if (colon >= 0)
        fields.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
    }
    for (const key of ['cue', 'lesson', 'evidence']) {
      const value = fields.get(key)
      const stored = experience?.content
        .split(/\r?\n/)
        .filter((line) => line.startsWith(`- **${key}**:`))
      if (!value || stored?.length !== 1 || stored[0] !== `- **${key}**: ${value}`)
        throw new Error('Library lesson differs from fixed reflection evidence')
    }
    tasks.push({
      ...summary,
      experience: {
        scope: 'experiment' as const,
        reflectionExecutionId: reflection.executionId,
        reflectionArtifacts: structuredClone(reflection.evidence.artifacts),
        selectedExecutionId: selected.executionId,
        selectedHarnessRevisionRef: structuredClone(selected.request.harnessRevisionRef),
        libraryDigest: outputDigest(files.filter((file) => file.path.startsWith(prefix)))
      }
    })
  }
  return {
    name: options.domain.name,
    order: [...options.taskIds],
    tasks,
    library: { scope: 'experiment', entries: [...entries], digest: outputDigest(files) }
  }
}
