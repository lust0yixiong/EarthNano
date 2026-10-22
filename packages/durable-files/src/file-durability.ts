import { open, type FileHandle } from 'node:fs/promises'
import { closeSync, fsyncSync, openSync } from 'node:fs'

type SyncHandle = Pick<FileHandle, 'sync' | 'close'>
type OpenSyncHandle = (path: string, flags: 'r' | 'r+') => Promise<SyncHandle>

export type FileDurability = {
  syncFile: (path: string) => Promise<void>
  syncDirectory: (path: string) => Promise<void>
}

type FileDurabilityOptions = {
  openHandle?: OpenSyncHandle
  platform?: NodeJS.Platform
}

const defaultOpenHandle: OpenSyncHandle = (path, flags) => open(path, flags)

const isUnsupportedDirectorySync = (error: unknown, platform: NodeJS.Platform): boolean =>
  platform === 'win32' &&
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  ['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'].includes(String(error.code))

const syncOpenPath = async (
  openHandle: OpenSyncHandle,
  path: string,
  flags: 'r' | 'r+'
): Promise<void> => {
  const handle = await openHandle(path, flags)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export const createFileDurability = (options: FileDurabilityOptions = {}): FileDurability => {
  const openHandle = options.openHandle ?? defaultOpenHandle
  const platform = options.platform ?? process.platform

  return {
    // Windows requires a write-capable handle for FlushFileBuffers. Opening an ordinary file with
    // `r` makes FileHandle.sync() fail with EPERM even when the file itself is writable.
    syncFile: (path) => syncOpenPath(openHandle, path, 'r+'),
    syncDirectory: async (path) => {
      try {
        await syncOpenPath(openHandle, path, 'r')
      } catch (error) {
        // Node cannot open or flush directory handles on Windows. File barriers still protect the
        // payload there; POSIX platforms additionally make directory publication durable.
        if (isUnsupportedDirectorySync(error, platform)) {
          return
        }
        throw error
      }
    }
  }
}

export const defaultFileDurability = createFileDurability()

type SynchronousHandle = { sync: () => void; close: () => void }
export type SynchronousFileDurability = {
  syncFile: (path: string) => void
  syncDirectory: (path: string) => void
}
type SynchronousFileDurabilityOptions = {
  openHandle?: (path: string, flags: 'r' | 'r+') => SynchronousHandle
  platform?: NodeJS.Platform
}

/** Same file/directory barriers for owners whose publication transaction is synchronous. */
export const createSynchronousFileDurability = (
  options: SynchronousFileDurabilityOptions = {}
): SynchronousFileDurability => {
  const openHandle =
    options.openHandle ??
    ((path, flags) => {
      const handle = openSync(path, flags)
      return { sync: () => fsyncSync(handle), close: () => closeSync(handle) }
    })
  const syncPath = (path: string, flags: 'r' | 'r+'): void => {
    const handle = openHandle(path, flags)
    try {
      handle.sync()
    } finally {
      handle.close()
    }
  }
  return {
    syncFile: (path) => syncPath(path, 'r+'),
    syncDirectory: (path) => {
      try {
        syncPath(path, 'r')
      } catch (error) {
        if (!isUnsupportedDirectorySync(error, options.platform ?? process.platform)) throw error
      }
    }
  }
}

export const defaultSynchronousFileDurability = createSynchronousFileDurability()
