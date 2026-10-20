import { createHash } from 'node:crypto'
import {
  normalizeOutputChecks,
  type OutputCheckSpec,
  type OutputCheckResult
} from '../../shared/earthnano/research-outcome'
import type { PersistentCandidateFile } from './persistent-candidate-owner'

export const canonicalOutput = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalOutput).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalOutput(v)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
export const outputDigest = (value: unknown): string =>
  'sha256:' + createHash('sha256').update(canonicalOutput(value)).digest('hex')

/** Checks supplied expectations on pinned bytes; never runs model-generated code. */
export function checkOutputFiles(
  files: readonly PersistentCandidateFile[],
  supplied: OutputCheckSpec[]
): OutputCheckResult[] {
  const checks = normalizeOutputChecks(supplied)!
  return checks.map((check) => {
    const matches = files.filter((file) => file.path === check.path)
    const base = { path: check.path, pointer: check.pointer }
    if (matches.length === 0) return { ...base, status: 'fail', reason: 'missing-file' }
    if (matches.length !== 1) throw new Error('Ambiguous fixed-version output path')
    const file = matches[0]!
    if (file.digest !== 'sha256:' + createHash('sha256').update(file.content).digest('hex'))
      throw new Error('Output checksum mismatch')
    const pinned = { ...base, artifactRef: structuredClone(file.artifactRef) }
    let value: unknown
    try {
      value = JSON.parse(file.content)
    } catch {
      return { ...pinned, status: 'fail', reason: 'invalid-json' }
    }
    for (const part of check.pointer === ''
      ? []
      : check.pointer
          .slice(1)
          .split('/')
          .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
      if (
        !value ||
        typeof value !== 'object' ||
        (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(part)) ||
        !Object.hasOwn(value, part)
      )
        return { ...pinned, status: 'fail', reason: 'missing-value' }
      value = (value as Record<string, unknown>)[part]
    }
    const equal =
      typeof check.expected === 'number' && check.tolerance !== undefined
        ? typeof value === 'number' &&
          Number.isFinite(value) &&
          Math.abs(value - check.expected) <= check.tolerance
        : canonicalOutput(value) === canonicalOutput(check.expected)
    return { ...pinned, status: equal ? 'pass' : 'fail', reason: equal ? 'matched' : 'mismatch' }
  })
}
