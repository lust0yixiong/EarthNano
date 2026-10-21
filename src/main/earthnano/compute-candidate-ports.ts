import type { ExecutionRequest } from '../../shared/earthnano/execution-port'
import type { BackgroundResultDeliveryOwnerOptions } from '../background-result-delivery/owner'

/** Host-only policy stored with the original control token; never accepted from model JSON. */
export type TrustedControlPolicy = Readonly<{
  allowedMethods: ReadonlySet<string>
  interactionPolicy: ExecutionRequest['interactionPolicy']
  assertComputeHostCurrent(providerId: string): Promise<void>
}>

/** Preserve both original Session admission and terminal-result promises. */
export type CandidateContinuationTarget = Pick<
  BackgroundResultDeliveryOwnerOptions,
  'sendContinuation' | 'isContinuationSaved' | 'canStartSessionTurn'
>

export type CandidateDeliveryRoute =
  | Readonly<{ kind: 'ordinary' }>
  | Readonly<{ kind: 'private'; target: CandidateContinuationTarget }>
  | Readonly<{ kind: 'private-unavailable' }>

export type ResolveCandidateDelivery = (sessionId: string) => Promise<CandidateDeliveryRoute>
