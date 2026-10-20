import { describe, expect, it } from 'vitest'
import {
  normalizeFrozenNotebookInputs,
  normalizeFrozenNotebookRuntime,
  type FrozenNotebookInput,
  type FrozenNotebookRuntime
} from './notebook-profile'

const input = (): FrozenNotebookInput => ({
  sourceKind: 'upload-version',
  sourceProjectId: 'project',
  sourceSessionId: 'source-session',
  sourceFileId: 'upload',
  inputFileVersionId: 'old-version',
  filename: 'values.csv',
  sizeBytes: 12,
  checksum: 'a'.repeat(64)
})
const runtime = (): FrozenNotebookRuntime => ({
  language: 'python',
  runtimeId: '/original/python',
  interpreterPath: '/original/python',
  source: 'external',
  provenance: 'user-own',
  version: '3.12'
})

describe('host-frozen Notebook metadata', () => {
  it('returns detached exact metadata and preserves declared input order', () => {
    const original = input()
    const second = {
      ...original,
      sourceKind: 'artifact-version',
      inputFileVersionId: 'artifact-version'
    }
    expect(normalizeFrozenNotebookInputs([original, second])).toEqual([original, second])
    expect(normalizeFrozenNotebookInputs([original])[0]).not.toBe(original)
    expect(normalizeFrozenNotebookRuntime(runtime())).toEqual(runtime())
  })
  it.each([
    { checksum: 'sha256:' + 'a'.repeat(64) },
    { checksum: 'A'.repeat(64) },
    { sizeBytes: -1 },
    { sizeBytes: 1.5 },
    { sizeBytes: Infinity },
    { inputFileVersionId: '' },
    { sourceSessionId: '\u0000' },
    { sourceKind: 'latest' },
    { filename: '../values.csv' },
    { filename: '/host/values.csv' },
    { filename: 'C:\\values.csv' },
    { filename: '\ud800.csv' },
    { storageKey: '/host/source' },
    { key: 'secret' }
  ])('rejects unsupported or malformed input metadata %j', (change) => {
    expect(() => normalizeFrozenNotebookInputs([{ ...input(), ...change }])).toThrow()
  })
  it('rejects empty, excessive, duplicated and mixed-Project references', () => {
    for (const value of [
      undefined,
      [],
      Array(11).fill(input()),
      [input(), input()],
      [input(), { ...input(), inputFileVersionId: 'other', sourceProjectId: 'other-project' }]
    ])
      expect(() => normalizeFrozenNotebookInputs(value)).toThrow()
  })
  it.each([
    { language: 'r' },
    { source: 'remote' },
    { provenance: 'unknown' },
    { source: 'managed' },
    { interpreterPath: 'python' },
    { runtimeId: 'latest' },
    { version: undefined },
    { runnable: true },
    { key: 'secret' },
    { runtimeId: '/python\nother' }
  ])('rejects unsupported or malformed runtime metadata %j', (change) => {
    expect(() => normalizeFrozenNotebookRuntime({ ...runtime(), ...change })).toThrow()
  })
  it('accepts the original app-owned and agent-created managed provenance', () => {
    for (const provenance of ['app-managed', 'agent-created'])
      expect(
        normalizeFrozenNotebookRuntime({ ...runtime(), source: 'managed', provenance }).source
      ).toBe('managed')
  })
})
