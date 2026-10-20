import { describe, expect, it } from 'vitest'
import {
  minimumSweepExecutions,
  normalizeOptimizationCatalog,
  normalizeOptimizationSweep
} from './optimization-sweep'

const options = () => ({
  modes: ['sequential', 'parallel'],
  k: 2,
  concurrency: 4,
  stream: { seed: 0, onlyDomains: [], onlyTasks: [], maxTasks: null, workers: 2 }
})
describe('shared original sweep contract', () => {
  it('preserves explicit zero/negative seeds and canonicalizes original mode order', () => {
    expect(normalizeOptimizationSweep(options())).toMatchObject({
      modes: ['parallel', 'sequential'],
      stream: { seed: 0 }
    })
    expect(
      normalizeOptimizationSweep({ ...options(), stream: { ...options().stream, seed: -7 } }).stream
        .seed
    ).toBe(-7)
  })
  it('budgets shared bases once, reflection per mode and one independent baseline assessment per task', () => {
    expect(minimumSweepExecutions(normalizeOptimizationSweep(options()), 4)).toBe(132)
    expect(minimumSweepExecutions(normalizeOptimizationSweep(options()), 4, false)).toBe(120)
    expect(
      minimumSweepExecutions(
        normalizeOptimizationSweep({ ...options(), k: 1, modes: ['sequential'] }),
        1
      )
    ).toBe(10)
  })
  it('leaves order decisions to original task_stream and returns detached identities', () => {
    const catalog = [
      { taskId: 'z', domain: 'B' },
      { taskId: 'a', domain: 'A' }
    ]
    const normalized = normalizeOptimizationCatalog(catalog)
    expect(normalized).toEqual(catalog)
    catalog[0]!.domain = 'changed'
    expect(normalized[0]!.domain).toBe('B')
  })
  it.each([
    { ...options(), modes: [] },
    { ...options(), modes: ['parallel', 'parallel'] },
    { ...options(), modes: ['agg'] },
    { ...options(), k: 0 },
    { ...options(), concurrency: 5 },
    { ...options(), extra: true },
    { ...options(), stream: { ...options().stream, seed: '0' } },
    { ...options(), stream: { ...options().stream, workers: 0 } },
    { ...options(), stream: { ...options().stream, maxTasks: 0 } },
    { ...options(), stream: { ...options().stream, onlyTasks: ['a', 'a'] } }
  ])('rejects ambiguous transport before execution: %j', (value) => {
    expect(() => normalizeOptimizationSweep(value)).toThrow()
  })
  it.each(
    [
      [],
      [{ taskId: '../a', domain: 'a' }],
      [{ taskId: 'a', domain: 'CON' }],
      [
        { taskId: 'A', domain: 'x' },
        { taskId: 'a', domain: 'x' }
      ],
      [
        { taskId: 'a', domain: 'A' },
        { taskId: 'b', domain: 'a' }
      ],
      [{ taskId: 'a', domain: 'x', runtime: '/foreign/python' }]
    ].map((value) => ({ value }))
  )('rejects invalid or cross-platform colliding task identities: %j', ({ value }) => {
    expect(() => normalizeOptimizationCatalog(value)).toThrow()
  })
})
