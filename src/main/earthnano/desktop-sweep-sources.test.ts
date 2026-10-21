import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ManagedFileReadLease } from '../managed-file-versions/read-port'
import { resolveDesktopSweepTask } from './desktop-sweep-sources'
import type { PersistentCandidateNotebookOptions } from './persistent-candidate-owner'

const agent = {
  backend: 'claude-code' as const,
  model: 'model',
  runtimeVersion: '2.1.232',
  providerRef: 'host-route'
}
const harness = { instructions: 'Original instructions', skills: [] }
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- preserve original lease fixture mock types
const source = (id: string) => {
  const bytes = Buffer.from(`value\n${id === 'a' ? 2 : 7}`),
    checksum = createHash('sha256').update(bytes).digest('hex')
  const runtime = {
    language: 'python' as const,
    runtimeId: `/runtime/${id}`,
    interpreterPath: `/python/${id}`,
    source: 'external' as const,
    provenance: 'user-own' as const,
    version: '3.12.0'
  }
  const session = {
    projectId: 'p',
    id,
    cwd: `/workspace/${id}`,
    messages: [
      {
        id: `prompt-${id}`,
        role: 'user',
        status: 'complete',
        content: `Analyze ${id}`,
        uploads: [
          {
            id: `upload-${id}`,
            versionId: `version-${id}`,
            sessionId: id,
            name: `${id}.csv`,
            size: bytes.length,
            sha256: checksum
          }
        ]
      }
    ]
  } as PersistedChatSession
  const lease = {
    logicalFile: { projectId: 'p', sessionId: id, id: `upload-${id}`, source: 'upload' },
    version: { id: `version-${id}`, checksum, filename: `${id}.csv` },
    size: bytes.length,
    readRange: vi.fn(async (start: number, end: number) => bytes.subarray(start, end)),
    verifyUnchanged: vi.fn(async () => {}),
    close: vi.fn(async () => {})
  } as unknown as ManagedFileReadLease
  return { session, lease, runtime, checksum }
}

