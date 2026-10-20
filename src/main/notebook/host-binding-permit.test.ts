import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi, onTestFinished } from 'vitest'
import type { DiscoveredInterpreter } from '@aipoch/environment/contracts'
import { NotebookRuntimeService } from './runtime-service'
import { bindNotebookApprovals } from '../composition/notebook-approvals'
import type { AcpRuntimeState } from '../../shared/acp'

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
  bindNotebookApprovals(service, () => ({
    getState: () => ({ permissionProfiles: {} }) as AcpRuntimeState,
    requestAppApproval: codeApproval
  }))
  const scope = { projectId: 'project', sessionId: 'candidate', workspaceCwd: root }
  const available = await service.listRuntimes(scope)
  const { language, runtimeId, source, provenance, interpreterPath, version } =
    available.runtimes[0]
  const runtime = { language, runtimeId, source, provenance, interpreterPath, version }
  const releasePolicy = service.registerHostPermissionPolicy({
    ...scope,
    permissionPrompts: 'none'
  })
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
  expect(codeApproval.mock.calls.length).toBe(beforeRisk)
  expect(execute).not.toHaveBeenCalled()
  // The original ordinary approval callback remains interactive for a different Session.
  codeApproval.mockResolvedValueOnce(true)
  const ordinary = { ...scope, sessionId: 'ordinary' }
  expect(await service.bindRuntime({ ...ordinary, language: 'python', runtimeId })).toHaveProperty(
    'bound'
  )
  const ordinaryCell = await service.beginCodeCell({ ...ordinary, language: 'python' })
  await service.appendCodeCell({
    ...ordinary,
    ...ordinaryCell,
    delta: 'import os\nos.unlink("sentinel.txt")'
  })
  await service.finishCodeCell({ ...ordinary, ...ordinaryCell })
  codeApproval.mockResolvedValueOnce(true)
  await service.runCell({ ...ordinary, cellId: ordinaryCell.cellId })
  expect(execute).toHaveBeenCalledOnce()
  releasePolicy()

  const another = { ...scope, sessionId: 'revoked' }
  const release = service.registerHostBindingPermit({ ...another, runtime })
  release()
  expect(await service.bindRuntime({ ...another, language: 'python', runtimeId })).toHaveProperty(
    'error'
  )
})

it.skipIf(!process.env.EARTHNANO_RESEARCH_PYTHON)(
  'joins original Python process shutdown and terminal persistence before releasing a private Session',
  async () => {
    const { realpath } = await import('node:fs/promises')
    const { NotebookRuntimeSettingsModule } = await import('../settings/notebook-runtime-settings')
    const { SettingsRepository } = await import('../settings/repository')
    const { NotebookRunRepository } = await import('./repository')
    const root = await realpath(await mkdtemp(join(tmpdir(), 'notebook-private-stop-')))
    const settings = new NotebookRuntimeSettingsModule(new SettingsRepository(root))
    const python = process.env.EARTHNANO_RESEARCH_PYTHON!
    await settings.addManualInterpreter('python', python)
    await settings.setEnvironmentEnabled('python', await realpath(python), true)
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      notebookRuntimeSettings: settings
    })
    onTestFinished(async () => {
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    })
    service.setExecutionApproval(async () => false)
    service.setRuntimeBindingApproval(async () => false)
    const scope = { projectId: 'project', sessionId: 'private-stop', workspaceCwd: root }
    const listing = await service.listRuntimes(scope)
    const pythonId = await realpath(python)
    const runtime = listing.runtimes.find((entry) => entry.runtimeId === pythonId)!
    const release = service.registerHostBindingPermit({ ...scope, runtime })
    try {
      expect(
        await service.bindRuntime({ ...scope, language: 'python', runtimeId: runtime.runtimeId })
      ).toHaveProperty('bound')
    } finally {
      release()
    }
    const cell = await service.beginCodeCell({ ...scope, language: 'python' })
    await service.appendCodeCell({
      ...scope,
      ...cell,
      delta: 'import time\nprint("private running", flush=True)\ntime.sleep(60)'
    })
    await service.finishCodeCell({ ...scope, ...cell })
    const running = service.runCell({ ...scope, cellId: cell.cellId }).then(
      (result) => result,
      (error: unknown) => error
    )
    const repository = new NotebookRunRepository(root)
    await vi.waitFor(
      async () =>
        expect(
          (await repository.readSessionRuns(scope.projectId, scope.sessionId)).some(
            (run) => run.status === 'running'
          )
        ).toBe(true),
      { timeout: 10_000 }
    )
    await service.shutdown(scope)
    await running
    const runs = await repository.readSessionRuns(scope.projectId, scope.sessionId)
    expect(runs).toHaveLength(1)
    expect(['cancelled', 'interrupted']).toContain(runs[0].status)
    expect(service.getActiveNotebookSessions()).toEqual([])
    const reopened = await service.state(scope)
    expect(reopened.runs).toHaveLength(1)
  },
  30_000
)
