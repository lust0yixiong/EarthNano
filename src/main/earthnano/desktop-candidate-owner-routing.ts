import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type Stats
} from 'node:fs'
import { join } from 'node:path'
import { BackgroundResultDeliveryUnavailableError } from '../background-result-delivery/owner'
import { acquireDataRootWriter } from '../storage/migration-state'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import type { ExecutionRecord } from '../../shared/earthnano/execution-port'
import type { PersistentCandidateOwners } from './candidate-owner-contract'
import type { ResolveCandidateDelivery, TrustedControlPolicy } from './compute-candidate-ports'
import { requestDigest, validateRecord } from './execution-contract'
import { outputDigest } from './output-checks'
import { readPersistentOptimizationResume } from './optimization-resume'

export type CandidateOwnerPorts = Pick<
  PersistentCandidateOwners,
  'resolveCandidateDelivery' | 'resolveControlPolicy' | 'shutdown'
>
export type CandidateOwnersReady = (ports: CandidateOwnerPorts) => (() => void) | void
type ControlBinding = Parameters<NonNullable<CandidateOwnerPorts['resolveControlPolicy']>>[0]
const unavailable = (): BackgroundResultDeliveryUnavailableError =>
  new BackgroundResultDeliveryUnavailableError('Private result delivery owner is unavailable')
const safeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable()
  return value as Record<string, unknown>
}
const stat = (path: string): Stats | undefined => {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
const directory = (parent: string, name: string): string | undefined => {
  const path = join(parent, name)
  const value = stat(path)
  if (!value) return undefined
  if (!value.isDirectory() || value.isSymbolicLink()) throw unavailable()
  return path
}
const readJson = (path: string): Record<string, unknown> => {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink()) throw unavailable()
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (before.ino !== opened.ino || before.dev !== opened.dev) throw unavailable()
    const value = object(JSON.parse(readFileSync(fd, 'utf8')))
    const after = lstatSync(path)
    if (after.ino !== opened.ino || after.dev !== opened.dev || after.isSymbolicLink())
      throw unavailable()
    return value
  } finally {
    closeSync(fd)
  }
}
const runNames = (path: string | undefined): string[] => {
  if (!path) return []
  return readdirSync(path).filter((name) => /^[0-9a-f-]{36}$/.test(name))
}

/** Read-only identity classification, never resume/reconciliation or a second execution writer.
 * Caller holds the original current data-root lifetime lease. An incomplete negative is unsafe. */
export function readDesktopPrivateSessions(roots: {
  configRoot: string
  dataRoot: string
}): ReadonlySet<string> {
  // Canonicalize only trusted existing host roots; every child boundary remains link-rejecting.
  const config = realpathSync(roots.configRoot)
  const data = realpathSync(roots.dataRoot)
  const configRuns = directory(config, 'earthnano-desktop')
  const earthnano = directory(data, 'earthnano')
  const dataRuns = earthnano ? directory(earthnano, 'desktop-runs') : undefined
  const ids = new Set([...runNames(configRuns), ...runNames(dataRuns)])
  const sessions = new Set<string>()
  for (const id of ids) {
    const configRun = configRuns ? directory(configRuns, id) : undefined
    const dataRun = dataRuns ? directory(dataRuns, id) : undefined
    const desktop = configRun ? readJson(join(configRun, 'desktop.json')) : undefined
    const progress = desktop ? object(desktop.progress) : undefined
    if (desktop) {
      if (
        progress?.runId !== id ||
        !safeId(progress.projectId) ||
        !safeId(progress.sourceSessionId) ||
        !safeId(desktop.requestKey) ||
        typeof desktop.digest !== 'string' ||
        !desktop.digest ||
        (desktop.kind !== undefined && desktop.kind !== 'sweep-v2') ||
        (desktop.executionStarted !== undefined && typeof desktop.executionStarted !== 'boolean')
      )
        throw unavailable()
      if (desktop.executionStarted === false) {
        // Original setup failed before the durable possible-execution boundary. Directory/IDs
        // contradict this proof; never treat a later deleted or corrupt journal as setup-only.
        const budget = object(progress.budget)
        if (
          dataRun ||
          !Array.isArray(progress.executions) ||
          progress.executions.length ||
          budget.admitted !== 0 ||
          budget.completed !== 0 ||
          budget.active !== 0
        )
          throw unavailable()
        continue
      }
    }
    if (!dataRun) throw unavailable()
    const execution = directory(dataRun, 'execution')
    if (!execution) throw unavailable()
    // Validate exact committed files and their boundaries before using the original manifest reader.
    const manifestBytes = readJson(join(execution, 'resume.json'))
    const manifest = readPersistentOptimizationResume(execution)
    if (outputDigest(manifest) !== outputDigest(manifestBytes)) throw unavailable()
    if (
      manifest.identity.taskId !== id ||
      (progress &&
        (manifest.identity.projectId !== progress.projectId ||
          manifest.identity.sourceSessionId !== progress.sourceSessionId ||
          manifest.identity.executionLimit !== object(progress.budget).limit))
    )
      throw unavailable()
    const state = readJson(join(execution, 'execution.json'))
    const records = object(state.records)
    object(state.events)
    object(state.sequences)
    const budgets = object(state.budgets)
    const budgetKey = JSON.stringify([manifest.identity.projectId, manifest.optimizationId])
    // An initial committed empty store has no budget yet; it has no private owner either.
    if (
      Object.keys(records).length &&
      object(budgets[budgetKey]).limit !== manifest.identity.executionLimit
    )
      throw unavailable()
    const journalSessions = new Set<string>()
    for (const [key, value] of Object.entries(records)) {
      validateRecord(value)
      const record = value as ExecutionRecord
      if (
        key !== record.executionId ||
        record.requestDigest !== requestDigest(record.request) ||
        record.request.projectId !== manifest.identity.projectId ||
        record.request.origin.kind !== 'optimization' ||
        record.request.origin.optimizationId !== manifest.optimizationId ||
        record.request.budgetRef !== manifest.optimizationId
      )
        throw unavailable()
      if (record.identity.sessionId) {
        if (record.identity.promptMessageId !== `candidate-prompt-${record.executionId}`)
          throw unavailable()
        sessions.add(record.identity.sessionId)
        journalSessions.add(record.identity.sessionId)
      } else if (
        !['completed', 'failed', 'cancelled'].includes(record.phase) ||
        record.cleanup !== 'confirmed'
      ) {
        // A crash before identity publication cannot be assigned a Session from a title.
        throw unavailable()
      }
    }
    if (progress) {
      if (!Array.isArray(progress.executions)) throw unavailable()
      for (const entry of progress.executions) {
        const hint = object(entry)
        if (hint.sessionId !== undefined && !journalSessions.has(String(hint.sessionId)))
          throw unavailable()
      }
    }
  }
  return sessions
}

