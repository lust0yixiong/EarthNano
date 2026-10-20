import { describe, expect, it } from 'vitest'
import { minimumOptimizationExecutions, normalizeOptimizationMethod } from './optimization-method'

describe('optimization method compatibility', () => {
  it('keeps omitted method options isolated and compatible with the existing desktop flow', () => {
    const first = normalizeOptimizationMethod(undefined)
    first.k = 2
    expect(normalizeOptimizationMethod(undefined)).toEqual({
      mode: 'sequential',
      k: 1,
      concurrency: 1
    })
  })

  it.each(['sequential', 'parallel'] as const)(
    'reserves first-attempt admissions for the upstream %s method and independent reviews',
    (mode) => {
      expect(minimumOptimizationExecutions({ mode, k: 1, concurrency: 1 })).toBe(9)
      expect(minimumOptimizationExecutions({ mode, k: 2, concurrency: 2 })).toBe(17)
      expect(minimumOptimizationExecutions({ mode, k: 2, concurrency: 2 }, false)).toBe(15)
    }
  )

  it.each([
    null,
    {},
    { mode: 'agg', k: 2, concurrency: 2 },
    { mode: 'sequential', k: '2', concurrency: 2 },
    { mode: 'sequential', k: 1.5, concurrency: 2 },
    { mode: 'sequential', k: 0, concurrency: 2 },
    { mode: 'parallel', k: 9, concurrency: 2 },
    { mode: 'parallel', k: 2, concurrency: 0 },
    { mode: 'parallel', k: 2, concurrency: 5 },
    { mode: 'parallel', k: 2, concurrency: 2, unexpected: true }
  ])('rejects invalid or ambiguous options before execution: %j', (value) => {
    expect(() => normalizeOptimizationMethod(value)).toThrow('Invalid optimization method')
  })
})
