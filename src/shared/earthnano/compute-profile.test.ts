import { describe, expect, it } from 'vitest'
import {
  normalizeFrozenComputeContext,
  isComputeToolsProfile,
  type FrozenComputeHost
} from './compute-profile'
import {
  normalizeFrozenManagedInputs,
  normalizeFrozenNotebookInputs,
  type FrozenNotebookInput
} from './notebook-profile'
import { sessionComputeHostAccess } from '../../main/compute/session-compute-host-access'

type ComputeFixture = {
  sourceProjectId: string
  sourceSessionId: string
  access: { enabledProviderIds: string[]; selectedProviderIds: string[] }
  hosts: Array<{
    id: string
    providerId: string
    shape: FrozenComputeHost['shape']
    executionMode: FrozenComputeHost['executionMode']
  }>
}
const context = (): ComputeFixture => ({
  sourceProjectId: 'project',
  sourceSessionId: 'source-session',
  access: { enabledProviderIds: ['ssh:first', 'ssh:second'], selectedProviderIds: ['ssh:second'] },
  hosts: [
    { id: 'first-row', providerId: 'ssh:first', shape: 'direct_ssh', executionMode: 'direct_ssh' },
    {
      id: 'second-row',
      providerId: 'ssh:second',
      shape: 'scheduler_cluster',
      executionMode: 'slurm'
    }
  ]
})
const input = (index: number): FrozenNotebookInput => ({
  sourceKind: 'upload-version',
  sourceProjectId: 'project',
  sourceSessionId: 'source-session',
  sourceFileId: `file-${index}`,
  inputFileVersionId: `version-${index}`,
  filename: `values-${index}.csv`,
  sizeBytes: index,
  checksum: 'a'.repeat(64)
})

describe('original Compute frozen identity contract', () => {
  it('copies exact metadata while preserving enabled, selected and descriptor order', () => {
    const original = context()
    const frozen = normalizeFrozenComputeContext(original)
    expect(JSON.stringify(frozen)).toBe(JSON.stringify(original))
    original.access.selectedProviderIds.push('ssh:first')
    original.hosts[0].id = 'replaced-row'
    expect(frozen.access.selectedProviderIds).toEqual(['ssh:second'])
    expect(frozen.hosts[0].id).toBe('first-row')
  })

  it('keeps the original legacy selected default and an explicit empty selection distinct', () => {
    const legacy = sessionComputeHostAccess({ enabledComputeHosts: ['ssh:first', 'ssh:second'] })
    expect(normalizeFrozenComputeContext({ ...context(), access: legacy }).access).toEqual(legacy)
    const explicit = sessionComputeHostAccess({
      enabledComputeHosts: ['ssh:first', 'ssh:second'],
      selectedComputeHosts: []
    })
    expect(normalizeFrozenComputeContext({ ...context(), access: explicit }).access).toEqual({
      enabledProviderIds: ['ssh:first', 'ssh:second'],
      selectedProviderIds: []
    })
    expect(
      normalizeFrozenComputeContext({
        ...context(),
        access: { enabledProviderIds: [], selectedProviderIds: [] },
        hosts: []
      }).hosts
    ).toEqual([])
  })

  it.each([
    { password: 'forbidden' },
    { sourceSessionId: '' },
    { sourceProjectId: 'project\nother' },
    { sourceSessionId: '\ud800' },
    { hosts: [{ ...context().hosts[0], sshOverrides: { identityFile: '/private/key' } }] },
    { hosts: [{ ...context().hosts[0], authentication: { mode: 'password' } }] },
    { hosts: [{ ...context().hosts[0], executionMode: undefined }, context().hosts[1]] },
    { hosts: [{ ...context().hosts[0], executionMode: 'latest' }, context().hosts[1]] },
    { hosts: [{ ...context().hosts[0], shape: 'invented' }, context().hosts[1]] },
    { hosts: [{ ...context().hosts[0], providerId: 'ssh:' }, context().hosts[1]] },
    { hosts: [{ ...context().hosts[0], id: '\u0000' }, context().hosts[1]] },
    { access: { ...context().access, permissionGrant: 'source-session' } }
  ])('rejects credentials, grants and malformed host identities: %j', (change) => {
    expect(() => normalizeFrozenComputeContext({ ...context(), ...change })).toThrow()
  })

  it.each([
    { hosts: context().hosts.slice(0, 1) },
    { hosts: [...context().hosts, { ...context().hosts[0] }] },
    { hosts: [context().hosts[0], { ...context().hosts[1], id: 'first-row' }] },
    { hosts: [context().hosts[0], { ...context().hosts[1], providerId: 'ssh:foreign' }] },
    { access: { ...context().access, selectedProviderIds: ['ssh:disabled'] } },
    { access: { ...context().access, enabledProviderIds: ['ssh:first', 'ssh:first'] } },
    { access: { ...context().access, selectedProviderIds: ['ssh:second', 'ssh:second'] } }
  ])('requires a unique original row per enabled provider and a selected subset: %j', (change) => {
    expect(() => normalizeFrozenComputeContext({ ...context(), ...change })).toThrow()
  })

  it('distinguishes the original Node control profile from data language or arbitrary tools', () => {
    expect(isComputeToolsProfile('notebook-compute')).toBe(true)
    for (const value of ['workspace-only', 'notebook-python', 'notebook-r', 'repl', {}, null])
      expect(isComputeToolsProfile(value)).toBe(false)
  })
})

describe('shared original immutable input metadata', () => {
  it('allows zero and multiple Compute inputs without changing Notebook one-to-ten constraints', () => {
    expect(normalizeFrozenManagedInputs([])).toEqual([])
    const many = Array.from({ length: 12 }, (_, index) => input(index))
    expect(JSON.stringify(normalizeFrozenManagedInputs(many))).toBe(JSON.stringify(many))
    expect(() => normalizeFrozenNotebookInputs([])).toThrow(/one to ten/)
    expect(() => normalizeFrozenNotebookInputs(many)).toThrow(/one to ten/)
    expect(JSON.stringify(normalizeFrozenManagedInputs([input(0)]))).toBe(
      JSON.stringify(normalizeFrozenNotebookInputs([input(0)]))
    )
  })

  it.each([
    undefined,
    [input(1), input(1)],
    [input(1), { ...input(2), sourceProjectId: 'foreign' }],
    [{ ...input(1), remote_path: '/remote/file' }],
    [{ ...input(1), filename: '../escape' }],
    [{ ...input(1), checksum: 'forged' }]
  ])('retains duplicate, Project, path, byte and extra-field rejection: %j', (value) => {
    expect(() => normalizeFrozenManagedInputs(value)).toThrow()
  })
})
