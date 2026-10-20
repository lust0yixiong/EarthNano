import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi, onTestFinished } from 'vitest'
import type { DiscoveredInterpreter } from '@aipoch/environment/contracts'
import { NotebookRuntimeService } from './runtime-service'

it('scopes revocable first-binding consent to the exact target and retains original code risk approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notebook-host-binding-'))
  const runtimes: DiscoveredInterpreter[] = [0, 1].map((index) => ({
    language: 'python',
    provenance: 'user-own',
    envId: join(root, `python-${index}`),
    interpreterPath: join(root, `python-${index}`),
    label: `Python ${index}`,
    runnable: true
  }))
  const execute = vi.fn(async () => ({
    status: 'completed' as const,
    stdout: '',
    stderr: '',
    traceback: '',
    cwdAfter: root,
    outputs: [],
    kernelDispatched: true
  }))
  const service = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    notebookRuntimeSettings: {
      getSnapshot: async (language) => ({
        language,
        manualInterpreters: [],
        packageMirror: {},
        runtimeEnablement: {
          enabled: Object.fromEntries(runtimes.map((runtime) => [runtime.envId, true])),
          installAuthorized: {}
        }
      })
    },
    discoverRuntimes: async (language) =>
      runtimes.filter((runtime) => runtime.language === language),
    executorFactory: () => ({ execute, shutdown: async () => ({ reaped: true }) })
  })
  onTestFinished(async () => {
    await service.shutdownAll()
    await rm(root, { recursive: true, force: true })
  })
  const codeApproval = vi.fn(async () => false)
  service.setExecutionApproval(codeApproval)
  service.setRuntimeBindingApproval(async () => false)
  const scope = { projectId: 'project', sessionId: 'candidate', workspaceCwd: root }
  const available = await service.listRuntimes(scope)
  const { language, runtimeId, source, provenance, interpreterPath, version } =
    available.runtimes[0]
  const runtime = { language, runtimeId, source, provenance, interpreterPath, version }
  const revoke = service.registerHostBindingPermit({ ...scope, runtime })
  const foreign = await service.bindRuntime({
    ...scope,
    sessionId: 'foreign',
    language: 'python',
    runtimeId
  })
  expect(foreign).toHaveProperty('error')
  expect(await service.bindRuntime({ ...scope, language: 'python', runtimeId })).toHaveProperty(
    'bound'
  )
  revoke()
  const beforeRisk = codeApproval.mock.calls.length
  const cell = await service.beginCodeCell({ ...scope, language: 'python' })
  await service.appendCodeCell({ ...scope, ...cell, delta: 'import os\nos.unlink("sentinel.txt")' })
  await service.finishCodeCell({ ...scope, ...cell })
  await expect(service.runCell({ ...scope, cellId: cell.cellId })).rejects.toThrow(
    'one-time approval'
  )
  expect(codeApproval.mock.calls.length).toBe(beforeRisk + 1)
  expect(execute).not.toHaveBeenCalled()
  const another = { ...scope, sessionId: 'revoked' }
  const release = service.registerHostBindingPermit({ ...another, runtime })
  release()
  expect(await service.bindRuntime({ ...another, language: 'python', runtimeId })).toHaveProperty(
    'error'
  )
})
