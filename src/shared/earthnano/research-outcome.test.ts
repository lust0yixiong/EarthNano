import { expect, it } from 'vitest'
import {
  normalizeOutputChecks,
  normalizeOptimizationDomain,
  minimumResearchExecutions
} from './research-outcome'
const spec = { kind: 'json-value', path: 'result.json', pointer: '/sum', expected: 6 }
it('keeps omitted fields compatible and charges reflection only for explicit domains', () => {
  expect(normalizeOutputChecks(undefined)).toBeUndefined()
  expect(normalizeOptimizationDomain(undefined)).toBeUndefined()
  expect(minimumResearchExecutions({ mode: 'sequential', k: 1, concurrency: 1 })).toBe(9)
  expect(
    minimumResearchExecutions(
      { mode: 'parallel', k: 1, concurrency: 2 },
      { name: 'geo', nextTasks: [] }
    )
  ).toBe(10)
  expect(
    minimumResearchExecutions(
      { mode: 'parallel', k: 2, concurrency: 2 },
      { name: 'geo', nextTasks: [{ prompt: 'Next', files: [], criteria: 'Check' }] }
    )
  ).toBe(36)
})
it('deep-freezes copied expected JSON values and domain inputs', () => {
  const input = { ...spec, pointer: '', expected: { sum: 6 } }
  const checks = normalizeOutputChecks([input])!
  input.expected.sum = 0
  expect(checks[0]!.expected).toEqual({ sum: 6 })
  const domain = {
    name: 'geo',
    nextTasks: [
      { prompt: 'Next', files: [{ path: 'data.csv', content: 'a' }], criteria: 'Check', checks }
    ]
  }
  const snapshot = normalizeOptimizationDomain(domain)!
  domain.nextTasks[0]!.files[0]!.content = 'changed'
  expect(snapshot.nextTasks[0]!.files[0]!.content).toBe('a')
})
it.each([
  null,
  {},
  [{ ...spec, extra: true }],
  [{ ...spec, path: '../x' }],
  [{ ...spec, pointer: '/a~2' }],
  [{ ...spec, expected: Infinity }],
  [{ ...spec, tolerance: -1 }],
  [{ ...spec, expected: '6', tolerance: 1 }],
  Array(17).fill(spec)
])('rejects unsupported output checks %j', (value) =>
  expect(() => normalizeOutputChecks(value)).toThrow()
)
it.each([
  { name: '../outside', nextTasks: [] },
  { name: 'rows.', nextTasks: [] },
  { name: 'geo', nextTasks: Array(4).fill({ prompt: 'Next', files: [], criteria: 'Check' }) },
  {
    name: 'geo',
    nextTasks: [{ prompt: 'Next', criteria: 'Check', files: [{ path: '../x', content: 'x' }] }]
  },
  {
    name: 'geo',
    nextTasks: [
      { prompt: 'Next', criteria: 'Check', files: [{ path: 'x', content: '中'.repeat(22000) }] }
    ]
  },
  {
    name: 'geo',
    nextTasks: [
      {
        prompt: 'Next',
        criteria: 'Check',
        files: [
          { path: 'A', content: '' },
          { path: 'a', content: '' }
        ]
      }
    ]
  }
])('rejects unsafe or oversized stream inputs before runtime %j', (value) =>
  expect(() => normalizeOptimizationDomain(value)).toThrow()
)
