import { randomUUID } from 'node:crypto'
import type {
  ExecutionPort,
  ExecutionRequest,
  ExecutionRecord,
  ExecutionEvent,
  ExecutionIdentity,
  ExecutionEvidence,
  ExecutionUsage,
  EffectiveConfiguration,
  CleanupState,
  ExecutionPhase,
  CancellationReceipt,
  ExecutionHandle
} from '../../shared/earthnano/execution-port'
import { assertExecutionTimeout } from './execution-timeout'
import { withExecutionScope, withPhysicalCancellation } from './execution-scope'
import {
  ExecutionContractError,
  requestDigest,
  validateRequest,
  validateRecord,
  validateEvent
} from './execution-contract'

export interface ExecutionOutcome {
  phase: 'completed' | 'failed' | 'cancelled'
  cleanup: CleanupState
  evidence?: ExecutionEvidence
  usage?: ExecutionUsage
  configuration?: EffectiveConfiguration
  error?: { code: string; message: string }
}
export interface ExecutionContext {
  readonly executionId: string
  readonly signal: AbortSignal
  running(): void
  identity(value: ExecutionIdentity): void
  emit(type: 'provider-accepted' | 'session-admitted'): void
  /** Original owner may reject cancellation. No abort is published before its acknowledgment. */
  onCancellation?(handler: () => Promise<void>): () => void
}
/** Resolves only after original owners have committed their result; never owns Session/Review state. */
export interface ExecutionDriver {
  execute(request: ExecutionRequest, context: ExecutionContext): Promise<ExecutionOutcome>
}
export interface ExecutionState {
  records: Record<string, ExecutionRecord>
  events: Record<string, ExecutionEvent[]>
  sequences: Record<string, number>
  budgets: Record<string, { limit: number; admitted: number }>
}
/** Single-writer ownership is a prerequisite; commit must be atomic and durable before returning. */
export interface ExecutionStore {
  load(): ExecutionState
  commit(state: ExecutionState): void
}
export const emptyExecutionState = (): ExecutionState => ({
  records: {},
  events: {},
  sequences: {},
  budgets: {}
})
const terminal = (phase: ExecutionPhase): boolean =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(phase)
const key = (project: string, budget: string): string => JSON.stringify([project, budget])
const clone = <T>(value: T): T => structuredClone(value)
function validateState(state: ExecutionState): void {
  const invalid = (): never => {
    throw new Error('Invalid execution journal')
  }
  if (!state || !state.records || !state.events || !state.sequences || !state.budgets) invalid()
  for (const map of [state.records, state.events, state.sequences, state.budgets]) {
    if (typeof map !== 'object' || Array.isArray(map)) invalid()
  }
  if (
    Object.keys(state.events).length !== Object.keys(state.records).length ||
    Object.keys(state.sequences).length !== Object.keys(state.records).length
  )
    invalid()
  for (const budget of Object.values(state.budgets)) {
    if (
      !budget ||
      !Number.isSafeInteger(budget.limit) ||
      !Number.isSafeInteger(budget.admitted) ||
      budget.limit < 0 ||
      budget.admitted < 0 ||
      budget.admitted > budget.limit
    )
      invalid()
  }
  const requests = new Set<string>()
  const admitted = new Map<string, number>()
  for (const [id, record] of Object.entries(state.records)) {
    validateRecord(record)
    if (
      record.executionId !== id ||
      record.requestKey !== record.request.requestKey ||
      record.requestDigest !== requestDigest(record.request)
    )
      invalid()
    const requestKey = key(record.request.projectId, record.requestKey)
    if (requests.has(requestKey)) invalid()
    requests.add(requestKey)
    const events = state.events[id]
    if (!Array.isArray(events) || !events.length || !Number.isSafeInteger(state.sequences[id]))
      invalid()
    let sequence = events[0].sequence - 1
    for (const event of events) {
      validateEvent(event)
      if (event.executionId !== id || event.sequence !== ++sequence) invalid()
    }
    if (sequence !== state.sequences[id]) invalid()
    if (!Object.hasOwn(state.budgets, key(record.request.projectId, record.request.budgetRef)))
      invalid()
    const budgetKey = key(record.request.projectId, record.request.budgetRef)
    admitted.set(budgetKey, (admitted.get(budgetKey) ?? 0) + 1)
  }
  for (const [budgetKey, budget] of Object.entries(state.budgets)) {
    if (budget.admitted !== (admitted.get(budgetKey) ?? 0)) invalid()
  }
}

