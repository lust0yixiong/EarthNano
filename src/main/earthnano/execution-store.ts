import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { emptyExecutionState, type ExecutionState, type ExecutionStore } from './execution-core'

/**
 * Local single-writer journal. A leftover lock after process death requires explicit operator
 * reconciliation; opening a second owner must never silently steal live runtime ownership.
 */
export class FileExecutionStore implements ExecutionStore {
  private closed = false
  private recoveredPid?: number
  get recoveredOwnerPid(): number | undefined {
    return this.recoveredPid
  }
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
  /** Trusted restart recovery only. Never steal a live, inaccessible or malformed PID lock. */
  static recoverStale(filename: string): FileExecutionStore {
    const lock = `${filename}.lock`
    if (!existsSync(lock)) return new FileExecutionStore(filename)
    const recoveryLock = `${lock}.recovery`
    const recovery = openSync(recoveryLock, 'wx', 0o600)
    try {
      const before = lstatSync(lock)
      if (!before.isFile() || before.isSymbolicLink())
        throw new Error('Invalid execution owner lock')
      const contents = readFileSync(lock, 'utf8')
      const pid = Number(contents)
      if (!/^\d+$/.test(contents) || !Number.isSafeInteger(pid) || pid <= 0)
        throw new Error('Invalid execution owner PID')
      try {
        process.kill(pid, 0)
        throw new Error('Execution store still has a live owner')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      const after = lstatSync(lock)
      if (
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        contents !== readFileSync(lock, 'utf8')
      )
        throw new Error('Execution owner lock changed during recovery')
      unlinkSync(lock)
      const store = new FileExecutionStore(filename)
      store.recoveredPid = pid
      return store
    } finally {
      closeSync(recovery)
      unlinkSync(recoveryLock)
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
      } finally {
        closeSync(fd)
      }
      renameSync(temp, this.filename)
      // fsync the directory on supported POSIX hosts. This local implementation targets those hosts.
      const directory = openSync(dirname(this.filename), 'r')
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
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
  private assertOpen(): void {
    if (this.closed) throw new Error('Execution store closed')
  }
}