describe('independent selected Notebook task sources', () => {
  it('freezes two original source prompts, immutable versions and enabled runtimes without primary inheritance', async () => {
    const sources: Record<string, ReturnType<typeof source>> = { a: source('a'), b: source('b') }
    const loadSession = vi.fn(async (_project: string, id: string) => sources[id].session)
    const openVersion = vi.fn(
      async (ref: { fileId: string }) => sources[ref.fileId.slice(-1)].lease
    )
    const listRuntimes = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      bindings: { python: sources[sessionId].runtime },
      runtimes: [{ ...sources[sessionId].runtime, runnable: true }]
    }))
    const notebook = {
      service: { listRuntimes },
      rpc: {},
      mcpEntryPath: '/host/entry'
    } as unknown as PersistentCandidateNotebookOptions
    const resolved = await Promise.all(
      ['a', 'b'].map((id) =>
        resolveDesktopSweepTask({
          projectId: 'p',
          task: {
            taskId: id,
            domain: 'csv',
            sourceSessionId: id,
            source: { kind: 'notebook', promptMessageId: `prompt-${id}` },
            criteria: `Verify ${id}`
          },
          agent,
          harness,
          loadSession,
          versions: { openVersion },
          notebook
        })
      )
    )
    for (const [index, id] of ['a', 'b'].entries()) {
      expect(resolved[index]).toMatchObject({
        taskId: id,
        sourceSessionId: id,
        sourcePromptMessageId: `prompt-${id}`,
        criteria: `Verify ${id}`,
        input: {
          task: {
            prompt: `Analyze ${id}`,
            files: [],
            managedInputs: [
              {
                sourceSessionId: id,
                sourceFileId: `upload-${id}`,
                inputFileVersionId: `version-${id}`,
                checksum: sources[id].checksum
              }
            ]
          },
          harness: { tools: 'notebook-python' },
          environment: { notebook: { runtime: sources[id].runtime } }
        }
      })
      expect(listRuntimes).toHaveBeenCalledWith({
        projectId: 'p',
        sessionId: id,
        workspaceCwd: `/workspace/${id}`
      })
      expect(sources[id].lease.verifyUnchanged).toHaveBeenCalledOnce()
      expect(sources[id].lease.close).toHaveBeenCalledOnce()
    }
    expect(openVersion.mock.calls).toEqual([
      [{ source: 'upload', projectId: 'p', fileId: 'upload-a' }, 'version-a'],
      [{ source: 'upload', projectId: 'p', fileId: 'upload-b' }, 'version-b']
    ])
    expect(resolved[0].input.agent).toEqual(resolved[1].input.agent)
    expect(resolved[0].input.environment).not.toEqual(resolved[1].input.environment)
  })
  it.each(['unavailable', 'tampered', 'abort'] as const)(
    'refuses %s evidence and closes the original lease before returning',
    async (failure) => {
      const current = source('a'),
        controller = new AbortController()
      if (failure === 'tampered')
        vi.mocked(current.lease.readRange).mockResolvedValue(Buffer.from('wrong!!'))
      if (failure === 'abort')
        vi.mocked(current.lease.readRange).mockImplementation(async () => {
          controller.abort()
          return Buffer.from('value\n2')
        })
      const listRuntimes = vi.fn(async () => ({ bindings: {}, runtimes: [] }))
      await expect(
        resolveDesktopSweepTask({
          projectId: 'p',
          task: {
            taskId: 'a',
            domain: 'csv',
            sourceSessionId: 'a',
            source: { kind: 'notebook', promptMessageId: 'prompt-a' },
            criteria: 'Verify'
          },
          agent,
          harness,
          loadSession: async () => current.session,
          versions: { openVersion: async () => current.lease },
          notebook: { service: { listRuntimes } } as unknown as PersistentCandidateNotebookOptions,
          signal: controller.signal
        })
      ).rejects.toThrow()
      expect(current.lease.close).toHaveBeenCalledOnce()
      if (failure !== 'unavailable') expect(listRuntimes).not.toHaveBeenCalled()
    }
  )
  it('keeps explicit text sources in their own original Session and grants no Notebook capability', async () => {
    const current = source('b'),
      openVersion = vi.fn()
    const task = {
      taskId: 'b',
      domain: 'csv',
      sourceSessionId: 'b',
      source: {
        kind: 'text' as const,
        prompt: 'Independent text',
        files: [{ path: 'b.csv', content: 'value\n9' }]
      },
      criteria: 'Check b'
    }
    const options = {
      projectId: 'p',
      task,
      agent,
      harness,
      loadSession: async () => current.session,
      versions: { openVersion }
    }
    expect(await resolveDesktopSweepTask(options)).toMatchObject({
      sourceSessionId: 'b',
      input: {
        task: { prompt: 'Independent text', files: task.source.files },
        harness: { tools: 'workspace-only' },
        environment: { network: 'provider-only' }
      }
    })
    expect(openVersion).not.toHaveBeenCalled()
    await expect(
      resolveDesktopSweepTask({
        ...options,
        loadSession: async () => ({ ...current.session, projectId: 'foreign' })
      })
    ).rejects.toThrow('Session unavailable')
  })
})

it('freezes the explicitly chosen original R binding even when Python is available and never falls back', async () => {
  const current = source('a')
  const r = {
    ...current.runtime,
    language: 'r' as const,
    runtimeId: '/original/R',
    interpreterPath: '/original/R',
    version: '4.4.3'
  }
  const listRuntimes = vi.fn(async () => ({
    bindings: { python: current.runtime, r },
    runtimes: [
      { ...current.runtime, runnable: true },
      { ...r, runnable: true }
    ]
  }))
  const options = {
    projectId: 'p',
    agent,
    harness,
    task: {
      taskId: 'r-task',
      domain: 'csv',
      sourceSessionId: 'a',
      source: { kind: 'notebook' as const, promptMessageId: 'prompt-a', language: 'r' as const },
      criteria: 'Verify R output'
    },
    loadSession: async () => current.session,
    versions: { openVersion: async () => current.lease },
    notebook: { service: { listRuntimes } } as unknown as PersistentCandidateNotebookOptions
  }
  const result = await resolveDesktopSweepTask(options)
  expect(result.input.harness.tools).toBe('notebook-r')
  expect(result.input.environment.notebook?.runtime).toEqual(r)
  expect(result.input.task.prompt).toBe('Analyze a')
  for (const listing of [
    { bindings: { python: current.runtime }, runtimes: [{ ...current.runtime, runnable: true }] },
    { bindings: { r: { ...r, status: 'unavailable' } }, runtimes: [{ ...r, runnable: true }] },
    { bindings: { r }, runtimes: [{ ...r, runnable: false }] },
    { bindings: { r: current.runtime }, runtimes: [{ ...r, runnable: true }] }
  ]) {
    listRuntimes.mockResolvedValueOnce(listing as never)
    await expect(resolveDesktopSweepTask(options)).rejects.toThrow('enabled R')
  }
})
