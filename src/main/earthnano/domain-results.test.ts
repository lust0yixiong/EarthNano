import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prepareDomainSummary, type DomainMethodResult } from './domain-results'
import { fixture, input, reflectionText } from './research-domain.test-fixture'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Preserve the exact inferred composite fixture type for adversarial mutations.
async function setup() {
  const f = await fixture()
  const taskIds = ['experiment-0001', 'experiment-0002']
  const selected = await Promise.all(
    taskIds.map((id) =>
      f.record('candidate', `${id}-final`, { harness: `Pinned selected harness for ${id}.` })
    )
  )
  const reflected = await Promise.all(
    taskIds.map((id) => f.record('reflection', `${id}-reflection`))
  )
  const records = new Map(taskIds.map((id, index) => [id, [selected[index]!, reflected[index]!]]))
  const result: DomainMethodResult = {
    status: 'ok',
    domain: 'rows',
    order: taskIds,
    tasks: taskIds.map((taskId, index) => ({
      taskId,
      status: 'ok',
      executionIds: records.get(taskId)!.map((r) => r.executionId),
      chosenArtifacts: selected[index]!.evidence.artifacts,
      method: { mode: 'sequential', k: 1, concurrency: 1 },
      selection: {
        chosenLabel: 'c1',
        candidateCount: 1,
        trivial: true,
        fallback: false,
        reason: 'Single final'
      },
      reflection: {
        executionId: reflected[index]!.executionId,
        artifacts: reflected[index]!.evidence.artifacts
      }
    })),
    library: {
      entries: taskIds,
      files: [
        { path: 'seq/rows/INDEX.md', content: '# Library — rows' },
        ...taskIds.flatMap((taskId) => [
          {
            path: `seq/rows/harnesses/${taskId}/harness/instructions.md`,
            content: `Pinned selected harness for ${taskId}.`
          },
          {
            path: `seq/rows/harnesses/${taskId}/EXPERIENCE.md`,
            content: `# ${taskId}\n\n## Transferable lesson\n- **cue**: Row reconciliation\n- **lesson**: Verify all source rows\n- **evidence**: The adopted output reconciles all rows\n- **confidence**: provisional\n`
          }
        ])
      ]
    }
  }
  const options = {
    result,
    domain: { name: 'rows', nextTasks: [] },
    taskIds,
    recordsForTask: (taskId: string) => structuredClone(records.get(taskId)!),
    snapshots: f.snapshots,
    owners: f.owners
  }
  return { ...f, result, selected, reflected, records, options }
}

