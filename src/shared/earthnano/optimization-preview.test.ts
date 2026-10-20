import { describe, expect, it } from 'vitest'
import { normalizeDesktopSweepPreview } from './optimization-sweep'

const request = () => ({
  projectId: 'project',
  sourceSessionId: 'source',
  catalog: [
    { taskId: 'task-a', domain: 'earth' },
    { taskId: 'task-b', domain: 'earth' },
    { taskId: 'task-c', domain: 'water' }
  ],
  sweep: {
    modes: ['sequential', 'parallel'],
    k: 2,
    concurrency: 2,
    stream: { seed: 0, onlyDomains: [], onlyTasks: [], maxTasks: 1, workers: 2 }
  }
})

describe('read-only desktop sweep preview contract', () => {
  it('normalizes options while leaving original stream selection and order to Python', () => {
    const input = request()
    const result = normalizeDesktopSweepPreview(input)
    expect(result.sweep.modes).toEqual(['parallel', 'sequential'])
    expect(result.sweep.stream.seed).toBe(0)
    expect(result.catalog).toEqual(input.catalog)
    expect(result.catalog).not.toBe(input.catalog)
  })
  it.each(['prompt', 'files', 'source', 'criteria', 'checks', 'key', 'python', 'executionLimit'])(
    'rejects non-identity field %s before planner invocation',
    (field) => {
      expect(() => normalizeDesktopSweepPreview({ ...request(), [field]: 'forbidden' })).toThrow()
    }
  )
  it('rejects source payloads even when attached to unselected identities', () => {
    const input = request()
    expect(() =>
      normalizeDesktopSweepPreview({
        ...input,
        catalog: [...input.catalog, { taskId: 'other', domain: 'other', prompt: 'source bytes' }]
      })
    ).toThrow()
  })
  it.each(['../project', '', 'x'.repeat(129)])('rejects invalid navigation identity %s', (id) => {
    expect(() => normalizeDesktopSweepPreview({ ...request(), sourceSessionId: id })).toThrow()
  })
})
