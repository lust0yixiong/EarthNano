import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FileExecutionStore } from './execution-store'
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'execution-store-recovery-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
it('recovers only a provably dead PID lock and preserves the charged durable state', () => {
  const filename = join(root, 'attempt.json')
  const old = new FileExecutionStore(filename)
  const state = old.load()
  state.budgets.charge = { limit: 1, admitted: 1 }
  old.commit(state)
  writeFileSync(filename + '.lock', '2147483647')
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('dead'), { code: 'ESRCH' })
  })
  const recovered = FileExecutionStore.recoverStale(filename)
  expect(kill).toHaveBeenCalledWith(2147483647, 0)
  expect(recovered.load().budgets.charge).toEqual({ limit: 1, admitted: 1 })
  expect(readFileSync(filename + '.lock', 'utf8')).toBe(String(process.pid))
  recovered.close()
})
it.each(['live', 'permission', 'malformed'] as const)(
  'never steals a %s owner lock',
  (scenario) => {
    const filename = join(root, 'attempt.json')
    const owner = new FileExecutionStore(filename)
    const contents = scenario === 'malformed' ? 'not-a-pid' : String(process.pid)
    writeFileSync(filename + '.lock', contents)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (scenario === 'permission')
        throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
      return true
    })
    expect(() => FileExecutionStore.recoverStale(filename)).toThrow()
    expect(readFileSync(filename + '.lock', 'utf8')).toBe(contents)
    owner.close()
  }
)
it('keeps a cooperating recovery claimant exclusive', () => {
  const filename = join(root, 'attempt.json')
  const owner = new FileExecutionStore(filename)
  writeFileSync(filename + '.lock.recovery', 'existing recovery')
  expect(() => FileExecutionStore.recoverStale(filename)).toThrow()
  expect(readFileSync(filename + '.lock', 'utf8')).toBe(String(process.pid))
  owner.close()
})
