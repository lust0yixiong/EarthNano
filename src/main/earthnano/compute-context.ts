import type { ComputeHostRepository } from '@aipoch/compute'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  normalizeFrozenComputeContext,
  type FrozenComputeContext,
  type FrozenComputeHost
} from '../../shared/earthnano/compute-profile'
import { sessionComputeHostAccess } from '../compute/session-compute-host-access'

type ComputeSource = Pick<
  PersistedChatSession,
  'id' | 'projectId' | 'enabledComputeHosts' | 'selectedComputeHosts'
>
type Hosts = Pick<ComputeHostRepository, 'get'>

const readHostIdentities = async (
  providerIds: readonly string[],
  repository: Hosts
): Promise<FrozenComputeHost[]> =>
  Promise.all(
    providerIds.map(async (providerId) => {
      const host = await repository.get(providerId)
      if (!host || host.providerId !== providerId)
        throw new Error('Frozen Compute host is unavailable')
      return {
        id: host.id,
        providerId: host.providerId,
        shape: host.shape,
        // Original repository's legacy default; never infer a mode from probe text or topology.
        executionMode: host.executionMode ?? 'direct_ssh'
      }
    })
  )

/** Snapshot only; private Session creation still needs the original host reservation owner. */
export async function freezeComputeContext({
  source,
  hosts
}: {
  source: ComputeSource
  hosts: Hosts
}): Promise<FrozenComputeContext> {
  const access = sessionComputeHostAccess(source)
  return normalizeFrozenComputeContext({
    sourceProjectId: source.projectId,
    sourceSessionId: source.id,
    access,
    hosts: await readHostIdentities(access.enabledProviderIds, hosts)
  })
}

/** Checks live source visibility and exact original rows, never grants execution permission.
 * Source revocation closes new work; cleanup of already owned Jobs uses the original internal port. */
export async function assertFrozenComputeContext({
  frozen,
  source,
  hosts,
  providerId
}: {
  frozen: FrozenComputeContext
  source: ComputeSource
  hosts: Hosts
  providerId?: string
}): Promise<void> {
  const expected = normalizeFrozenComputeContext(frozen)
  if (source.projectId !== expected.sourceProjectId || source.id !== expected.sourceSessionId)
    throw new Error('Frozen Compute source ownership changed')
  const access = sessionComputeHostAccess(source)
  if (
    expected.access.enabledProviderIds.some(
      (provider) => !access.enabledProviderIds.includes(provider)
    ) ||
    (providerId !== undefined && !expected.access.enabledProviderIds.includes(providerId))
  )
    throw new Error('Frozen Compute host access is no longer available')
  const observed = normalizeFrozenComputeContext({
    sourceProjectId: source.projectId,
    sourceSessionId: source.id,
    // Preserve the task's exact selected pool/order rather than following later user selections.
    access: expected.access,
    hosts: await readHostIdentities(expected.access.enabledProviderIds, hosts)
  })
  const original = new Map(expected.hosts.map((host) => [host.providerId, host]))
  if (
    observed.hosts.some((host) => {
      const previous = original.get(host.providerId)!
      return (
        previous.id !== host.id ||
        previous.shape !== host.shape ||
        previous.executionMode !== host.executionMode
      )
    })
  )
    throw new Error('Frozen Compute host identity changed')
}
