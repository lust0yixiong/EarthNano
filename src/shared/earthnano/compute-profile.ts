import type { ComputeExecutionMode, ComputeHost } from '@aipoch/compute'
import type { SessionComputeHostAccess } from '../compute'

/** Original Node control REPL capability, distinct from the Python/R data language binding. */
export type ComputeToolsProfile = 'notebook-compute'

/** Frozen host identity only. Credentials, SSH configuration, grants and mutable details stay owned. */
export type FrozenComputeHost = Readonly<
  Pick<ComputeHost, 'id' | 'providerId' | 'shape'> & {
    executionMode: ComputeExecutionMode
  }
>

export type FrozenComputeContext = Readonly<{
  sourceProjectId: string
  sourceSessionId: string
  access: SessionComputeHostAccess
  hosts: readonly FrozenComputeHost[]
}>

const plain = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error('Compute profile requires a plain object')
  const entry = value as Record<string, unknown>
  if (
    keys.some((key) => !Object.hasOwn(entry, key)) ||
    Object.keys(entry).some((key) => !keys.includes(key))
  )
    throw new Error('Compute profile has missing or unsupported fields')
  return entry
}

const identity = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    throw new Error('Compute profile requires bounded nonempty identity')
  for (const character of value) {
    const point = character.codePointAt(0)!
    if (point < 32 || point === 127 || (point >= 0xd800 && point <= 0xdfff))
      throw new Error('Compute profile identity has a control character or lone surrogate')
  }
  return value
}

const providerId = (value: unknown): string => {
  const result = identity(value)
  // Same original Session host owner grammar; existence is checked at its repository boundary.
  if (!result.startsWith('ssh:') || result.length <= 4)
    throw new Error('Compute profile requires an original SSH provider identity')
  return result
}

const providers = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new Error('Compute host access requires an array')
  const result = value.map(providerId)
  if (new Set(result).size !== result.length) throw new Error('Duplicate Compute provider identity')
  return result
}

/** Shape validation is not admission. The host owner must recheck the original Session and rows. */
export function normalizeFrozenComputeContext(value: unknown): FrozenComputeContext {
  const entry = plain(value, ['sourceProjectId', 'sourceSessionId', 'access', 'hosts'])
  const access = plain(entry.access, ['enabledProviderIds', 'selectedProviderIds'])
  const enabledProviderIds = providers(access.enabledProviderIds)
  const selectedProviderIds = providers(access.selectedProviderIds)
  if (selectedProviderIds.some((provider) => !enabledProviderIds.includes(provider)))
    throw new Error('Selected Compute hosts must be enabled')
  if (!Array.isArray(entry.hosts)) throw new Error('Compute profile hosts require an array')
  const hosts = entry.hosts.map((value): FrozenComputeHost => {
    const host = plain(value, ['id', 'providerId', 'shape', 'executionMode'])
    if (
      !['direct_ssh', 'scheduler_cluster', 'bridge_runner'].includes(host.shape as string) ||
      !['direct_ssh', 'slurm'].includes(host.executionMode as string)
    )
      throw new Error('Compute profile requires original host shape and execution mode')
    return {
      id: identity(host.id),
      providerId: providerId(host.providerId),
      shape: host.shape as FrozenComputeHost['shape'],
      executionMode: host.executionMode as ComputeExecutionMode
    }
  })
  if (
    new Set(hosts.map((host) => host.id)).size !== hosts.length ||
    new Set(hosts.map((host) => host.providerId)).size !== hosts.length ||
    hosts.length !== enabledProviderIds.length ||
    hosts.some((host) => !enabledProviderIds.includes(host.providerId))
  )
    throw new Error('Compute profile requires one exact host identity per enabled provider')
  return {
    sourceProjectId: identity(entry.sourceProjectId),
    sourceSessionId: identity(entry.sourceSessionId),
    access: { enabledProviderIds, selectedProviderIds },
    hosts
  }
}

export function isComputeToolsProfile(tools: unknown): tools is ComputeToolsProfile {
  return tools === 'notebook-compute'
}