export function createDesktopCandidateOwnerRouting(
  readPrivateSessions: () => Promise<ReadonlySet<string>> = async () => {
    const release = acquireDataRootWriter()
    try {
      return readDesktopPrivateSessions({
        configRoot: resolveConfigRoot(),
        dataRoot: resolveDataRoot()
      })
    } finally {
      release()
    }
  }
): {
  onOwnersReady: CandidateOwnersReady
  resolveCandidateDelivery: ResolveCandidateDelivery
  resolveControlPolicy(binding: ControlBinding): Promise<TrustedControlPolicy | undefined>
  hasActiveWork(): boolean
  shutdown(): Promise<{ reaped: boolean }>
} {
  const owners = new Set<CandidateOwnerPorts>()
  const shutdowns = new Map<CandidateOwnerPorts, Promise<{ reaped: boolean }>>()
  const recognized = async (
    sessionId: string
  ): Promise<
    | {
        ports: CandidateOwnerPorts
        route: Awaited<ReturnType<ResolveCandidateDelivery>>
      }
    | undefined
  > => {
    let match: Awaited<ReturnType<typeof recognized>>
    for (const ports of owners) {
      const route = await ports.resolveCandidateDelivery?.(sessionId)
      if (!route || route.kind === 'ordinary') continue
      if (match) throw unavailable()
      match = { ports, route }
    }
    return match
  }
  return {
    onOwnersReady(ports) {
      if (owners.has(ports)) throw unavailable()
      owners.add(ports)
      return () => {
        owners.delete(ports)
      }
    },
    async resolveCandidateDelivery(sessionId) {
      try {
        const match = await recognized(sessionId)
        if (match) return match.route
        return (await readPrivateSessions()).has(sessionId)
          ? { kind: 'private-unavailable' }
          : { kind: 'ordinary' }
      } catch {
        // No claim yet: unavailable readiness queues without spending a delivery attempt.
        return { kind: 'private-unavailable' }
      }
    },
    async resolveControlPolicy(binding) {
      const match = await recognized(binding.sessionId)
      if (match) {
        if (!match.ports.resolveControlPolicy) throw unavailable()
        // Explicit undefined from this same live non-Compute owner preserves its original profile.
        return match.ports.resolveControlPolicy(binding)
      }
      let privateSessions: ReadonlySet<string>
      try {
        privateSessions = await readPrivateSessions()
      } catch {
        throw unavailable()
      }
      if (privateSessions.has(binding.sessionId)) throw unavailable()
      return undefined
    },
    hasActiveWork: () => owners.size > 0,
    async shutdown() {
      const results = await Promise.all(
        [...owners].map(async (ports) => {
          let pending = shutdowns.get(ports)
          if (!pending) {
            pending = Promise.resolve().then(() => ports.shutdown())
            shutdowns.set(ports, pending)
          }
          try {
            const result = await pending
            if (result.reaped) owners.delete(ports)
            return result.reaped
          } catch {
            return false
          } finally {
            if (shutdowns.get(ports) === pending) shutdowns.delete(ports)
          }
        })
      )
      return { reaped: results.every(Boolean) }
    }
  }
}
export type DesktopCandidateOwnerRouting = ReturnType<typeof createDesktopCandidateOwnerRouting>
