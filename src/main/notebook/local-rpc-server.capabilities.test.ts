import { once } from 'node:events'
import { request as httpRequest, type ClientRequest, type Server } from 'node:http'
import type { ComputeHost } from '@aipoch/compute'
import { ComputeService } from '../compute/compute-service'
import type { ComputeHostRepository } from '../compute/repository'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentComputeService, type RawComputeService } from '../compute/agent-compute-service'

import { NotebookLocalRpcServer } from './local-rpc-server'

type RpcConnection = {
  endpoint: string
  token: string
}

const callCapabilities = async (
  connection: RpcConnection,
  token = connection.token,
  params: Record<string, unknown> = {}
): Promise<{ response: Response; payload: Record<string, unknown> }> => {
  const response = await fetch(connection.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'capabilitiesCall', params })
  })
  return {
    response,
    payload: (await response.json()) as Record<string, unknown>
  }
}

const callHostSdkHelp = async (
  connection: RpcConnection,
  query: string
): Promise<{ response: Response; payload: Record<string, unknown> }> => {
  const response = await fetch(connection.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'hostSdkHelp', params: { query } })
  })
  return {
    response,
    payload: (await response.json()) as Record<string, unknown>
  }
}

let server: NotebookLocalRpcServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('capabilitiesCall RPC', () => {
  it('projects the exact configured host namespace bitmap from a control capability', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      connectorService: {} as never,
      computeService: {} as never,
      agentsService: {} as never,
      skillsService: {} as never,
      hostArtifacts: {} as never,
      hostLineage: {} as never,
      hostFrames: {} as never,
      hostSessions: {} as never,
      hostModel: {
        isLlmAvailable: async () => true,
        isCurrentModelAvailable: async () => true,
        isListModelsAvailable: async () => true,
        currentModel: async () => 'model-a',
        listModels: async () => ['model-a'],
        call: async () => ({}) as never
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    const { response, payload } = await callCapabilities(connection, connection.token, {
      sessionId: 'forged-session',
      projectId: 'forged-project',
      mcp: false
    })

    expect(response.status).toBe(200)
    expect(payload).toEqual({
      result: {
        mcp: true,
        compute: true,
        agents: true,
        skills: true,
        artifacts: true,
        lineage: true,
        frames: true,
        sessions: true,
        llm: true,
        currentModel: true,
        listModels: true,
        viewImage: false,
        delegate: false,
        children: false,
        collect: false,
        stopChild: false,
        sendFrameMessage: false,
        messageReceipt: false,
        resolveMessage: false,
        submitOutput: false
      }
    })
  })

  it('returns false for known namespaces whose server handler is not configured', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      connectorService: {} as never
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: {
        result: {
          mcp: true,
          compute: false,
          agents: false,
          skills: false,
          artifacts: false,
          lineage: false,
          frames: false,
          llm: false,
          currentModel: false,
          listModels: false,
          viewImage: false
        }
      }
    })
  })

  it('does not advertise delegated work without the trusted origin required by its route', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: {
        delegate: async () => ({}) as never,
        sendMessage: async () => ({}) as never
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-1'
    })

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: { result: { delegate: false, sendFrameMessage: false } }
    })

    endInvocation()
  })

  it('does not advertise Host Frames to an ordinary non-control Session token', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostFrames: {} as never
    })
    const connection = await server.issueSessionConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: { result: { frames: false } }
    })
  })

  it('does not advertise Host Session diagnostics to ordinary or delegate control tokens', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostSessions: {} as never
    })
    const ordinary = await server.issueSessionConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    const delegate = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'delegate-frame',
      { role: 'delegate', attemptId: 'attempt-1' }
    )

    await expect(callCapabilities(ordinary)).resolves.toMatchObject({
      payload: { result: { sessions: false } }
    })
    await expect(callCapabilities(delegate)).resolves.toMatchObject({
      payload: { result: { sessions: false } }
    })
  })

  it('returns false when host.llm is configured but the active route is unavailable', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostModel: {
        isLlmAvailable: async () => false,
        isCurrentModelAvailable: async () => true,
        isListModelsAvailable: async () => true,
        currentModel: async () => 'model-a',
        listModels: async () => ['model-a'],
        call: async () => ({}) as never
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: { result: { llm: false, currentModel: true, listModels: true } }
    })
  })

  it('does not advertise host.llm through a non-control session capability', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostModel: {
        isLlmAvailable: async () => true,
        isCurrentModelAvailable: async () => true,
        isListModelsAvailable: async () => true,
        currentModel: async () => 'model-a',
        listModels: async () => ['model-a'],
        call: async () => ({}) as never
      }
    })
    const connection = await server.issueSessionConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: { result: { llm: false, currentModel: false, listModels: false } }
    })
  })

  it('reports host.llm as available through authenticated host.help', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostModel: {
        isLlmAvailable: async () => true,
        isCurrentModelAvailable: async () => false,
        isListModelsAvailable: async () => false,
        currentModel: async () => 'model-a',
        listModels: async () => [],
        call: async () => ({}) as never
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(callHostSdkHelp(connection, 'llm')).resolves.toMatchObject({
      response: { status: 200 },
      payload: {
        result: {
          kind: 'operation',
          id: 'host.llm',
          availability: { status: 'available' }
        }
      }
    })
  })

  it('reports host.sessions as available through authenticated host.help', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostSessions: {} as never
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(callHostSdkHelp(connection, 'sessions')).resolves.toMatchObject({
      response: { status: 200 },
      payload: {
        result: {
          kind: 'operation',
          id: 'host.sessions',
          availability: { status: 'available' }
        }
      }
    })
  })

  it('does not advertise host.viewImage without a trusted execution workspace', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostViewImage: {
        isAvailable: async () => true,
        stage: async () => ({}) as never,
        complete: async () => [],
        discard: () => {},
        discardSession: () => {},
        shutdown: () => {}
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-1'
    })

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: { result: { viewImage: false } }
    })

    endInvocation()
  })

  it('reports host.viewImage unavailable from host.help without a trusted execution workspace', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostViewImage: {
        isAvailable: async () => true,
        stage: async () => ({}) as never,
        complete: async () => [],
        discard: () => {},
        discardSession: () => {},
        shutdown: () => {}
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-1'
    })

    await expect(callHostSdkHelp(connection, 'viewImage')).resolves.toMatchObject({
      payload: { result: { availability: { status: 'unavailable' } } }
    })

    endInvocation()
  })

  it('advertises host.viewImage with an active invocation and trusted execution workspace', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostViewImage: {
        isAvailable: async () => true,
        stage: async () => ({}) as never,
        complete: async () => [],
        discard: () => {},
        discardSession: () => {},
        shutdown: () => {}
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session',
      { role: 'main' },
      '/trusted-workspace'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-1'
    })

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: { result: { viewImage: true } }
    })

    endInvocation()
  })

  it('does not advertise host.viewImage when its certified visual route is unavailable', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostViewImage: {
        isAvailable: async () => false,
        stage: async () => ({}) as never,
        complete: async () => [],
        discard: () => {},
        discardSession: () => {},
        shutdown: () => {}
      }
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session',
      { role: 'main' },
      '/trusted-workspace'
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-1'
    })

    await expect(callCapabilities(connection)).resolves.toMatchObject({
      payload: { result: { viewImage: false } }
    })

    endInvocation()
  })

  it('rejects bootstrap, invalid, and released tokens instead of returning an all-false bitmap', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp'
    })
    const bootstrap = await server.ensureStarted()
    const control = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    const bootstrapAttempt = await callCapabilities(control, bootstrap.token)
    expect(bootstrapAttempt.response.status).toBe(401)
    expect(bootstrapAttempt.payload).toEqual({
      error: 'A session-bound notebook RPC token is required.'
    })

    const invalidAttempt = await callCapabilities(control, 'invalid-token')
    expect(invalidAttempt.response.status).toBe(401)
    expect(invalidAttempt.payload).toEqual({ error: 'Invalid notebook RPC token.' })

    control.release()
    const releasedAttempt = await callCapabilities(control)
    expect(releasedAttempt.response.status).toBe(401)
    expect(releasedAttempt.payload).toEqual({ error: 'Invalid notebook RPC token.' })
  })
})