/** Internal execution owner. No renderer/HTTP wiring or automatic optimization is installed here. */
export class ExecutionCore implements ExecutionPort {
  private state: ExecutionState
  private controllers = new Map<string, AbortController>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private disposed = false
  private readonly concurrency: number
  private drainScheduled = false
  private readonly drivers = new Set<Promise<void>>()
  private readonly cancellationOwners = new Map<string, () => Promise<void>>()
  private readonly cancellations = new Map<string, Promise<CancellationReceipt>>()
  private readonly observations = new Map<string, Set<string>>()
  private readonly terminalWaiters = new Map<string, Set<(record: ExecutionRecord) => void>>()

  constructor(
    private readonly store: ExecutionStore,
    private readonly driver: ExecutionDriver,
    private readonly eventLimit = 256,
    options: { concurrency?: number } = {}
  ) {
    if (!Number.isSafeInteger(eventLimit) || eventLimit < 1) throw new Error('Invalid event limit')
    if (
      options.concurrency !== undefined &&
      (!Number.isSafeInteger(options.concurrency) ||
        options.concurrency < 1 ||
        options.concurrency > 4)
    )
      throw new Error('Invalid execution concurrency')
    this.concurrency = options.concurrency ?? Infinity
    this.state = clone(store.load())
    validateState(this.state)
    // Recovery is called only after the caller has acquired exclusive store/runtime ownership.
    this.change((state) => {
      for (const record of Object.values(state.records)) {
        if (!terminal(record.phase)) {
          record.phase = 'interrupted'
          record.cleanup = 'unknown'
          record.error = {
            code: 'process_restarted',
            message: 'Prior outcome must be reconciled; no automatic replay'
          }
          this.append(state, record, { type: 'phase', phase: 'interrupted' })
        }
      }
    })
  }

  /** This round enforces an admission-count cap, not a currency/token billing ceiling. */
  configureBudget(projectId: string, budgetRef: string, limit: number): void {
    this.assertOpen()
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid budget')
    this.change((state) => {
      const id = key(projectId, budgetRef)
      const admitted = state.budgets[id]?.admitted ?? 0
      if (limit < admitted) throw new Error('Budget below existing reservations')
      state.budgets[id] = { limit, admitted }
    })
  }

  async submit(input: ExecutionRequest): Promise<ExecutionHandle> {
    this.assertOpen()
    validateRequest(input)
    const request = clone(input)
    const digest = requestDigest(request)
    const prior = Object.values(this.state.records).find(
      (r) => r.request.projectId === request.projectId && r.requestKey === request.requestKey
    )
    if (prior) {
      if (prior.requestDigest !== digest)
        throw new ExecutionContractError('request-conflict', 'requestKey has different content')
      return this.handle(prior)
    }
    const budget = this.state.budgets[key(request.projectId, request.budgetRef)]
    if (!budget || budget.admitted >= budget.limit) {
      throw new ExecutionContractError('budget-exhausted', 'No admission budget available')
    }
    if (
      Object.values(this.state.records).some(
        (r) =>
          r.request.projectId === request.projectId &&
          r.cleanup === 'unknown' &&
          r.request.environmentSpecRef.id === request.environmentSpecRef.id
      )
    ) {
      throw new ExecutionContractError(
        'cleanup-unconfirmed',
        'Environment remains fenced pending reconciliation'
      )
    }
    const now = new Date().toISOString()
    const record: ExecutionRecord = {
      executionId: randomUUID(),
      requestKey: request.requestKey,
      phase: 'queued',
      identity: {},
      request,
      requestDigest: digest,
      createdAt: now,
      updatedAt: now,
      cleanup: 'pending',
      cancellationRequested: false,
      evidence: {
        status: 'unavailable',
        scope: 'declared-public-output',
        text: '',
        artifacts: [],
        references: [],
        limitations: []
      },
      usage: { status: 'unknown' },
      configuration: {
        status: 'unknown',
        requestedDigest: request.harnessRevisionRef.digest,
        instructions: [],
        skills: [],
        tools: [],
        confirmation: 'Not yet observed'
      }
    }
    this.change((state) => {
      state.budgets[key(request.projectId, request.budgetRef)].admitted++
      state.records[record.executionId] = record
      this.append(state, record, { type: 'phase', phase: 'queued' })
    })
    // A durable handle is observable before any provider work begins.
    this.scheduleDrain()
    return this.handle(record)
  }

  async get(id: string): Promise<ExecutionRecord> {
    this.assertOpen()
    return clone(this.require(id))
  }

  /** Internal owner barrier; unlike event replay this waits without polling or provider work. */
  waitForTerminal(id: string): Promise<ExecutionRecord> {
    this.assertOpen()
    const record = this.require(id)
    if (terminal(record.phase)) return Promise.resolve(clone(record))
    return new Promise((resolve) => {
      const waiters = this.terminalWaiters.get(id) ?? new Set()
      waiters.add(resolve)
      this.terminalWaiters.set(id, waiters)
    })
  }

