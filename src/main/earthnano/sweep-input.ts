import { notebookLanguageForTools } from '../../shared/earthnano/notebook-profile'
import { normalizeFrozenManagedInputs } from '../../shared/earthnano/notebook-profile'
import { normalizeFrozenComputeContext } from '../../shared/earthnano/compute-profile'
import { createHash } from 'node:crypto'
import {
  normalizeOptimizationCatalog,
  normalizeOptimizationSweep
} from '../../shared/earthnano/optimization-sweep'
import { normalizeOptimizationArtifactInputs } from '../../shared/earthnano/optimization-input'
import { normalizeOutputChecks } from '../../shared/earthnano/research-outcome'
import type { ResolvedOptimizationSweep, ResolvedSweepTask } from './sweep-contract'
import { assertHarnessBindingV2Identity } from './harness-binding-v2'
import { canonicalOutput } from './output-checks'
import { semanticCriteria } from './semantic-evaluation'

/** Validate host-owned task inventory before any Core admission; source authorization remains
 * with the original Session/version/runtime owners in the composition. */
export function sweepTasks(value: ResolvedOptimizationSweep): ResolvedSweepTask[] {
  const sweep = structuredClone(value)
  const plan = sweep.plan
  const catalog = normalizeOptimizationCatalog(plan.catalog)
  normalizeOptimizationSweep(plan.options)
  assertHarnessBindingV2Identity(plan.bindingIdentity, plan.bindingIdentity)
  if (
    !Array.isArray(plan.domains) ||
    !plan.domains.length ||
    new Set(plan.domains.map((row) => row.domain)).size !== plan.domains.length ||
    canonicalOutput(catalog) !==
      canonicalOutput(sweep.request.catalog.map(({ taskId, domain }) => ({ taskId, domain }))) ||
    canonicalOutput(plan.options) !==
      canonicalOutput(normalizeOptimizationSweep(sweep.request.sweep))
  )
    throw new Error('Sweep catalog/plan identity changed')
  const selected = plan.domains.flatMap(({ domain, taskIds }) =>
    taskIds.map((taskId) => ({ taskId, domain }))
  )
  if (
    !selected.length ||
    new Set(selected.map((task) => task.taskId)).size !== selected.length ||
    selected.some(
      (task) => !catalog.some((item) => item.taskId === task.taskId && item.domain === task.domain)
    ) ||
    !Array.isArray(sweep.tasks) ||
    sweep.tasks.length !== selected.length
  )
    throw new Error('Sweep selected task inventory changed')
  const tasks = selected.map((identity) => {
    const matches = sweep.tasks.filter(
      (task) => task.taskId === identity.taskId && task.domain === identity.domain
    )
    const source = sweep.request.catalog.find((task) => task.taskId === identity.taskId)!
    if (matches.length !== 1) throw new Error('Sweep task payload ownership changed')
    const task = matches[0]!
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(task.sourceSessionId) ||
      task.sourceSessionId !== source.sourceSessionId ||
      task.criteria !== source.criteria ||
      canonicalOutput(normalizeOutputChecks(task.checks)) !==
        canonicalOutput(normalizeOutputChecks(source.checks))
    )
      throw new Error('Sweep per-task source/assessment identity changed')
    semanticCriteria(task.criteria)
    task.checks = normalizeOutputChecks(task.checks)
    task.inputArtifacts = normalizeOptimizationArtifactInputs(task.inputArtifacts)
    if (source.source.kind === 'compute') {
      const compute = normalizeFrozenComputeContext(task.input.environment.compute)
      normalizeFrozenManagedInputs(task.input.task.managedInputs)
      if (
        task.sourcePromptMessageId !== source.source.promptMessageId ||
        task.input.harness.tools !== 'notebook-compute' ||
        task.input.environment.notebook !== undefined ||
        task.input.environment.network !== 'provider-and-notebook-policy' ||
        compute.sourceProjectId !== sweep.request.projectId ||
        compute.sourceSessionId !== task.sourceSessionId ||
        task.input.task.files.length ||
        task.inputArtifacts?.length
      )
        throw new Error('Sweep Compute source requires its own original fixed task and hosts')
    } else if (source.source.kind === 'notebook') {
      if (
        task.sourcePromptMessageId !== source.source.promptMessageId ||
        notebookLanguageForTools(task.input.harness.tools) !==
          (source.source.language ?? 'python') ||
        !task.input.task.managedInputs?.length ||
        !task.input.environment.notebook ||
        task.input.environment.compute !== undefined ||
        task.input.environment.notebook.runtime.language !== (source.source.language ?? 'python') ||
        task.input.task.files.length ||
        task.inputArtifacts?.length
      )
        throw new Error('Sweep Notebook source requires its own original fixed task and runtime')
    } else if (
      task.sourcePromptMessageId !== undefined ||
      task.input.harness.tools !== 'workspace-only' ||
      task.input.task.managedInputs !== undefined ||
      task.input.environment.notebook !== undefined ||
      task.input.environment.compute !== undefined ||
      task.input.task.prompt !== source.source.prompt ||
      canonicalOutput(task.inputArtifacts) !==
        canonicalOutput(normalizeOptimizationArtifactInputs(source.source.inputArtifacts))
    )
      throw new Error('Sweep text task cannot acquire Notebook authority')
    if (source.source.kind === 'text') {
      const versionPaths = new Set(task.inputArtifacts?.map((ref) => ref.path) ?? [])
      const order = (files: readonly { path: string; content: string }[]): unknown =>
        [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      if (
        task.input.task.files.length !== source.source.files.length + versionPaths.size ||
        canonicalOutput(
          order(task.input.task.files.filter((file) => !versionPaths.has(file.path)))
        ) !== canonicalOutput(order(source.source.files))
      )
        throw new Error('Sweep text input differs from its own requested source')
    }
    for (const ref of task.inputArtifacts ?? []) {
      const file = task.input.task.files.find((file) => file.path === ref.path)
      if (!file || createHash('sha256').update(file.content, 'utf8').digest('hex') !== ref.checksum)
        throw new Error('Sweep frozen input differs from its own source version')
    }
    return task
  })
  const common = (task: ResolvedSweepTask): unknown => ({
    agent: task.input.agent,
    instructions: task.input.harness.instructions,
    skills: task.input.harness.skills
  })
  if (tasks.some((task) => canonicalOutput(common(task)) !== canonicalOutput(common(tasks[0]!))))
    throw new Error('Original sweep requires a common initial agent and harness')
  return tasks
}
