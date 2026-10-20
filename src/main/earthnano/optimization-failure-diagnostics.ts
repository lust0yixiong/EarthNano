import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

export type OptimizationFailureStage =
  | 'resume-validation'
  | 'input-projection'
  | 'owner-validation'
  | 'snapshot-validation'
  | 'method-process'
  | 'method-result'
  | 'execution-integrity'
  | 'domain-summary'
  | 'semantic-assessment'
  | 'research-verification'
  | 'result-projection'
  | 'cleanup'
export type HarnessFailureCategory =
  | 'harness-spawn'
  | 'harness-exit'
  | 'harness-result-missing'
  | 'harness-protocol'
  | 'harness-frame-limit'
  | 'harness-diagnostic-limit'
  | 'harness-binding'
  | 'harness-timeout'
  | 'harness-cancelled'
  | 'harness-io'
const harnessCategories: readonly string[] = [
  'harness-spawn',
  'harness-exit',
  'harness-result-missing',
  'harness-protocol',
  'harness-frame-limit',
  'harness-diagnostic-limit',
  'harness-binding',
  'harness-timeout',
  'harness-cancelled',
  'harness-io'
]
const bindingCodes = [
  'budget-exhausted',
  'request-conflict',
  'cleanup-unconfirmed',
  'not-found'
] as const
const protocolStatuses = ['ok', 'failed', 'partial', 'skipped'] as const
export interface HarnessFailureDetails {
  category: HarnessFailureCategory
  exitCode?: number | null
  protocolStatus?: unknown
  bindingCode?: unknown
}
export interface OptimizationFailureDiagnostic {
  schemaVersion: 1
  stage: OptimizationFailureStage
  category:
    HarnessFailureCategory | 'stage-failed' | 'cancelled' | 'deadline' | 'cleanup-unconfirmed'
  exitCode?: number
  protocolStatus?: (typeof protocolStatuses)[number]
  bindingCode?: (typeof bindingCodes)[number]
}

/** Fixed host facts only. Never retain the process exception, diagnostic text, or request. */
export class HarnessProcessFailure extends Error {
  readonly details: Omit<OptimizationFailureDiagnostic, 'schemaVersion' | 'stage'>
  constructor(input: HarnessFailureDetails) {
    super('Harness optimization did not complete; admitted executions remain owned by the core')
    this.name = 'HarnessProcessFailure'
    this.details = {
      category: harnessCategories.includes(input.category) ? input.category : 'harness-protocol',
      ...(Number.isInteger(input.exitCode) && input.exitCode! >= 0 && input.exitCode! <= 255
        ? { exitCode: input.exitCode! }
        : {}),
      ...(protocolStatuses.includes(input.protocolStatus as (typeof protocolStatuses)[number])
        ? { protocolStatus: input.protocolStatus as (typeof protocolStatuses)[number] }
        : {}),
      ...(bindingCodes.includes(input.bindingCode as (typeof bindingCodes)[number])
        ? { bindingCode: input.bindingCode as (typeof bindingCodes)[number] }
        : {})
    }
    Object.freeze(this.details)
  }
}

/** Best-effort private append under the existing run owner. Failure never changes execution or
 * masks the original exception. Fixed-size history survives explicit resume without replacement. */
export function recordOptimizationFailure(
  workRoot: string,
  stage: OptimizationFailureStage,
  error: unknown,
  category: 'stage-failed' | 'cancelled' | 'deadline' | 'cleanup-unconfirmed' = 'stage-failed'
): void {
  let handle: number | undefined
  try {
    const entry: OptimizationFailureDiagnostic = {
      schemaVersion: 1,
      stage,
      ...(error instanceof HarnessProcessFailure ? error.details : { category })
    }
    const bytes = JSON.stringify(entry) + '\n'
    const filename = join(workRoot, 'failure-diagnostics.jsonl')
    try {
      const boundary = lstatSync(filename)
      if (!boundary.isFile() || boundary.isSymbolicLink()) return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    }
    handle = openSync(
      filename,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600
    )
    const stat = fstatSync(handle)
    if (!stat.isFile() || stat.size + Buffer.byteLength(bytes) > 64 * 1024) return
    writeFileSync(handle, bytes)
    fsyncSync(handle)
  } catch {
    // Diagnostics are not an execution, cleanup, or result authority.
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle)
      } catch {
        /* Preserve the original failure. */
      }
    }
  }
}
