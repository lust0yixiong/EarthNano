import type { HarnessOptimizationBindingOptions } from './harness-optimization'
import { HarnessOptimizationBinding } from './harness-optimization'
import type { ExecutionRequest } from '../../shared/earthnano/execution-port'

/** Routes each task through the existing binding. Execution ownership is not inferred from
 * taskSnapshotRef: two distinct tasks may deliberately have identical input bytes. */
export class HarnessDomainBinding {
  private readonly bindings = new Map<string, HarnessOptimizationBinding>()
  private readonly requests = new Map<string, HarnessOptimizationBinding>()
  private readonly executions = new Map<string, HarnessOptimizationBinding>()
  private stopped = false
  constructor(tasks: HarnessOptimizationBindingOptions[]) {
    for (const task of tasks) {
      if (this.bindings.has(task.taskId)) throw new Error('Duplicate domain task identity')
      this.bindings.set(task.taskId, new HarnessOptimizationBinding(task))
    }
  }
  get executionIds(): string[] {
    return [...this.executions.keys()]
  }
  executionIdsForTask(taskId: string): string[] {
    return this.bindings.get(taskId)?.executionIds ?? []
  }
  async stop(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.bindings.values()].map((binding) => binding.stop()))
  }
  async dispatch(operation: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.stopped) throw new Error('Domain binding stopped')
    if (operation === 'freezeInvocation') {
      const taskId = (args.invocation as { taskId?: string } | undefined)?.taskId
      const binding = taskId ? this.bindings.get(taskId) : undefined
      if (!binding) throw new Error('Unknown domain task')
      const request = (await binding.dispatch(operation, args)) as ExecutionRequest
      this.requests.set(request.requestKey, binding)
      return request
    }
    if (operation === 'submit') {
      const request = args.request as ExecutionRequest | undefined
      const binding = request ? this.requests.get(request.requestKey) : undefined
      if (!binding) throw new Error('Unowned domain request')
      const handle = (await binding.dispatch(operation, args)) as { executionId: string }
      this.executions.set(handle.executionId, binding)
      return handle
    }
    const binding =
      typeof args.executionId === 'string' ? this.executions.get(args.executionId) : undefined
    if (!binding) throw new Error('Unowned domain execution')
    return binding.dispatch(operation, args)
  }
}