describe('trusted Compute control policy', () => {
  const rpc = async (
    connection: RpcConnection,
    method: string,
    params: object = {}
  ): Promise<{ status: number; payload: unknown }> => {
    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, params })
    })
    return { status: response.status, payload: await response.json() }
  }
  const methods = new Set(['computeCall', 'capabilitiesCall', 'hostSdkHelp', 'execute', 'invented'])

  it.each(['main', 'delegate'] as const)(
    'intersects the %s control token with original methods and keeps other namespaces closed',
    async (role) => {
      server = new NotebookLocalRpcServer({ execute: vi.fn() } as never, {
        transport: 'tcp',
        computeService: {} as never,
        connectorService: {} as never,
        agentsService: {} as never,
        hostModel: {
          isLlmAvailable: async () => true,
          isCurrentModelAvailable: async () => true,
          isListModelsAvailable: async () => true
        } as never
      })
      const connection = await server.issueControlConnection(
        'private',
        'project',
        'root-frame-private',
        role === 'delegate' ? { role, attemptId: 'attempt' } : { role },
        undefined,
        {
          allowedMethods: methods,
          interactionPolicy: 'deny-unresolved',
          assertComputeHostCurrent: async () => {}
        }
      )
      const projected = await callCapabilities(connection)
      expect(projected.payload).toMatchObject({
        result: {
          compute: true,
          mcp: false,
          agents: false,
          llm: false,
          currentModel: false,
          listModels: false,
          artifacts: false,
          sessions: false,
          delegate: false
        }
      })
      for (const method of ['mcpCall', 'agentsCall', 'llmCall', 'artifactsCall', 'execute']) {
        expect((await rpc(connection, method)).status).toBe(403)
      }
      expect((await rpc(connection, 'invented')).status).toBe(404)
      expect((await callHostSdkHelp(connection, 'compute')).response.status).toBe(200)
      connection.release()
      expect((await rpc(connection, 'capabilitiesCall')).status).toBe(401)
    }
  )

  it('uses the original Agent facade with token identity, invocation producer and policy over socket JSON', async () => {
    const callCommand = vi.fn<RawComputeService['callCommand']>(async () => ({
      exit_code: 0,
      stdout: '',
      stderr: '',
      truncated: false
    }))
    const submitJob = vi.fn<RawComputeService['submitJob']>(async () => ({
      job_id: 'job',
      provider_id: 'ssh:host',
      status: 'submitted',
      remote_workdir: '/fixture'
    }))
    const compute = new AgentComputeService(
      {
        list: async () => [{ providerId: 'ssh:host' }],
        callCommand,
        submitJob
      } as never,
      { getEnabled: () => ['ssh:host'], getSelected: () => ['ssh:host'] }
    )
    server = new NotebookLocalRpcServer({ execute: vi.fn() } as never, {
      transport: 'tcp',
      computeService: compute
    })
    const assertComputeHostCurrent = vi.fn(async () => {})
    const connection = await server.issueControlConnection(
      'private',
      'project',
      'root-frame-private',
      undefined,
      undefined,
      {
        allowedMethods: methods,
        interactionPolicy: 'deny-unresolved',
        assertComputeHostCurrent
      }
    )
    const end = connection.beginControlInvocation({
      turnId: 'turn',
      controlInvocationGeneration: 1,
      toolInvocationId: 'real-producer'
    })
    const forged = {
      provider_id: 'ssh:host',
      sessionId: 'source',
      projectId: 'foreign',
      producerRunId: 'fake-producer',
      interactionPolicy: 'interactive'
    }
    expect(
      (
        await rpc(connection, 'computeCall', {
          ...forged,
          op: 'call_command',
          cmd: 'true',
          intent: 'fixture'
        })
      ).status
    ).toBe(200)
    expect(
      (
        await rpc(connection, 'computeCall', {
          ...forged,
          op: 'submit_job',
          command: 'true',
          intent: 'fixture'
        })
      ).status
    ).toBe(200)
    const context = {
      sessionId: 'private',
      projectId: 'project',
      producerRunId: 'real-producer',
      interactionPolicy: 'deny-unresolved'
    }
    expect(callCommand.mock.calls[0][5]).toEqual(context)
    expect(submitJob.mock.calls[0][4]).toEqual(context)
    expect(assertComputeHostCurrent.mock.calls).toEqual([['ssh:host'], ['ssh:host']])
    end()
    connection.release()
  })

  it.each(['append', 'replace'] as const)(
    'keeps shared host details read-only for a scoped trial while ordinary %s remains available',
    async (mode) => {
      const original = 'Original shared host instructions'
      const host: ComputeHost = {
        id: 'shared-host',
        providerId: 'ssh:host',
        displayName: 'Shared host',
        shape: 'scheduler_cluster',
        executionMode: 'direct_ssh',
        sshAlias: 'host',
        sshOverrides: undefined,
        scratchRoot: undefined,
        scratchPinned: false,
        concurrencyLimit: undefined,
        probeResult: undefined,
        detailsDoc: original,
        detailsUpdatedAt: undefined,
        detailsUpdatedBy: undefined,
        createdAt: 1,
        updatedAt: 1
      }
      const updateDetails = vi.fn(
        async (
          providerId: string,
          text: string,
          author: 'user' | 'agent',
          hostId: string,
          oldText: string
        ) => {
          if (providerId !== host.providerId || hostId !== host.id || oldText !== host.detailsDoc)
            return false
          host.detailsDoc = text
          host.detailsUpdatedBy = author
          return true
        }
      )
      const repository = {
        get: async (id: string) => (id === host.providerId ? host : null),
        list: async () => [host],
        updateDetails
      } as unknown as ComputeHostRepository
      const compute = new AgentComputeService(
        new ComputeService({ runner: {} as never, repository }),
        { getEnabled: () => [host.providerId], getSelected: () => [host.providerId] }
      )
      server = new NotebookLocalRpcServer({ execute: vi.fn() } as never, {
        transport: 'tcp',
        computeService: compute
      })
      const scoped = await server.issueControlConnection(
        'private',
        'project',
        'root-frame-private',
        undefined,
        undefined,
        {
          allowedMethods: methods,
          interactionPolicy: 'deny-unresolved',
          assertComputeHostCurrent: async () => {}
        }
      )
      const ordinary = await server.issueControlConnection(
        'ordinary',
        'project',
        'root-frame-ordinary'
      )
      const end = scoped.beginControlInvocation({
        turnId: 'turn',
        controlInvocationGeneration: 1,
        toolInvocationId: 'producer'
      })
      const params = {
        op: 'details',
        provider_id: host.providerId,
        mode,
        text: 'Candidate change',
        old_text: original
      }
      expect(
        await rpc(scoped, 'computeCall', {
          op: 'details',
          provider_id: host.providerId,
          mode: 'read'
        })
      ).toMatchObject({ status: 200, payload: { result: { doc: original } } })
      const rejected = await rpc(scoped, 'computeCall', {
        ...params,
        interactionPolicy: 'interactive',
        controlPolicy: undefined
      })
      expect({
        status: rejected.status,
        writes: updateDetails.mock.calls.length,
        doc: host.detailsDoc
      }).toEqual({ status: 403, writes: 0, doc: original })
      expect(rejected.payload).toMatchObject({ error: expect.stringMatching(/shared host/i) })
      // JSON-supplied restrictions cannot narrow or authorize an ordinary original token.
      expect(
        await rpc(ordinary, 'computeCall', { ...params, interactionPolicy: 'deny-unresolved' })
      ).toEqual({ status: 200, payload: { result: { ok: true } } })
      expect(updateDetails).toHaveBeenCalledOnce()
      const expected = mode === 'append' ? `${original}\nCandidate change` : 'Candidate change'
      expect(host.detailsDoc).toBe(expected)
      expect(host.detailsUpdatedBy).toBe('agent')
      expect(
        await rpc(scoped, 'computeCall', { op: 'details', provider_id: host.providerId })
      ).toMatchObject({ status: 200, payload: { result: { doc: expected } } })
      end()
      scoped.release()
      ordinary.release()
    }
  )

  it.each(
    (['scoped', 'ordinary'] as const).flatMap((policy) =>
      (['none', 'none-to-current', 'replaced', 'ended', 'current'] as const).map((timing) => ({
        policy,
        timing
      }))
    )
  )(
    'binds $policy Compute submission to the invocation before its $timing body',
    async ({ policy, timing }) => {
      const submitJob = vi.fn<RawComputeService['submitJob']>(async () => ({
        job_id: 'job',
        provider_id: 'ssh:host',
        status: 'submitted',
        remote_workdir: '/fixture'
      }))
      const compute = new AgentComputeService(
        { list: async () => [{ providerId: 'ssh:host' }], submitJob } as never,
        { getEnabled: () => ['ssh:host'], getSelected: () => ['ssh:host'] }
      )
      server = new NotebookLocalRpcServer({ execute: vi.fn() } as never, {
        transport: 'tcp',
        computeService: compute
      })
      const connection = await server.issueControlConnection(
        'private',
        'project',
        'root-frame-private',
        undefined,
        undefined,
        policy === 'scoped'
          ? {
              allowedMethods: methods,
              interactionPolicy: 'deny-unresolved',
              assertComputeHostCurrent: async () => {}
            }
          : undefined
      )
      let end: (() => void) | undefined
      if (!['none', 'none-to-current'].includes(timing))
        end = connection.beginControlInvocation({
          turnId: 'initial',
          controlInvocationGeneration: 1,
          toolInvocationId: 'initial-producer'
        })
      const underlying = (server as unknown as { server?: Server }).server
      if (!underlying) throw new Error('Expected the local RPC server to be listening')
      const accepted = once(underlying, 'request')
      const payload = JSON.stringify({
        method: 'computeCall',
        params: {
          op: 'submit_job',
          provider_id: 'ssh:host',
          command: 'true',
          intent: 'fixture',
          producerRunId: 'forged',
          interactionPolicy: 'interactive'
        }
      })
      let request!: ClientRequest
      const outcome = new Promise<number>((resolve, reject) => {
        request = httpRequest(
          connection.endpoint,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${connection.token}`,
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload)
            }
          },
          (response) => {
            response.resume()
            resolve(response.statusCode ?? 500)
          }
        )
        request.once('error', reject)
      })
      try {
        request.write(payload.slice(0, -1))
        await accepted
        // Node's request event proves the original server has captured its pre-body invocation.
        if (timing === 'ended' || timing === 'replaced') end?.()
        if (timing === 'none-to-current' || timing === 'replaced')
          end = connection.beginControlInvocation({
            turnId: 'successor',
            controlInvocationGeneration: 2,
            toolInvocationId: 'successor-producer'
          })
        request.end(payload.slice(-1))
        const status = await outcome
        const permitted = policy === 'ordinary' || timing === 'current'
        const producer =
          timing === 'current'
            ? 'initial-producer'
            : ['none-to-current', 'replaced'].includes(timing)
              ? 'successor-producer'
              : undefined
        expect({
          status,
          producers: submitJob.mock.calls.map((call) => call[4]?.producerRunId)
        }).toEqual({
          status: permitted ? 200 : ['none', 'none-to-current'].includes(timing) ? 403 : 409,
          producers: permitted ? [producer] : []
        })
        if (permitted)
          expect(submitJob.mock.calls[0][4]).toEqual({
            sessionId: 'private',
            projectId: 'project',
            producerRunId: producer,
            ...(policy === 'scoped' ? { interactionPolicy: 'deny-unresolved' } : {})
          })
      } finally {
        request.destroy()
        await outcome.catch(() => undefined)
        end?.()
        connection.release()
      }
    }
  )

  it('never substitutes a successor control invocation after a source check awaits', async () => {
    const callCommand = vi.fn()
    server = new NotebookLocalRpcServer({ execute: vi.fn() } as never, {
      transport: 'tcp',
      computeService: { callCommand } as never
    })
    let release!: () => void
    let entered!: () => void
    const checking = new Promise<void>((resolve) => {
      entered = resolve
    })
    const allowed = new Promise<void>((resolve) => {
      release = resolve
    })
    const connection = await server.issueControlConnection(
      'private',
      'project',
      'root-frame-private',
      undefined,
      undefined,
      {
        allowedMethods: methods,
        interactionPolicy: 'deny-unresolved',
        assertComputeHostCurrent: async () => {
          entered()
          await allowed
        }
      }
    )
    const end = connection.beginControlInvocation({
      turnId: 'first',
      controlInvocationGeneration: 1,
      toolInvocationId: 'old-producer'
    })
    const response = rpc(connection, 'computeCall', { op: 'call_command', provider_id: 'ssh:host' })
    await checking
    end()
    connection.beginControlInvocation({
      turnId: 'second',
      controlInvocationGeneration: 2,
      toolInvocationId: 'new-producer'
    })
    release()
    expect((await response).status).toBe(409)
    expect(callCommand).not.toHaveBeenCalled()
    connection.release()
  })

  it('does not accept a model-provided interaction policy on an ordinary control token', async () => {
    const callCommand = vi.fn<AgentComputeService['callCommand']>(async () => ({
      exit_code: 0,
      stdout: '',
      stderr: '',
      truncated: false
    }))
    server = new NotebookLocalRpcServer({ execute: vi.fn() } as never, {
      transport: 'tcp',
      computeService: { callCommand } as never
    })
    const connection = await server.issueControlConnection(
      'ordinary',
      'project',
      'root-frame-ordinary'
    )
    expect(
      (
        await rpc(connection, 'computeCall', {
          op: 'call_command',
          provider_id: 'ssh:host',
          interactionPolicy: 'deny-unresolved'
        })
      ).status
    ).toBe(200)
    expect(callCommand.mock.calls[0][0]).not.toHaveProperty('interactionPolicy')
    connection.release()
  })

  it('rejects source-host invalidation and token retirement while a trusted source check awaits', async () => {
    const callCommand = vi.fn()
    server = new NotebookLocalRpcServer({ execute: vi.fn() } as never, {
      transport: 'tcp',
      computeService: { callCommand } as never
    })
    let release!: () => void
    let entered!: () => void
    const checking = new Promise<void>((resolve) => {
      entered = resolve
    })
    const allowed = new Promise<void>((resolve) => {
      release = resolve
    })
    const connection = await server.issueControlConnection(
      'private',
      'project',
      'root-frame-private',
      undefined,
      undefined,
      {
        allowedMethods: methods,
        interactionPolicy: 'deny-unresolved',
        assertComputeHostCurrent: async () => {
          entered()
          await allowed
        }
      }
    )
    const end = connection.beginControlInvocation({
      turnId: 'turn',
      controlInvocationGeneration: 1,
      toolInvocationId: 'producer'
    })
    const response = rpc(connection, 'computeCall', { op: 'call_command', provider_id: 'ssh:host' })
    await checking
    connection.revoke()
    release()
    expect((await response).status).toBe(401)
    expect(callCommand).not.toHaveBeenCalled()
    end()
    const denied = await server.issueControlConnection(
      'private',
      'project',
      'root-frame-private',
      undefined,
      undefined,
      {
        allowedMethods: methods,
        interactionPolicy: 'deny-unresolved',
        assertComputeHostCurrent: async () => {
          throw new Error('Original source host is no longer enabled')
        }
      }
    )
    const endDenied = denied.beginControlInvocation({
      turnId: 'denied',
      controlInvocationGeneration: 2,
      toolInvocationId: 'denied-producer'
    })
    expect(
      (await rpc(denied, 'computeCall', { op: 'call_command', provider_id: 'ssh:host' })).status
    ).toBe(500)
    expect(callCommand).not.toHaveBeenCalled()
    endDenied()
    denied.release()
  })
})
