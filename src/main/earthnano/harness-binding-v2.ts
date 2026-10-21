import type { ExecutionRole } from '../../shared/earthnano/execution-port'
import { canonicalOutput, outputDigest } from './output-checks'

/** Reserved for the future catalog/sweep host. The current v1 runner never imports this module. */
export const HARNESS_BINDING_V2 = 'earthnano-harness-binding-v2' as const
export type HarnessModeToken = 'agg' | 'seq'
export interface HarnessBindingV2Identity {
  readonly schemaVersion: 2
  readonly bindingProfile: typeof HARNESS_BINDING_V2
  readonly k: number
  readonly seed: number | null
  readonly modes: readonly HarnessModeToken[]
  readonly baseScope: string
  readonly modeScopes: Readonly<Partial<Record<HarnessModeToken, string>>>
  readonly digest: string
}
const fail = (): never => {
  throw new Error('Harness v2 binding identity is unavailable or changed; paid replay refused')
}
const plain = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    return fail()
  return value as Record<string, unknown>
}
const text = (value: unknown, max = 256): string => {
  if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value) > max)
    return fail()
  return value
}

/** Exact projection of original Namespace('earthnano', 'claude-text', mode, k, seed, '').
 * Modes must already be canonical output from original CLI parse_modes; no new mode ordering,
 * benchmark, substrate or tag policy is introduced here. Real-original controls pin the spelling. */
export function createHarnessBindingV2Identity(options: {
  k: number
  seed: number | null
  modes: readonly HarnessModeToken[]
}): Readonly<HarnessBindingV2Identity> {
  const value = plain(options, ['k', 'seed', 'modes'])
  const suppliedModes = value.modes
  if (
    !Number.isSafeInteger(value.k) ||
    (value.k as number) < 1 ||
    (value.k as number) > 8 ||
    (value.seed !== null && !Number.isSafeInteger(value.seed)) ||
    !Array.isArray(suppliedModes) ||
    !suppliedModes.length ||
    canonicalOutput(suppliedModes) !==
      canonicalOutput(['agg', 'seq'].filter((m) => suppliedModes.includes(m)))
  )
    return fail()
  const k = value.k as number,
    seed = value.seed as number | null
  const modes = Object.freeze([...suppliedModes] as HarnessModeToken[])
  const scope = (mode: HarnessModeToken): string =>
    `earthnano-claude-text-${mode}${k}${seed === null ? '' : `-s${seed}`}`
  const modeScopes = Object.freeze(Object.fromEntries(modes.map((mode) => [mode, scope(mode)])))
  const identity = {
    schemaVersion: 2 as const,
    bindingProfile: HARNESS_BINDING_V2,
    k,
    seed,
    modes,
    baseScope: scope('agg'),
    modeScopes
  }
  return Object.freeze({ ...identity, digest: outputDigest(identity) })
}

/** Must run against the persisted descriptor BEFORE any v2 cache lookup or Core submission.
 * No migration from v1, missing/foreign descriptors, changed namespaces or changed modes. Full
 * task/agent/harness/environment/source/budget equality remains the existing resume owner's job. */
export function assertHarnessBindingV2Identity(
  expected: HarnessBindingV2Identity,
  persisted: unknown
): void {
  const canonical = createHarnessBindingV2Identity({
    k: expected.k,
    seed: expected.seed,
    modes: expected.modes
  })
  plain(persisted, [
    'schemaVersion',
    'bindingProfile',
    'k',
    'seed',
    'modes',
    'baseScope',
    'modeScopes',
    'digest'
  ])
  if (
    canonicalOutput(expected) !== canonicalOutput(canonical) ||
    canonicalOutput(persisted) !== canonicalOutput(canonical)
  )
    fail()
}

const methodRoles: readonly ExecutionRole[] = [
  'baseline',
  'candidate',
  'proposer',
  'composer',
  'selector',
  'reflection'
]
/** Slot identity only, never an admission/cache-hit authority. The host supplies the registered
 * logical task ID, and original scope is checked rather than inferred from a stage label. */
export function harnessBindingV2Slot(
  identity: HarnessBindingV2Identity,
  taskId: string,
  invocation: unknown
): string {
  assertHarnessBindingV2Identity(identity, identity)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(text(taskId, 128)) || taskId.endsWith('.'))
    return fail()
  const value = plain(invocation, ['taskId', 'scope', 'role', 'stageLabel', 'label', 'attempt'])
  const role = value.role as ExecutionRole
  if (
    value.taskId !== taskId ||
    !methodRoles.includes(role) ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    (role === 'baseline'
      ? value.scope !== identity.baseScope
      : !Object.values(identity.modeScopes).includes(value.scope as string))
  )
    return fail()
  const stage = text(value.stageLabel),
    label = text(value.label)
  return `${HARNESS_BINDING_V2}:${outputDigest([
    identity.digest,
    taskId,
    value.scope,
    role,
    stage,
    label,
    value.attempt
  ])}`
}
