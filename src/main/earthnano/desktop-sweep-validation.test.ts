import { describe, expect, it } from 'vitest'
import type { StartDesktopSweep } from '../../shared/earthnano/optimization-sweep'
import { normalizeDesktopSweep } from './desktop-sweep-validation'

export const sweepRequest = (): StartDesktopSweep => ({
  projectId: 'p',
  sourceSessionId: 'navigation',
  requestKey: 'once',
  executionLimit: 32,
  catalog: [
    {
      taskId: 'first',
      domain: 'csv',
      sourceSessionId: 'source-a',
      source: { kind: 'notebook', promptMessageId: 'prompt-a' },
      criteria: 'Verify the original values.'
    },
    {
      taskId: 'next',
      domain: 'csv',
      sourceSessionId: 'source-b',
      source: {
        kind: 'text',
        prompt: 'Count these values',
        files: [{ path: 'values.csv', content: 'value\n2' }]
      },
      criteria: 'Verify the count.'
    }
  ],
  sweep: {
    modes: ['parallel', 'sequential'],
    k: 1,
    concurrency: 2,
    stream: { seed: 0, onlyDomains: [], onlyTasks: [], maxTasks: null, workers: 1 }
  }
})

describe('desktop catalog source boundary', () => {
  it('retains a reviewed original plan digest while preserving older v2 requests', () => {
    expect(
      normalizeDesktopSweep({ ...sweepRequest(), previewPlanDigest: 'sha256:' + 'a'.repeat(64) })
    ).toHaveProperty('previewPlanDigest', 'sha256:' + 'a'.repeat(64))
    expect(normalizeDesktopSweep(sweepRequest())).not.toHaveProperty('previewPlanDigest')
    for (const digest of [undefined, '', 'a'.repeat(63), 'A'.repeat(64), 'a'.repeat(64), '../plan'])
      expect(() =>
        normalizeDesktopSweep({ ...sweepRequest(), previewPlanDigest: digest })
      ).toThrow()
  })
  it('preserves independent source selections and explicit original stream options in a detached DTO', () => {
    const request = sweepRequest(),
      parsed = normalizeDesktopSweep(request)
    expect(parsed).toEqual(request)
    request.catalog[0].sourceSessionId = 'replaced'
    expect(parsed.catalog[0].sourceSessionId).toBe('source-a')
    expect(parsed.catalog[1].source).not.toHaveProperty('promptMessageId')
  })
  it('validates the complete catalog even when original filtering excludes a malformed source', () => {
    const request = sweepRequest()
    request.sweep.stream.onlyTasks = ['first']
    request.catalog[1].source = {
      kind: 'text',
      prompt: 'Excluded',
      files: [{ path: '../secret', content: 'x' }]
    }
    expect(() => normalizeDesktopSweep(request)).toThrow()
  })
  it.each([
    { kind: 'compute', promptMessageId: 'prompt-a', language: 'python' },
    { kind: 'compute', promptMessageId: 'prompt-a', hosts: [] },
    { kind: 'compute', promptMessageId: 'prompt-a', files: [] },
    { kind: 'compute', promptMessageId: 'prompt-a', prompt: 'Replacement prompt' },
    { kind: 'notebook', promptMessageId: 'prompt-a', runtime: '/host/python' },
    { kind: 'notebook', promptMessageId: 'prompt-a', prompt: 'Replacement prompt' },
    { kind: 'notebook', promptMessageId: 'prompt-a', files: [] },
    { kind: 'text', prompt: 'Count', files: [], provider: { key: 'synthetic-secret' } },
    { kind: 'text', prompt: 'Count', files: [{ path: '/host/file', content: 'x' }] },
    {
      kind: 'text',
      prompt: 'Count',
      files: [
        { path: 'folder', content: 'x' },
        { path: 'folder/input.csv', content: 'y' }
      ]
    }
  ])('rejects renderer authority or ambiguous paths: %j', (source) => {
    const request = sweepRequest()
    request.catalog[0].source = source as StartDesktopSweep['catalog'][number]['source']
    expect(() => normalizeDesktopSweep(request)).toThrow()
  })
  it('checks criteria, all source Sessions, checks, duplicate task identities and global limits', () => {
    const bad: unknown[] = [
      { ...sweepRequest(), executionLimit: 513 },
      { ...sweepRequest(), executionLimit: 0 },
      { ...sweepRequest(), runtime: '/host/python' },
      { ...sweepRequest(), catalog: sweepRequest().catalog.map((t) => ({ ...t, taskId: 'same' })) },
      { ...sweepRequest(), catalog: [{ ...sweepRequest().catalog[0], criteria: '' }] },
      {
        ...sweepRequest(),
        catalog: [{ ...sweepRequest().catalog[0], sourceSessionId: '../foreign' }]
      },
      {
        ...sweepRequest(),
        catalog: [
          { ...sweepRequest().catalog[0], checks: [{ kind: 'file-exists', path: '../outside' }] }
        ]
      }
    ]
    for (const value of bad) expect(() => normalizeDesktopSweep(value)).toThrow()
  })
})

it('keeps Compute source identity distinct from data language and renderer host authority', () => {
  const request = sweepRequest()
  request.catalog[0].source = { kind: 'compute', promptMessageId: 'prompt-a' }
  const parsed = normalizeDesktopSweep(request)
  expect(parsed.catalog[0].source).toEqual(request.catalog[0].source)
  expect(parsed.catalog[0].source).not.toHaveProperty('language')
  request.catalog[0].source = { kind: 'compute', promptMessageId: '../other' }
  expect(() => normalizeDesktopSweep(request)).toThrow()
})

it('retains an explicit R source but never adds language to legacy requests or text sources', () => {
  const request = sweepRequest()
  const old = JSON.stringify(normalizeDesktopSweep(request))
  expect(normalizeDesktopSweep(request).catalog[0].source).not.toHaveProperty('language')
  request.catalog[0].source = { kind: 'notebook', promptMessageId: 'prompt-a', language: 'r' }
  expect(normalizeDesktopSweep(request).catalog[0].source).toEqual(request.catalog[0].source)
  for (const language of [undefined, null, 'R', 'julia']) {
    request.catalog[0].source = { kind: 'notebook', promptMessageId: 'prompt-a', language } as never
    expect(() => normalizeDesktopSweep(request)).toThrow()
  }
  const text = sweepRequest()
  text.catalog[1].source = { ...text.catalog[1].source, language: 'r' } as never
  expect(() => normalizeDesktopSweep(text)).toThrow()
  expect(JSON.stringify(normalizeDesktopSweep(sweepRequest()))).toBe(old)
})
