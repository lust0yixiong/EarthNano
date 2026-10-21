import type { ComputeHost } from '@aipoch/compute'
import { describe, expect, it, vi } from 'vitest'
import { freezeComputeContext, assertFrozenComputeContext } from './compute-context'

const source = (): Parameters<typeof freezeComputeContext>[0]['source'] => ({
  id: 'source-session',
  projectId: 'project',
  enabledComputeHosts: ['ssh:first', 'ssh:second'],
  selectedComputeHosts: ['ssh:second']
})
const host = (alias: string): ComputeHost => ({
  id: `${alias}-row`,
  providerId: `ssh:${alias}`,
  displayName: alias,
  shape: 'direct_ssh',
  executionMode: 'direct_ssh',
  sshAlias: alias,
  sshOverrides: { identityFile: '/private/fixture-key' },
  scratchRoot: '/remote/work',
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  detailsDoc: 'mutable host details',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1
})
const fixture = (): {
  rows: Map<string, ComputeHost>
  hosts: { get: ReturnType<typeof vi.fn<(providerId: string) => Promise<ComputeHost | null>>> }
} => {
  const rows = new Map(['first', 'second', 'new'].map((alias) => [`ssh:${alias}`, host(alias)]))
  const hosts = { get: vi.fn(async (providerId: string) => rows.get(providerId) ?? null) }
  return { rows, hosts }
}

describe('original Session and host row freeze', () => {
  it('projects only original identity and preserves explicit empty and legacy selected semantics', async () => {
    const { rows, hosts } = fixture()
    rows.get('ssh:first')!.executionMode = undefined
    const frozen = await freezeComputeContext({ source: source(), hosts })
    expect(frozen.hosts[0]).toEqual({
      id: 'first-row',
      providerId: 'ssh:first',
      shape: 'direct_ssh',
      executionMode: 'direct_ssh'
    })
    expect(JSON.stringify(frozen)).not.toMatch(/fixture-key|scratch|mutable|authentication/)
    const legacy = { ...source(), selectedComputeHosts: undefined }
    expect(
      (await freezeComputeContext({ source: legacy, hosts })).access.selectedProviderIds
    ).toEqual(['ssh:first', 'ssh:second'])
    expect(
      (await freezeComputeContext({ source: { ...source(), selectedComputeHosts: [] }, hosts }))
        .access.selectedProviderIds
    ).toEqual([])
    expect(
      (
        await freezeComputeContext({
          source: { ...source(), enabledComputeHosts: [], selectedComputeHosts: [] },
          hosts
        })
      ).hosts
    ).toEqual([])
  })

  it('does not adopt new enabled hosts or follow a later selected pool', async () => {
    const { hosts } = fixture()
    const frozen = await freezeComputeContext({ source: source(), hosts })
    const current = {
      ...source(),
      enabledComputeHosts: ['ssh:new', 'ssh:first', 'ssh:second'],
      selectedComputeHosts: ['ssh:new']
    }
    await expect(
      assertFrozenComputeContext({ frozen, source: current, hosts })
    ).resolves.toBeUndefined()
    expect(frozen.access.selectedProviderIds).toEqual(['ssh:second'])
    await expect(
      assertFrozenComputeContext({ frozen, source: current, hosts, providerId: 'ssh:new' })
    ).rejects.toThrow(/access/)
    await expect(
      assertFrozenComputeContext({ frozen, source: current, hosts, providerId: 'ssh:first' })
    ).resolves.toBeUndefined()
  })

  it.each([
    { id: 'another-session' },
    { projectId: 'another-project' },
    { enabledComputeHosts: ['ssh:second'] }
  ])('rejects foreign source or revoked visibility before host access: %j', async (change) => {
    const { hosts } = fixture()
    const frozen = await freezeComputeContext({ source: source(), hosts })
    hosts.get.mockClear()
    await expect(
      assertFrozenComputeContext({ frozen, source: { ...source(), ...change }, hosts })
    ).rejects.toThrow()
    expect(hosts.get).not.toHaveBeenCalled()
  })

  it.each([
    { id: 'recreated-row' },
    { shape: 'scheduler_cluster' as const },
    { executionMode: 'slurm' as const }
  ])('rejects a replacement or changed host configuration: %j', async (change) => {
    const { rows, hosts } = fixture()
    const frozen = await freezeComputeContext({ source: source(), hosts })
    Object.assign(rows.get('ssh:first')!, change)
    await expect(assertFrozenComputeContext({ frozen, source: source(), hosts })).rejects.toThrow(
      /identity changed/
    )
  })

  it('rejects deleted hosts and a repository response for another provider', async () => {
    const { rows, hosts } = fixture()
    const frozen = await freezeComputeContext({ source: source(), hosts })
    rows.delete('ssh:first')
    await expect(assertFrozenComputeContext({ frozen, source: source(), hosts })).rejects.toThrow(
      /unavailable/
    )
    rows.set('ssh:first', host('foreign'))
    await expect(freezeComputeContext({ source: source(), hosts })).rejects.toThrow(/unavailable/)
  })

  it('allows mutable details updates while preserving identity; permission admission stays with the original broker', async () => {
    const { rows, hosts } = fixture()
    const frozen = await freezeComputeContext({ source: source(), hosts })
    Object.assign(rows.get('ssh:first')!, {
      displayName: 'renamed',
      detailsDoc: 'updated',
      updatedAt: 2
    })
    await expect(
      assertFrozenComputeContext({ frozen, source: source(), hosts })
    ).resolves.toBeUndefined()
    await expect(
      assertFrozenComputeContext({
        frozen: { ...frozen, hosts: [{ ...frozen.hosts[0], id: 'forged' }, frozen.hosts[1]] },
        source: source(),
        hosts
      })
    ).rejects.toThrow(/identity changed/)
  })
})
