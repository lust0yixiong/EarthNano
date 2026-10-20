import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createCandidateSnapshotStore, type CandidateSnapshotInput } from './candidate-snapshot'
import { emptyExecutionState, ExecutionCore } from './execution-core'
import {
  HarnessOptimizationBinding,
  runHarnessProcess,
  type PersistentExecutionExport
} from './harness-optimization'

it('carries four MiB of fixed outputs through the original Python method and TS ownership without truncating evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-large-evidence-'))
  const snapshots = await createCandidateSnapshotStore({
    root: join(root, 'snapshots'),
    candidatesRoot: join(root, 'candidates')
  })
  const input: CandidateSnapshotInput = {
    task: {
      prompt: 'Reconcile the source into four output files.',
      files: [{ path: 'source.csv', content: 'row,value\na,42\n' }]
    },
    harness: {
      instructions: 'Read and reconcile all source rows.',
      skills: [],
      tools: 'workspace-only'
    },
    agent: {
      backend: 'claude-code',
      model: 'deterministic',
      providerRef: 'offline',
      runtimeVersion: '2.1.232'
    },
    environment: { isolation: 'directory-process', network: 'provider-only' }
  }
  const fixed = new Map<string, PersistentExecutionExport>()
  const evidenceLengths: number[] = []
  let state = emptyExecutionState()
  const core = new ExecutionCore(
    {
      load: () => state,
      commit: (next) => {
        state = structuredClone(next)
      }
    },
    {
      execute: async (request, context) => {
        context.running()
        const proposed = request.role === 'proposer' || request.role === 'composer'
        const replyText = '<notes>Read and reconciled the fixed source rows.</notes>'
        const files = proposed
          ? [
              {
                path: 'context/harness/instructions.md',
                content: 'Read and verify every supplied source row before delivery.'
              }
            ]
          : Array.from({ length: 4 }, (_, index) => ({
              path: `part-${index + 1}.txt`,
              content: `${index + 1}:` + 'x'.repeat(1024 * 1024 - 2)
            }))
        const exported = files.map((file, index) => {
          const checksum = createHash('sha256').update(file.content).digest('hex')
          return {
            ...file,
            digest: `sha256:${checksum}`,
            artifactRef: {
              artifactId: `${context.executionId}-${index}`,
              versionId: 'v1',
              checksum
            }
          }
        })
        fixed.set(context.executionId, {
          executionId: context.executionId,
          artifacts: exported.map((file) => file.artifactRef),
          replyText,
          trajectoryText: 'Read source.csv and reconciled all rows.',
          files: exported
        })
        if (proposed)
          evidenceLengths.push((await snapshots.resolve(request)).invocation.mission.length)
        return {
          phase: 'completed',
          cleanup: 'confirmed',
          evidence: {
            status: 'complete',
            scope: 'fixed-version deterministic fixture',
            text: replyText,
            artifacts: exported.map((file) => file.artifactRef),
            references: [],
            limitations: []
          }
        }
      }
    }
  )
  core.configureBudget('project', 'budget', 7)
  const binding = new HarnessOptimizationBinding({
    core,
    snapshots,
    input,
    projectId: 'project',
    optimizationId: 'large-evidence',
    taskId: 'task',
    budgetRef: 'budget',
    timeoutMs: 10000,
    exportResult: async (record) => fixed.get(record.executionId)!
  })
  const config = join(root, 'config.json')
  await writeFile(
    config,
    JSON.stringify({
      configVersion: 1,
      taskId: 'task',
      task: input.task,
      baseHarnessFiles: [{ path: 'instructions.md', content: input.harness.instructions }],
      workRoot: join(root, 'method'),
      model: 'deterministic',
      method: { mode: 'sequential', k: 1, concurrency: 1 },
      executionTimeoutMs: 10000,
      rpcTimeoutMs: 12000
    })
  )
  try {
    const result = (await runHarnessProcess({
      binding,
      python: 'python3',
      args: ['-B', '-m', 'harness2.earthnano', '--config', config],
      cwd: resolve('vendor/harness2'),
      env: { PATH: process.env.PATH },
      timeoutMs: 30000
    })) as {
      status: string
      chosenArtifacts: unknown[]
      fallbackStages: string[]
      selection: { chosenLabel: string }
    }
    expect(result).toMatchObject({
      status: 'ok',
      selection: { chosenLabel: 'c1' },
      fallbackStages: []
    })
    expect(result.chosenArtifacts).toHaveLength(4)
    expect(Object.values(state.records)).toHaveLength(7)
    expect(Object.values(state.budgets)).toEqual([{ limit: 7, admitted: 7 }])
    expect(evidenceLengths).toHaveLength(3)
    expect(Math.min(...evidenceLengths)).toBeGreaterThan(4 * 1024 * 1024)
    expect(Math.max(...evidenceLengths)).toBeGreaterThan(12 * 1024 * 1024)
    const sourceContexts = Object.values(state.records).filter(
      (record) => record.request.role === 'proposer' || record.request.role === 'composer'
    )
    for (const record of sourceContexts) {
      const mission = (await snapshots.resolve(record.request)).invocation.mission
      expect(mission).toContain('row,value')
      expect(mission).not.toContain('deterministicChecks')
      expect(mission).not.toContain('semanticPass')
    }
  } finally {
    core.dispose()
    const unlock = async (directory: string): Promise<void> => {
      await chmod(directory, 0o700)
      for (const entry of await readdir(directory, { withFileTypes: true }))
        if (entry.isDirectory() && !entry.isSymbolicLink())
          await unlock(join(directory, entry.name))
    }
    await unlock(root)
    await rm(root, { recursive: true, force: true })
  }
}, 40000)
