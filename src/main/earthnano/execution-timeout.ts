/** Node timers and the shared execution contract use the same signed 32-bit millisecond bound. */
export const MAX_TIMER_TIMEOUT_MS = 2_147_483_647
/** Python's local binding caps both execution and RPC timeouts at one hour. */
export const HARNESS_RPC_TIMEOUT_MARGIN_MS = 30_000
export const MAX_HARNESS_EXECUTION_TIMEOUT_MS = 3_600_000 - HARNESS_RPC_TIMEOUT_MARGIN_MS

export function assertExecutionTimeout(value: number, maximum = MAX_TIMER_TIMEOUT_MS): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(
      'Invalid optimization timeout: expected a positive bounded integer in milliseconds'
    )
}
