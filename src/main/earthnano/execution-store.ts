import type { ExecutionRecord } from '../../shared/earthnano/execution-port'
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
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ExecutionCore,
  emptyExecutionState,
  type ExecutionState,
  type ExecutionStore
} from './execution-core'

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

/** Shared persistence recovery: Core owns state transitions, original hosts supply exact witnesses.
 * Unknown cleanup retains its lock and blocks this resource; this helper never dispatches a provider. */
export async function recoverExecutionJournals(options: {
  directory: string
  /** Only this resource is being admitted; unrelated unknown resources remain fenced individually. */
  targetEnvironmentId?: string
  matches(record: ExecutionRecord): boolean
  readOriginal?(
    record: ExecutionRecord,
    owner: { filename: string; recoveredOwnerPid?: number }
  ): Promise<Parameters<ExecutionCore['reconcileOriginal']>[1] | undefined>
}): Promise<void> {
  const files: string[] = []
  const walk = async (directory: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink())
        throw new Error('Linked execution journal boundary is unsupported')
      const filename = join(directory, entry.name)
      if (entry.isDirectory()) await walk(filename)
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(filename)
    }
  }
  await walk(options.directory)
  for (const filename of files) {
    const snapshot = JSON.parse(await readFile(filename, 'utf8')) as ExecutionState
    const unresolved = Object.values(snapshot.records).filter(
      (record) =>
        options.matches(record) &&
        (record.cleanup !== 'confirmed' ||
          !['completed', 'failed', 'cancelled', 'interrupted'].includes(record.phase))
    )
    if (!unresolved.length) continue
    const blocksTarget = unresolved.some(
      (record) =>
        !options.targetEnvironmentId ||
        record.request.environmentSpecRef.id === options.targetEnvironmentId
    )
    let store: FileExecutionStore
    try {
      store = FileExecutionStore.recoverStale(filename)
    } catch (error) {
      if (blocksTarget) throw error
      continue
    }
    let core: ExecutionCore | undefined
    let confirmed = false
    try {
      core = new ExecutionCore(store, {
        execute: async () => {
          throw new Error('Recovery cannot dispatch a provider')
        }
      })
      for (const previous of unresolved) {
        const record = await core.get(previous.executionId)
        const outcome = await options.readOriginal?.(record, {
          filename,
          recoveredOwnerPid: store.recoveredOwnerPid
        })
        if (!outcome) {
          if (
            !options.targetEnvironmentId ||
            record.request.environmentSpecRef.id === options.targetEnvironmentId
          )
            throw new Error(
              'Execution resource remains fenced pending original-owner reconciliation'
            )
          continue
        }
        core.reconcileOriginal(record.executionId, outcome)
      }
      confirmed = Object.values(store.load().records).every(
        (record) => record.cleanup === 'confirmed'
      )
    } finally {
      core?.dispose()
      if (confirmed) store.close()
    }
  }
}