  async cancel(id: string): Promise<CancellationReceipt> {
    this.assertOpen()
    const record = this.require(id)
    if (record.cancellationRequested && !terminal(record.phase))
      return { executionId: id, status: 'requested', cleanup: record.cleanup }
    if (terminal(record.phase))
      return {
        executionId: id,
        status: record.phase === 'cancelled' ? 'cancelled' : 'already-terminal',
        cleanup: record.cleanup
      }
    const pending = this.cancellations.get(id)
    if (pending) return pending
    const cancellation = this.cancelOwned(id)
    this.cancellations.set(id, cancellation)
    try {
      return await cancellation
    } finally {
      this.cancellations.delete(id)
    }
  }

  private async cancelOwned(id: string): Promise<CancellationReceipt> {
    const owner = this.cancellationOwners.get(id)
    if (owner) await withPhysicalCancellation(owner)
    // The owner may have completed while its cancellation acknowledgment was in flight.
    const settled = this.require(id)
    if (terminal(settled.phase))
      return {
        executionId: id,
        status: settled.phase === 'cancelled' ? 'cancelled' : 'already-terminal',
        cleanup: settled.cleanup
      }
    this.change((state) => {
      const current = state.records[id]
      current.cancellationRequested = true
      if (current.phase === 'queued') {
        current.phase = 'cancelled'
        current.cleanup = 'confirmed'
        this.append(state, current, { type: 'phase', phase: 'cancelled' })
      }
    })
    this.controllers.get(id)?.abort()
    const current = this.require(id)
    return {
      executionId: id,
      status: current.phase === 'cancelled' ? 'cancelled' : 'requested',
      cleanup: current.cleanup
    }
  }

