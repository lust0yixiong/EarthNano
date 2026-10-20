import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { StartDesktopSweep } from '../../shared/earthnano/optimization-sweep'
import type { ResolvedOptimizationSweep, ResolvedSweepTask } from './sweep-contract'
import { previewOptimizationSweep } from './sweep-plan'
import { sweepTasks } from './sweep-input'

const python = execFileSync(
  process.env.EARTHNANO_RESEARCH_PYTHON ?? 'python3',
  ['-c', 'import sys; print(sys.executable)'],
  { encoding: 'utf8' }
).trim()
async function fixture(notebook = false): Promise<ResolvedOptimizationSweep> {
  const catalog: StartDesktopSweep['catalog'] = ['b', 'a'].map((taskId) => ({
    taskId,
    domain: taskId,
    sourceSessionId: `source-${taskId}`,
    source: notebook
      ? { kind: 'notebook', promptMessageId: `prompt-${taskId}` }
      : { kind: 'text', prompt: `Task ${taskId}`, files: [{ path: 'data.csv', content: taskId }] },
    criteria: `Verify source ${taskId}`
  }))
  const request: StartDesktopSweep = {
    projectId: 'project',
    sourceSessionId: 'navigation',
    requestKey: 'key',
    executionLimit: 40,
    catalog,
    sweep: {
      modes: ['parallel', 'sequential'],
      k: 1,
      concurrency: 2,
      stream: { seed: null, onlyDomains: [], onlyTasks: [], maxTasks: null, workers: 2 }
    }
  }
  const plan = await previewOptimizationSweep({
    catalog: catalog.map(({ taskId, domain }) => ({ taskId, domain })),
    options: request.sweep,
    python,
    harnessRoot: resolve('vendor/harness2')
  })
  const tasks: ResolvedSweepTask[] = catalog.map((task) => ({
    taskId: task.taskId,
    domain: task.domain,
    sourceSessionId: task.sourceSessionId,
    ...(task.source.kind === 'notebook'
      ? { sourcePromptMessageId: task.source.promptMessageId }
      : {}),
    criteria: task.criteria,
    input: {
      task:
        task.source.kind === 'text'
          ? { prompt: task.source.prompt, files: task.source.files }
          : {
              prompt: `Original ${task.taskId}`,
              files: [],
              managedInputs: [
                {
                  sourceKind: 'upload-version',
                  sourceProjectId: 'project',
                  sourceSessionId: `owner-${task.taskId}`,
                  sourceFileId: `file-${task.taskId}`,
                  inputFileVersionId: `version-${task.taskId}`,
                  filename: 'data.csv',
                  sizeBytes: 1,
                  checksum: 'a'.repeat(64)
                }
              ]
            },
      harness: {
        instructions: 'Use fixed inputs',
        skills: [],
        tools: notebook ? 'notebook-python' : 'workspace-only'
      },
      agent: {
        backend: 'claude-code',
        model: 'fixture',
        providerRef: 'fixture',
        runtimeVersion: '2.1.232'
      },
      environment: {
        isolation: 'directory-process',
        network: notebook ? 'provider-and-notebook-policy' : 'provider-only',
        ...(notebook
          ? {
              notebook: {
                runtime: {
                  language: 'python',
                  runtimeId: `runtime-${task.taskId}`,
                  interpreterPath: `/python/${task.taskId}`,
                  source: 'external',
                  provenance: 'user-own'
                }
              }
            }
          : {})
      }
    }
  }))
  return { plan, tasks, request }
}
describe('resolved sweep task/source identity', () => {
  it('orders independently resolved tasks by the original plan without inheriting primary input', async () => {
    const value = await fixture()
    const tasks = sweepTasks(value)
    expect(
      tasks.map((task) => [task.taskId, task.sourceSessionId, task.input.task.files[0]!.content])
    ).toEqual([
      ['a', 'source-a', 'a'],
      ['b', 'source-b', 'b']
    ])
    expect(value.tasks.map((task) => task.taskId)).toEqual(['b', 'a'])
  })
  it('retains distinct prompt Sessions, actual version owners and independently bound Notebook runtimes', async () => {
    const tasks = sweepTasks(await fixture(true))
    expect(
      tasks.map((task) => [
        task.sourceSessionId,
        task.sourcePromptMessageId,
        task.input.task.managedInputs![0]!.sourceSessionId,
        task.input.environment.notebook!.runtime.runtimeId
      ])
    ).toEqual([
      ['source-a', 'prompt-a', 'owner-a', 'runtime-a'],
      ['source-b', 'prompt-b', 'owner-b', 'runtime-b']
    ])
  })
  it.each(['source', 'criteria', 'prompt', 'bytes', 'agent', 'inventory'])(
    'rejects wrong per-task %s before any Core is constructed',
    async (change) => {
      const value = await fixture()
      const task = value.tasks[0]!
      if (change === 'source') task.sourceSessionId = 'navigation'
      if (change === 'criteria') task.criteria = value.tasks[1]!.criteria
      if (change === 'prompt')
        task.input = { ...task.input, task: { ...task.input.task, prompt: 'Other task' } }
      if (change === 'bytes')
        task.input = {
          ...task.input,
          task: { ...task.input.task, files: [{ path: 'data.csv', content: 'other' }] }
        }
      if (change === 'agent')
        task.input = { ...task.input, agent: { ...task.input.agent, model: 'different' } }
      if (change === 'inventory') value.tasks = [task, task]
      expect(() => sweepTasks(value)).toThrow()
    }
  )
  it('does not allow a Notebook task to acquire another prompt identity or alternate files', async () => {
    const value = await fixture(true)
    value.tasks[0]!.sourcePromptMessageId = 'prompt-a'
    expect(() => sweepTasks(value)).toThrow()
    value.tasks[0]!.sourcePromptMessageId = 'prompt-b'
    value.tasks[0]!.input = {
      ...value.tasks[0]!.input,
      task: { ...value.tasks[0]!.input.task, files: [{ path: 'extra.txt', content: 'extra' }] }
    }
    expect(() => sweepTasks(value)).toThrow()
  })
})
