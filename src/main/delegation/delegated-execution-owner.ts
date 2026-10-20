import type { AcpPromptRequest } from '../../shared/acp'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ExecutionRecord, ExecutionRequest, Ref } from '../../shared/earthnano/execution-port'
import {
  ExecutionCore,
  type ExecutionContext,
  type ExecutionOutcome
} from '../earthnano/execution-core'
import { currentExecutionScope, findExecutionScope } from '../earthnano/execution-scope'
import { FileExecutionStore } from '../earthnano/execution-store'
import {
  originalEvidenceCanonical,
  originalEvidenceDigest
} from '../earthnano/original-turn-evidence'

/** Original delegation supplies facts and physical controls; shared Core decides execution lifecycle. */
export interface DelegatedExecutionOwner {
  run(
    work: (context: ExecutionContext) => Promise<void>,
    readResult: () => ExecutionOutcome,
    cancelOriginal: () => Promise<void>
  ): Promise<ExecutionRecord>
  cancel(cancelOriginal: () => Promise<void>): Promise<void>
  activateTurn(provenance: AcpPromptRequest['provenanceContext']): void
  ownsExecution(executionId: string): boolean
  ownsTurn(provenance: AcpPromptRequest['provenanceContext']): boolean
}

export interface DelegatedExecutionDeclaration {
  projectId: string
  sourceSessionId: string
  parentPromptMessageId: string
  frameId: string
  attemptId: string
  runtimeSegmentId: string
  permissionPrompts?: 'none'
  task: string
  inputs: readonly string[]
  outputSchema?: unknown
  workspaceCwd: string
  frameworkId: string
  model?: unknown
}

const ref = (id: string, value: unknown): Ref => ({
  id,
  version: '1',
  digest: originalEvidenceDigest(originalEvidenceCanonical(value))
})

export function createDelegatedExecutionOwner(
  dataRoot: string,
  input: DelegatedExecutionDeclaration
): DelegatedExecutionOwner {
  const declaration = structuredClone(input)
  const parent =
    currentExecutionScope() ??
    findExecutionScope({
      projectId: declaration.projectId,
      sessionId: declaration.sourceSessionId,
      promptMessageId: declaration.parentPromptMessageId
    })
  const parentExecutionId =
    parent?.request.projectId === declaration.projectId &&
    parent.identity().sessionId === declaration.sourceSessionId &&
    parent.identity().promptMessageId === declaration.parentPromptMessageId
      ? parent.context.executionId
      : undefined
  const mission = originalEvidenceDigest(
    originalEvidenceCanonical({
      projectId: declaration.projectId,
      sessionId: declaration.sourceSessionId,
      frameId: declaration.frameId,
      attemptId: declaration.attemptId
    })
  )
  const request: ExecutionRequest = {
    contractVersion: 1,
    requestKey: `delegate:${mission}`,
    projectId: declaration.projectId,
    taskSnapshotRef: ref(`delegate-task:${mission}`, {
      task: declaration.task,
      inputs: declaration.inputs,
      outputSchema: declaration.outputSchema
    }),
    invocationRef: ref(`delegate-invocation:${mission}`, {
      sourceSessionId: declaration.sourceSessionId,
      parentPromptMessageId: declaration.parentPromptMessageId,
      frameId: declaration.frameId,
      runtimeSegmentId: declaration.runtimeSegmentId
    }),
    agentSpecRef: ref(`delegate-agent:${mission}`, {
      frameworkId: declaration.frameworkId,
      model: declaration.model
    }),
    harnessRevisionRef: ref(`delegate-config:${mission}`, {
      frameworkId: declaration.frameworkId,
      model: declaration.model
    }),
    environmentSpecRef: ref(`delegate-environment:${mission}`, { cwd: declaration.workspaceCwd }),
    role: 'task',
    origin: {
      kind: 'automation',
      sessionId: declaration.sourceSessionId,
      ...(parentExecutionId ? { parentExecutionId } : {})
    },
    interactionPolicy: declaration.permissionPrompts === 'none' ? 'deny-unresolved' : 'interactive',
    budgetRef: `delegate:${mission}`,
    timeoutMs: 0
  }
  let core: ExecutionCore | undefined
  let executionId: string | undefined
  let activeExecutionId: string | undefined
  let activeTurn: AcpPromptRequest['provenanceContext']
  return {
    async run(work, readResult, cancelOriginal) {
      if (core) throw new Error('Delegated mission already admitted')
      const store = new FileExecutionStore(
        join(dataRoot, 'delegation', 'executions', mission, `${randomUUID()}.json`)
      )
      let driverDone!: () => void
      const done = new Promise<void>((resolve) => {
        driverDone = resolve
      })
      core = new ExecutionCore(store, {
        async execute(_request, context) {
          activeExecutionId = context.executionId
          const removeCancellation = context.onCancellation?.(cancelOriginal)
          try {
            await work(context)
            return readResult()
          } finally {
            removeCancellation?.()
            driverDone()
          }
        }
      })
      try {
        core.configureBudget(request.projectId, request.budgetRef, 1)
        const handle = await core.submit(request)
        executionId = handle.executionId
        await done
        if (!(await core.settle())) throw new Error('Delegated execution owner did not settle')
        const record = await core.get(executionId)
        if (record.cleanup === 'confirmed') store.close()
        return record
      } finally {
        activeExecutionId = undefined
        activeTurn = undefined
        core.dispose()
      }
    },
    activateTurn(provenance) {
      if (!activeExecutionId) throw new Error('Delegated mission is not active')
      activeTurn = structuredClone(provenance)
    },
    ownsExecution(id) {
      return activeExecutionId === id
    },
    ownsTurn(provenance) {
      return (
        !!activeTurn &&
        !!provenance &&
        provenance.agentFrameId === declaration.frameId &&
        provenance.promptMessageId === activeTurn.promptMessageId &&
        provenance.runtimeSegmentId === activeTurn.runtimeSegmentId &&
        provenance.agentFrameId === activeTurn.agentFrameId
      )
    },
    async cancel(cancelOriginal) {
      if (core && executionId) await core.cancel(executionId)
      else await cancelOriginal()
    }
  }
}
