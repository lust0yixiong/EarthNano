import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { checkOutputFiles } from './output-checks'
const file = (content: string) => ({
  path: 'result.json',
  content,
  digest: 'sha256:' + createHash('sha256').update(content).digest('hex'),
  artifactRef: { artifactId: 'a', versionId: 'v1', checksum: 'c' }
})
it('checks frozen JSON pointers and numeric tolerance with exact version evidence', () => {
  const results = checkOutputFiles(
    [file('{"sum":6,"a/b":{"~x":2.01}}')],
    [
      { kind: 'json-value', path: 'result.json', pointer: '/sum', expected: 6 },
      {
        kind: 'json-value',
        path: 'result.json',
        pointer: '/a~1b/~0x',
        expected: 2,
        tolerance: 0.02
      }
    ]
  )
  expect(results.every((result) => result.status === 'pass')).toBe(true)
  expect(results[0]!.artifactRef?.versionId).toBe('v1')
})
it.each([
  { files: [], reason: 'missing-file' },
  { files: [file('not-json')], reason: 'invalid-json' },
  { files: [file('{}')], reason: 'missing-value' },
  { files: [file('{"sum":7}')], reason: 'mismatch' }
])('rejects $reason instead of inferring correctness from a model score', ({ files, reason }) =>
  expect(
    checkOutputFiles(files, [
      { kind: 'json-value', path: 'result.json', pointer: '/sum', expected: 6 }
    ])[0]
  ).toMatchObject({ status: 'fail', reason })
)
it('compares object keys canonically and refuses unowned prototype traversal', () => {
  expect(
    checkOutputFiles(
      [file('{"b":2,"a":1}')],
      [{ kind: 'json-value', path: 'result.json', pointer: '', expected: { a: 1, b: 2 } }]
    )[0]!.status
  ).toBe('pass')
  expect(
    checkOutputFiles(
      [file('{}')],
      [{ kind: 'json-value', path: 'result.json', pointer: '/constructor', expected: {} }]
    )[0]!.reason
  ).toBe('missing-value')
})
it('rejects changed bytes or ambiguous output versions', () => {
  const changed = { ...file('{"sum":6}'), content: '{"sum":7}' }
  const check = { kind: 'json-value' as const, path: 'result.json', pointer: '/sum', expected: 6 }
  expect(() => checkOutputFiles([changed], [check])).toThrow('checksum')
  expect(() => checkOutputFiles([file('{}'), file('{}')], [check])).toThrow('Ambiguous')
})
