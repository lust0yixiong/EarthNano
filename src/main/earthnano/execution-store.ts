import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { emptyExecutionState, type ExecutionState, type ExecutionStore } from './execution-core'

/**
 * Local single-writer journal. A leftover lock after process death requires explicit operator
 * reconciliation; opening a second owner must never silently steal live runtime ownership.
 */
export class FileExecutionStore implements ExecutionStore {
  private closed = false
  private readonly lock: string
  constructor(private readonly filename: string) {
    mkdirSync(dirname(filename), { recursive: true })
    this.lock = `${filename}.lock`
    const fd = openSync(this.lock, 'wx', 0o600)
    try {
      writeFileSync(fd, String(process.pid))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  load(): ExecutionState {
    this.assertOpen()
    if (!existsSync(this.filename)) return emptyExecutionState()
    // A corrupt journal is a hard failure, never a fresh empty execution history.
    const value = JSON.parse(readFileSync(this.filename, 'utf8')) as ExecutionState
    if (!value.records || !value.events || !value.sequences || !value.budgets) {
      throw new Error('Invalid execution journal')
    }
    return value
  }
  commit(state: ExecutionState): void {
    this.assertOpen()
    const temp = `${this.filename}.${randomUUID()}.tmp`
    try {
      const fd = openSync(temp, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify(state))
        fsyncSync(fd)
      } finally { closeSync(fd) }
      renameSync(temp, this.filename)
      // fsync the directory on supported POSIX hosts. This local implementation targets those hosts.
      const directory = openSync(dirname(this.filename), 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
    }
  }
  close(): void {
    if (!this.closed) {
      unlinkSync(this.lock)
      this.closed = true
    }
  }
  private assertOpen(): void { if (this.closed) throw new Error('Execution store closed') }
}