  async *events(id: string, afterSequence = 0): AsyncIterable<ExecutionEvent> {
    this.assertOpen()
    this.require(id)
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      afterSequence > this.state.sequences[id]
    ) {
      throw new ExecutionContractError('invalid-cursor', 'Cursor outside this execution')
    }
    const events = clone(this.state.events[id] ?? [])
    if (events.length && afterSequence < events[0].sequence - 1) {
      yield {
        executionId: id,
        sequence: events[0].sequence - 1,
        type: 'gap',
        time: events[0].time,
        gapAfter: afterSequence
      }
    }
    for (const event of events) if (event.sequence > afterSequence) yield event
  }

  /** After admission is stopped and queued work cancelled, wait for original result owners to
   * finish committing. Process retirement alone does not attest to those durable terminal facts.
   * A timeout never confirms cleanup or releases a fenced execution. */
  async settle(timeoutMs = 25_000): Promise<boolean> {
    assertExecutionTimeout(timeoutMs)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.allSettled([...this.drivers]).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Retires this owner for controlled restart. Late driver callbacks cannot write to the store. */
  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
    this.timers.clear()
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Execution owner disposed')
  }
  private require(id: string): ExecutionRecord {
    if (!Object.hasOwn(this.state.records, id))
      throw new ExecutionContractError('not-found', 'Unknown execution')
    const record = this.state.records[id]
    if (!record) throw new ExecutionContractError('not-found', 'Unknown execution')
    return record
  }
  private handle(record: ExecutionRecord): ExecutionHandle {
    return clone({
      executionId: record.executionId,
      requestKey: record.requestKey,
      phase: record.phase,
      identity: record.identity
    })
  }
  private change(change: (next: ExecutionState) => void): void {
    const next = clone(this.state)
    change(next)
    try {
      this.store.commit(next)
    } catch (error) {
      // After an ambiguous disk failure, retire the owner instead of executing against stale state.
      this.dispose()
      throw error
    }
    this.state = next
    for (const [id, waiters] of this.terminalWaiters) {
      const record = next.records[id]
      if (!record || !terminal(record.phase)) continue
      this.terminalWaiters.delete(id)
      for (const resolve of waiters) resolve(clone(record))
    }
  }
  private append(
    state: ExecutionState,
    record: ExecutionRecord,
    data: Pick<ExecutionEvent, 'type'> & Partial<ExecutionEvent>
  ): void {
    const id = record.executionId
    record.updatedAt = new Date().toISOString()
    const sequence = (state.sequences[id] ?? 0) + 1
    state.sequences[id] = sequence
    const event: ExecutionEvent = { ...data, executionId: id, sequence, time: record.updatedAt }
    state.events[id] = [...(state.events[id] ?? []), event].slice(-this.eventLimit)
  }
  private active(id: string): boolean {
    return !this.disposed && !terminal(this.require(id).phase)
  }
  private scheduleDrain(): void {
    if (this.disposed || this.drainScheduled) return
    this.drainScheduled = true
    setImmediate(() => {
      this.drainScheduled = false
      if (this.disposed) return
      for (const record of Object.values(this.state.records)) {
        if (this.controllers.size >= this.concurrency) break
        if (this.require(record.executionId).phase !== 'queued') continue
        if (
          Object.values(this.state.records).some(
            (entry) =>
              entry.cleanup === 'unknown' &&
              entry.request.projectId === record.request.projectId &&
              entry.request.environmentSpecRef.id === record.request.environmentSpecRef.id
          )
        )
          continue
        const driver = this.drive(record.executionId)
        this.drivers.add(driver)
        void driver.then(
          () => this.drivers.delete(driver),
          () => this.drivers.delete(driver)
        )
      }
    })
  }
  private async drive(id: string): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(id, controller)
    try {
      this.change((state) => {
        state.records[id].phase = 'preparing'
        this.append(state, state.records[id], { type: 'phase', phase: 'preparing' })
      })
      if (this.require(id).request.timeoutMs > 0)
        this.timers.set(
          id,
          setTimeout(() => {
            if (!this.active(id)) return
            try {
              this.finish(id, {
                phase: 'interrupted',
                cleanup: 'unknown',
                error: { code: 'timeout', message: 'Deadline exceeded; cleanup unconfirmed' }
              })
            } catch {
              // change() has retired the owner on persistence failure; callers must reconcile storage.
            } finally {
              controller.abort()
            }
          }, this.require(id).request.timeoutMs)
        )
      const context: ExecutionContext = {
        executionId: id,
        signal: controller.signal,
        running: () => {
          if (!this.active(id) || this.require(id).phase === 'running') return
          this.change((state) => {
            state.records[id].phase = 'running'
            this.append(state, state.records[id], { type: 'phase', phase: 'running' })
          })
        },
        identity: (value) => {
          if (!this.active(id)) return
          this.change((state) => {
            const record = state.records[id]
            for (const [field, newValue] of Object.entries(value)) {
              const old = record.identity[field as keyof ExecutionIdentity]
              if (old !== undefined && old !== newValue)
                throw new Error('Identity cannot be overwritten')
            }
            Object.assign(record.identity, value)
            this.append(state, record, { type: 'identity', identity: clone(record.identity) })
          })
        },
        emit: (type) => {
          const observed = this.observations.get(id) ?? new Set<string>()
          if (this.active(id) && !observed.has(type)) {
            this.change((state) => this.append(state, state.records[id], { type }))
            observed.add(type)
            this.observations.set(id, observed)
          }
        },
        onCancellation: (handler) => {
          if (this.cancellationOwners.has(id))
            throw new Error('Execution already has a cancellation owner')
          this.cancellationOwners.set(id, handler)
          return () => {
            if (this.cancellationOwners.get(id) === handler) this.cancellationOwners.delete(id)
          }
        }
      }
      const request = clone(this.require(id).request)
      const outcome = await withExecutionScope(
        {
          core: this,
          request,
          context,
          identity: () => clone(this.require(id).identity)
        },
        () => this.driver.execute(request, context)
      )
      if (!this.active(id)) return
      if (!['completed', 'failed', 'cancelled'].includes(outcome.phase)) {
        throw new Error('Driver returned a nonterminal outcome')
      }
      if (outcome.phase === 'completed' && this.require(id).phase !== 'running')
        throw new Error('Driver completed before running')
      this.finish(id, outcome)
    } catch (error) {
      if (this.active(id))
        this.finish(id, {
          phase: 'failed',
          cleanup: 'unknown',
          error: {
            code: 'driver-failed',
            message: error instanceof Error ? error.message : String(error)
          }
        })
    } finally {
      clearTimeout(this.timers.get(id))
      this.timers.delete(id)
      this.cancellationOwners.delete(id)
      this.observations.delete(id)
      // A terminal record with unknown cleanup still occupies capacity. A late success cannot
      // reconcile a timeout: that requires explicit owner-level reconciliation.
      if (!this.disposed && this.require(id).cleanup === 'confirmed') this.controllers.delete(id)
      this.scheduleDrain()
    }
  }
  private finish(
    id: string,
    outcome: Omit<ExecutionOutcome, 'phase'> & { phase: ExecutionPhase }
  ): void {
    this.change((state) => {
      const record = state.records[id]
      Object.assign(record, clone(outcome))
      validateRecord(record)
      if (record.configuration.requestedDigest !== record.request.harnessRevisionRef.digest) {
        throw new Error('Configuration receipt does not match requested harness')
      }
      if (outcome.evidence)
        this.append(state, record, { type: 'evidence', evidence: clone(outcome.evidence) })
      this.append(state, record, { type: 'phase', phase: outcome.phase })
    })
  }
}
