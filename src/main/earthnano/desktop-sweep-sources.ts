import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ComputeHostRepository } from '@aipoch/compute'
import type { OptimizationSweepTask } from '../../shared/earthnano/optimization-sweep'
import { notebookToolsForLanguage } from '../../shared/earthnano/notebook-profile'
import type { ManagedFileVersionReadPort } from '../managed-file-versions/read-port'
import type { PersistentCandidateNotebookOptions } from './persistent-candidate-owner'
import type { ResolvedSweepTask } from './sweep-contract'
import type { CandidateSnapshotInput } from './candidate-snapshot'
import { notebookOptimizationLanguage } from '../../shared/earthnano/notebook-source'
import {
  resolveOptimizationNotebookInputs,
  resolveOptimizationComputeInputs,
  resolveOptimizationNotebookRuntime
} from './optimization-notebook-input'
import { resolveOptimizationArtifactInputs } from './optimization-input'
import { freezeComputeContext } from './compute-context'

/** One selected task's original source authority. The caller owns source-Session deletion admission
 * and the data-root lease; original version readers close every individual immutable read lease. */
export async function resolveDesktopSweepTask(options: {
  projectId: string
  task: OptimizationSweepTask
  agent: CandidateSnapshotInput['agent']
  harness: Pick<CandidateSnapshotInput['harness'], 'instructions' | 'skills'>
  loadSession(projectId: string, sessionId: string): Promise<PersistedChatSession>
  versions: Pick<ManagedFileVersionReadPort, 'openVersion'>
  notebook?: PersistentCandidateNotebookOptions
  compute?: { hosts: Pick<ComputeHostRepository, 'get'> }
  signal?: AbortSignal
}): Promise<ResolvedSweepTask> {
  const { task, projectId, signal } = options
  signal?.throwIfAborted()
  const source = await options.loadSession(projectId, task.sourceSessionId)
  signal?.throwIfAborted()
  if (
    source.projectId !== projectId ||
    source.id !== task.sourceSessionId ||
    source.archivedAt ||
    source.packageOrigin
  )
    throw new Error('Sweep source Session unavailable')
  const common = {
    taskId: task.taskId,
    domain: task.domain,
    sourceSessionId: task.sourceSessionId,
    criteria: task.criteria,
    ...(task.checks ? { checks: structuredClone(task.checks) } : {})
  }
  if (task.source.kind === 'text') {
    const files = task.source.inputArtifacts?.length
      ? await resolveOptimizationArtifactInputs({
          projectId,
          sourceSessionId: task.sourceSessionId,
          artifacts: task.source.inputArtifacts,
          files: task.source.files,
          loadSession: async () => source,
          versions: options.versions
        })
      : structuredClone(task.source.files)
    signal?.throwIfAborted()
    return {
      ...common,
      ...(task.source.inputArtifacts
        ? { inputArtifacts: structuredClone(task.source.inputArtifacts) }
        : {}),
      input: {
        task: { prompt: task.source.prompt, files },
        agent: structuredClone(options.agent),
        harness: { ...structuredClone(options.harness), tools: 'workspace-only' },
        environment: { isolation: 'directory-process', network: 'provider-only' }
      }
    }
  }
  if (!options.notebook) throw new Error('Original Notebook owner unavailable')
  const notebookSource = task.source
  const messages = source.conversationGraph
    ? resolveActiveConversationMessages(source.conversationGraph)
    : source.messages
  const message = messages.find((entry) => entry.id === notebookSource.promptMessageId)
  if (!message) throw new Error('Original Notebook source message unavailable')
  const resolveInputs =
    task.source.kind === 'compute'
      ? resolveOptimizationComputeInputs
      : resolveOptimizationNotebookInputs
  const managedInputs = await resolveInputs({
    projectId,
    sourceSessionId: task.sourceSessionId,
    source: { promptMessageId: notebookSource.promptMessageId },
    prompt: message.content,
    loadSession: async () => source,
    versions: options.versions,
    signal
  })
  if (task.source.kind === 'compute') {
    if (!options.compute) throw new Error('Original Compute owner unavailable')
    const compute = await freezeComputeContext({ source, hosts: options.compute.hosts })
    signal?.throwIfAborted()
    return {
      ...common,
      sourcePromptMessageId: notebookSource.promptMessageId,
      input: {
        task: { prompt: message.content, files: [], managedInputs },
        agent: structuredClone(options.agent),
        harness: { ...structuredClone(options.harness), tools: 'notebook-compute' },
        environment: {
          isolation: 'directory-process',
          network: 'provider-and-notebook-policy',
          compute
        }
      }
    }
  }
  const language = notebookOptimizationLanguage(notebookSource)
  const runtime = await resolveOptimizationNotebookRuntime({
    service: options.notebook.service,
    projectId,
    source,
    language,
    signal
  })
  if (!runtime)
    throw new Error(
      `Notebook task requires its own enabled ${language === 'r' ? 'R' : 'Python'} binding`
    )
  signal?.throwIfAborted()
  return {
    ...common,
    sourcePromptMessageId: notebookSource.promptMessageId,
    input: {
      task: { prompt: message.content, files: [], managedInputs },
      agent: structuredClone(options.agent),
      harness: { ...structuredClone(options.harness), tools: notebookToolsForLanguage(language) },
      environment: {
        isolation: 'directory-process',
        network: 'provider-and-notebook-policy',
        notebook: { runtime }
      }
    }
  }
}
