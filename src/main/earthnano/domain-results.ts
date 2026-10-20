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
      paths.has(file.path)
    )
      throw new Error('Invalid Library projection path')
    paths.add(file.path)
    bytes += Buffer.byteLength(file.content)
  }
  if (files.length > 128 || bytes > 512000)
    throw new Error('Library projection exceeds text profile')
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
    if (
      !exported.files.some(
        (file) => file.path === 'experience.md' && file.content === exported.replyText
      )
    )
      throw new Error('Reflection reply lacks its exact persisted artifact')
    const snapshots = await options.snapshots.resolve(selected.request)
    const mode = (row.method as { mode?: string })?.mode === 'parallel' ? 'agg' : 'seq'
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
    for (const key of ['cue', 'lesson', 'evidence']) {
      const value = block
        ?.split(/\r?\n/)
        .find((line) =>
          line
            .trim()
            .toLowerCase()
            .startsWith(key + ':')
        )
        ?.split(':')
        .slice(1)
        .join(':')
        .trim()
      if (!value || !experience?.content.includes(value))
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