describe('experiment Library fixed-version provenance', () => {
  it('binds raw lessons to the selected harness snapshot and immutable reflection version, even with identical task snapshots', async () => {
    const f = await setup()
    expect(f.selected[0]!.request.taskSnapshotRef).toEqual(f.selected[1]!.request.taskSnapshotRef)
    const summary = await prepareDomainSummary(f.options)
    expect(summary.library).toMatchObject({ scope: 'experiment', entries: f.options.taskIds })
    expect(summary.library.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    for (const [index, task] of summary.tasks.entries())
      expect(task.experience).toMatchObject({
        scope: 'experiment',
        reflectionExecutionId: f.reflected[index]!.executionId,
        reflectionArtifacts: f.reflected[index]!.evidence.artifacts,
        selectedExecutionId: f.selected[index]!.executionId,
        selectedHarnessRevisionRef: f.selected[index]!.request.harnessRevisionRef
      })
    expect(summary).not.toHaveProperty('published')
  })
  it('allows native assistant prefaces when the owner preserves the entire same committed reply', async () => {
    const f = await setup()
    for (const record of f.reflected) {
      const exported = f.outputs.get(record.executionId)!
      exported.replyText = `I checked the evidence before reflecting.\n${reflectionText}\nReflection complete.`
      exported.files[0]!.content = exported.replyText
      exported.files[0]!.digest =
        'sha256:' + createHash('sha256').update(exported.replyText).digest('hex')
    }
    await expect(prepareDomainSummary(f.options)).resolves.toHaveProperty('tasks.0.experience')
  })
  it('retains original reflection parsing of spaced keys and later duplicate fields', async () => {
    const f = await setup()
    const exported = f.outputs.get(f.reflected[0]!.executionId)!
    const text =
      '<experience>\ncue: superseded cue\nlesson: superseded lesson\nevidence: superseded evidence\n CUE : Row reconciliation\n Lesson : Verify all source rows\n Evidence : The adopted output reconciles all rows\n</experience>'
    exported.replyText = text
    exported.files[0]!.content = text
    exported.files[0]!.digest = 'sha256:' + createHash('sha256').update(text).digest('hex')
    await expect(prepareDomainSummary(f.options)).resolves.toHaveProperty('tasks.0.experience')
  })
  it('rejects a baseline or current-workspace harness substituted for the pinned selected harness', async () => {
    const f = await setup()
    f.result.library.files.find((file) =>
      file.path.endsWith('/experiment-0001/harness/instructions.md')
    )!.content = input.harness.instructions
    await expect(prepareDomainSummary(f.options)).rejects.toThrow(
      'selected execution configuration'
    )
  })
  it.each(['unknown', 'duplicate'])(
    'refuses %s Library entries instead of claiming provenance',
    async (fault) => {
      const f = await setup()
      f.result.library.entries =
        fault === 'unknown'
          ? ['another-experiment-task']
          : [f.options.taskIds[0]!, f.options.taskIds[0]!]
      await expect(prepareDomainSummary(f.options)).rejects.toThrow('provenance')
    }
  )
  it.each(['unknown-task', 'other-domain', 'other-mode', 'off-profile'])(
    'refuses unbound Library file inventory: %s',
    async (fault) => {
      const f = await setup()
      const path = {
        'unknown-task': 'seq/rows/harnesses/other-task/harness/instructions.md',
        'other-domain': 'seq/private-domain/INDEX.md',
        'other-mode': 'agg/rows/INDEX.md',
        'off-profile': 'seq/rows/harnesses/experiment-0001/harness/scripts/run.py'
      }[fault]!
      f.result.library.files.push({
        path,
        content: 'Unowned bytes must not be included in a Library digest.'
      })
      await expect(prepareDomainSummary(f.options)).rejects.toThrow('Library')
    }
  )
  it('refuses files belonging to a task that has no admitted Library entry', async () => {
    const f = await setup()
    f.result.library.entries = [f.options.taskIds[0]!]
    await expect(prepareDomainSummary(f.options)).rejects.toThrow('Library')
  })
  it('does not accept a fabricated lesson by finding its original text in an unrelated comment', async () => {
    const f = await setup()
    const experience = f.result.library.files.find((file) =>
      file.path.endsWith('/experiment-0001/EXPERIENCE.md')
    )!
    experience.content =
      experience.content.replace(
        '**lesson**: Verify all source rows',
        '**lesson**: Skip source checking'
      ) + '\n<!-- Original model text was: Verify all source rows -->\n'
    await expect(prepareDomainSummary(f.options)).rejects.toThrow('lesson')
  })
  it.each(['execution-list', 'reflection', 'chosen-artifact'])(
    'rejects cross-task %s ownership despite identical task snapshot refs',
    async (fault) => {
      const f = await setup()
      if (fault === 'execution-list')
        f.result.tasks[0]!.executionIds = [...f.result.tasks[1]!.executionIds]
      else if (fault === 'reflection')
        f.result.tasks[0]!.reflection = structuredClone(f.result.tasks[1]!.reflection)
      else f.result.tasks[0]!.chosenArtifacts = structuredClone(f.result.tasks[1]!.chosenArtifacts)
      await expect(prepareDomainSummary(f.options)).rejects.toThrow(
        fault === 'execution-list'
          ? 'ownership'
          : fault === 'reflection'
            ? 'Reflection'
            : 'Ambiguous'
      )
    }
  )
  it('rejects a changed reflection version advertised by the Python projection', async () => {
    const f = await setup()
    f.result.tasks[0]!.reflection!.artifacts = [
      { ...f.reflected[0]!.evidence.artifacts[0]!, versionId: 'current-workspace' }
    ]
    await expect(prepareDomainSummary(f.options)).rejects.toThrow('Reflection')
  })
  it.each(['checksum', 'artifact', 'execution', 'advertised-versions'])(
    'rejects tampered immutable reflection export: %s',
    async (fault) => {
      const f = await setup()
      const exported = f.outputs.get(f.reflected[0]!.executionId)!
      if (fault === 'checksum') exported.files[0]!.digest = 'sha256:' + '0'.repeat(64)
      if (fault === 'artifact')
        exported.files[0]!.artifactRef = f.selected[0]!.evidence.artifacts[0]!
      if (fault === 'execution') exported.executionId = f.reflected[1]!.executionId
      if (fault === 'advertised-versions') exported.artifacts = f.selected[0]!.evidence.artifacts
      await expect(prepareDomainSummary(f.options)).rejects.toThrow('Reflection')
    }
  )
  it('keeps NO_ENTRY as an empty experiment Library without fabricating experience provenance', async () => {
    const f = await setup()
    f.result.library = { files: [], entries: [] }
    const summary = await prepareDomainSummary(f.options)
    expect(summary.library.entries).toEqual([])
    expect(summary.tasks.every((task) => task.experience === undefined)).toBe(true)
    expect(f.exportResult).not.toHaveBeenCalled()
  })
  it('rejects a persisted experience block that differs from the original reply despite valid file checksums', async () => {
    const f = await setup()
    const file = f.outputs.get(f.reflected[0]!.executionId)!.files[0]!
    file.content = file.content.replace('Verify all source rows', 'Skip source checking')
    file.digest = 'sha256:' + createHash('sha256').update(file.content).digest('hex')
    await expect(prepareDomainSummary(f.options)).rejects.toThrow('Reflection')
  })
  it('rejects case-aliased duplicate Library files and a missing original index', async () => {
    const f = await setup()
    const file = f.result.library.files.find((entry) =>
      entry.path.endsWith('/experiment-0001/harness/instructions.md')
    )!
    f.result.library.files.push({
      ...file,
      path: file.path.replace('instructions.md', 'Instructions.md')
    })
    await expect(prepareDomainSummary(f.options)).rejects.toThrow('Library')
    f.result.library.files.pop()
    f.result.library.files = f.result.library.files.filter(
      (entry) => !entry.path.endsWith('/INDEX.md')
    )
    await expect(prepareDomainSummary(f.options)).rejects.toThrow('index')
  })
})
