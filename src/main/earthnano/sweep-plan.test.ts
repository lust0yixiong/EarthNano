import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OptimizationSweepOptions } from '../../shared/earthnano/optimization-sweep'
import { previewOptimizationSweep } from './sweep-plan'
import { outputDigest } from './output-checks'

const python = execFileSync(
  process.env.EARTHNANO_RESEARCH_PYTHON ?? 'python3',
  ['-c', 'import sys; print(sys.executable)'],
  { encoding: 'utf8' }
).trim()
const harnessRoot = resolve('vendor/harness2')
const catalog = [
  { taskId: 'z2', domain: 'z' },
  { taskId: 'a2', domain: 'a' },
  { taskId: 'z1', domain: 'z' },
  { taskId: 'a1', domain: 'a' }
]
const options: OptimizationSweepOptions = {
  modes: ['parallel', 'sequential'],
  k: 2,
  concurrency: 2,
  stream: { seed: null, onlyDomains: [], onlyTasks: [], maxTasks: null, workers: 2 }
}
describe('original sweep preview', () => {
  it('runs original reference ordering and freezes complete catalog, method and v2 binding identities', async () => {
    const plan = await previewOptimizationSweep({ catalog, options, python, harnessRoot })
    expect(plan.domains).toEqual([
      { domain: 'a', taskIds: ['a1', 'a2'] },
      { domain: 'z', taskIds: ['z1', 'z2'] }
    ])
    expect(plan.catalog).toEqual(catalog)
    expect(plan.catalogDigest).toBe(outputDigest(catalog))
    const { digest, ...body } = plan
    expect(digest).toBe(outputDigest(body))
    expect(plan.methodDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(plan.bindingIdentity.modeScopes).toEqual({
      agg: 'earthnano-claude-text-agg2',
      seq: 'earthnano-claude-text-seq2'
    })
    expect(Object.isFrozen(plan.options.stream)).toBe(true)
    expect(Object.isFrozen(plan.domains[0].taskIds)).toBe(true)
  })
  it.each([0, -7])(
    'uses exact original seeded stream, filters and per-domain cap for seed %s',
    async (seed) => {
      const configured = { ...options, stream: { ...options.stream, seed, maxTasks: 1 } }
      const plan = await previewOptimizationSweep({
        catalog,
        options: configured,
        python,
        harnessRoot
      })
      const original = JSON.parse(
        execFileSync(
          python,
          [
            '-B',
            '-c',
            `import json; from harness2.earthnano_sweep import IdentityCatalog; from harness2.core.schedule import task_stream; c=json.loads(${JSON.stringify(JSON.stringify(catalog))}); print(json.dumps(task_stream(IdentityCatalog(c),seed=${seed},max_tasks=1)))`
          ],
          {
            cwd: harnessRoot,
            env: { PATH: process.env.PATH, PYTHONPATH: harnessRoot, PYTHONDONTWRITEBYTECODE: '1' },
            encoding: 'utf8'
          }
        )
      )
      expect(plan.domains).toEqual(
        Object.entries(original).map(([domain, taskIds]) => ({ domain, taskIds }))
      )
      expect(plan.domains).toHaveLength(2)
      expect(plan.bindingIdentity.baseScope).toBe(`earthnano-claude-text-agg2-s${seed}`)
      expect(plan.options.stream.workers).toBe(2)
    }
  )
  it('keeps unselected catalog identities while applying original task/domain filters', async () => {
    const plan = await previewOptimizationSweep({
      catalog,
      options: { ...options, stream: { ...options.stream, onlyDomains: ['z'], onlyTasks: ['z2'] } },
      python,
      harnessRoot
    })
    expect(plan.domains).toEqual([{ domain: 'z', taskIds: ['z2'] }])
    expect(plan.catalog).toEqual(catalog)
    expect(plan.catalogDigest).toBe(outputDigest(catalog))
    await expect(
      previewOptimizationSweep({
        catalog,
        options: {
          ...options,
          stream: { ...options.stream, onlyDomains: ['z'], onlyTasks: ['a1'] }
        },
        python,
        harnessRoot
      })
    ).rejects.toMatchObject({ category: 'original-rejected' })
  })
  it('includes workers, canonical mode selection and full catalog order in plan identity', async () => {
    const a = await previewOptimizationSweep({ catalog, options, python, harnessRoot })
    const b = await previewOptimizationSweep({
      catalog: [...catalog].reverse(),
      options,
      python,
      harnessRoot
    })
    const c = await previewOptimizationSweep({
      catalog,
      options: {
        ...options,
        modes: ['sequential', 'parallel'],
        stream: { ...options.stream, workers: 1 }
      },
      python,
      harnessRoot
    })
    expect(b.domains).toEqual(a.domains)
    expect(b.catalogDigest).not.toBe(a.catalogDigest)
    expect(c.options.modes).toEqual(['parallel', 'sequential'])
    expect(c.digest).not.toBe(a.digest)
  })
  it('rejects task bodies, credentials, malformed controls and relative runtime paths without admission', async () => {
    for (const item of [
      { ...catalog[0], task: { prompt: 'SECRET' } },
      { ...catalog[0], providerKey: 'SECRET' }
    ]) {
      await expect(
        previewOptimizationSweep({ catalog: [item], options, python, harnessRoot })
      ).rejects.toMatchObject({ category: 'invalid-input' })
    }
    await expect(
      previewOptimizationSweep({ catalog, options, python: 'python3', harnessRoot })
    ).rejects.toMatchObject({ category: 'invalid-input' })
    await expect(
      previewOptimizationSweep({
        catalog,
        options: { ...options, stream: { ...options.stream, workers: 5 } },
        python,
        harnessRoot
      })
    ).rejects.toMatchObject({ category: 'invalid-input' })
  })
  it('fails cancellation and unavailable runtime with fixed categories and no provider text', async () => {
    const aborted = new AbortController()
    aborted.abort(new Error('SECRET'))
    await expect(
      previewOptimizationSweep({ catalog, options, python, harnessRoot, signal: aborted.signal })
    ).rejects.toMatchObject({ category: 'cancelled' })
    await expect(
      previewOptimizationSweep({
        catalog,
        options,
        python: resolve('/does-not-exist/python'),
        harnessRoot
      })
    ).rejects.toMatchObject({ category: 'method-unavailable' })
  })
})
