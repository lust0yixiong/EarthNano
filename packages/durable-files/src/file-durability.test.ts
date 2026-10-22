import { describe, expect, it, vi } from 'vitest'

import { createFileDurability, createSynchronousFileDurability } from './file-durability'

describe('file durability', () => {
  it('opens ordinary files with a write-capable handle before syncing', async () => {
    const sync = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const openHandle = vi.fn().mockResolvedValue({ sync, close })
    const durability = createFileDurability({ openHandle, platform: 'win32' })

    await durability.syncFile('C:\\artifacts\\version.content')

    expect(openHandle).toHaveBeenCalledWith('C:\\artifacts\\version.content', 'r+')
    expect(sync).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps directory handles read-only and tolerates unsupported Windows directory sync', async () => {
    const error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    const openHandle = vi.fn().mockRejectedValue(error)
    const durability = createFileDurability({ openHandle, platform: 'win32' })

    await expect(durability.syncDirectory('C:\\artifacts')).resolves.toBeUndefined()
    expect(openHandle).toHaveBeenCalledWith('C:\\artifacts', 'r')
  })
})

it.each(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'])(
  'tolerates only Windows directory %s',
  async (code) => {
    const failure = Object.assign(new Error(code), { code })
    const close = vi.fn().mockResolvedValue(undefined)
    const openHandle = vi
      .fn()
      .mockResolvedValue({ sync: vi.fn().mockRejectedValue(failure), close })
    await expect(
      createFileDurability({ openHandle, platform: 'win32' }).syncDirectory('directory')
    ).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
    await expect(
      createFileDurability({ openHandle, platform: 'linux' }).syncDirectory('directory')
    ).rejects.toBe(failure)
    await expect(
      createFileDurability({ openHandle, platform: 'win32' }).syncFile('file')
    ).rejects.toBe(failure)
    expect(close).toHaveBeenCalledTimes(3)
  }
)

it('propagates unexpected directory sync failures and still closes the handle', async () => {
  const failure = Object.assign(new Error('disk failure'), { code: 'EIO' })
  const close = vi.fn().mockResolvedValue(undefined)
  const openHandle = vi.fn().mockResolvedValue({ sync: vi.fn().mockRejectedValue(failure), close })
  await expect(
    createFileDurability({ openHandle, platform: 'win32' }).syncDirectory('directory')
  ).rejects.toBe(failure)
  expect(close).toHaveBeenCalledOnce()
})

describe('synchronous file durability uses the same directory policy', () => {
  it('opens file payloads with write capability and directories read-only', () => {
    const sync = vi.fn(),
      close = vi.fn(),
      openHandle = vi.fn(() => ({ sync, close }))
    const durability = createSynchronousFileDurability({ openHandle, platform: 'win32' })
    durability.syncFile('file')
    durability.syncDirectory('directory')
    expect(openHandle.mock.calls).toEqual([
      ['file', 'r+'],
      ['directory', 'r']
    ])
    expect(sync).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(2)
  })

  it.each(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'])(
    'permits Windows directory %s only, including original open/close semantics',
    (code) => {
      const failure = Object.assign(new Error(code), { code })
      for (const phase of ['open', 'sync', 'close'] as const) {
        const close = vi.fn(() => {
          if (phase === 'close') throw failure
        })
        const openHandle = vi.fn(() => {
          if (phase === 'open') throw failure
          return {
            sync: (): void => {
              if (phase === 'sync') throw failure
            },
            close
          }
        })
        expect(() =>
          createSynchronousFileDurability({ openHandle, platform: 'win32' }).syncDirectory('dir')
        ).not.toThrow()
        for (const platform of ['linux', 'darwin'] as const) {
          expect(() =>
            createSynchronousFileDurability({ openHandle, platform }).syncDirectory('dir')
          ).toThrow(failure)
        }
        expect(() =>
          createSynchronousFileDurability({ openHandle, platform: 'win32' }).syncFile('file')
        ).toThrow(failure)
        expect(close).toHaveBeenCalledTimes(phase === 'open' ? 0 : 4)
      }
    }
  )

  it.each(['EIO', 'EACCES', 'ENOSPC', undefined])(
    'retains unknown Windows directory error %s and always closes opened handles',
    (code) => {
      const failure = Object.assign(new Error('directory failure'), { code })
      const close = vi.fn()
      const openHandle = vi.fn(() => ({
        sync: (): void => {
          throw failure
        },
        close
      }))
      expect(() =>
        createSynchronousFileDurability({ openHandle, platform: 'win32' }).syncDirectory('dir')
      ).toThrow(failure)
      expect(close).toHaveBeenCalledOnce()
    }
  )
})
