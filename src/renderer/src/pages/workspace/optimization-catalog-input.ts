import type { NotebookLanguage } from '../../../../shared/notebook-language-contract'
import {
  normalizeOptimizationArtifactInputs,
  type OptimizationArtifactInput
} from '../../../../shared/earthnano/optimization-input'
import { normalizeOptimizationDomain } from '../../../../shared/earthnano/research-outcome'
import {
  draftOutputChecks,
  emptyJsonCheckDraft,
  type JsonCheckDraft
} from './optimization-research-input'

export interface CatalogTaskDraft {
  id: string
  taskId: string
  domain: string
  kind: 'text' | 'notebook'
  sourceSessionId: string
  promptMessageId: string
  language: NotebookLanguage
  sourceReady: boolean
  prompt: string
  criteria: string
  files: Array<{ path: string; content: string }>
  inputArtifacts: OptimizationArtifactInput[]
  check: JsonCheckDraft
}
export function newCatalogTask(
  taskId: string,
  domain: string,
  sourceSessionId: string,
  kind: CatalogTaskDraft['kind']
): CatalogTaskDraft {
  return {
    id: crypto.randomUUID(),
    taskId,
    domain,
    kind,
    sourceSessionId,
    promptMessageId: '',
    language: 'python',
    sourceReady: false,
    prompt: '',
    criteria: '',
    files: [],
    inputArtifacts: [],
    check: emptyJsonCheckDraft()
  }
}
export function catalogTaskInput(
  task: CatalogTaskDraft
): import('../../../../shared/earthnano/optimization-sweep').OptimizationSweepTask {
  const checks = draftOutputChecks(task.check)
  const validated = normalizeOptimizationDomain({
    name: task.domain,
    nextTasks: [
      {
        prompt: task.kind === 'notebook' ? 'Original Notebook source' : task.prompt,
        criteria: task.criteria,
        files: task.kind === 'notebook' ? [] : task.files,
        ...(checks ? { checks } : {})
      }
    ]
  })!.nextTasks[0]
  if (
    task.kind === 'notebook' &&
    (!task.sourceReady || !task.sourceSessionId || !task.promptMessageId)
  )
    throw new Error('Original source unavailable')
  const refs = normalizeOptimizationArtifactInputs(task.inputArtifacts)
  const paths = [...task.files.map((f) => f.path), ...(refs ?? []).map((f) => f.path)].map((p) =>
    p.normalize('NFC').toLowerCase()
  )
  if (
    paths.length > 32 ||
    paths.some((p, i) => paths.some((q, j) => i !== j && (p === q || p.startsWith(q + '/'))))
  )
    throw new Error('Input paths collide')
  return {
    taskId: task.taskId,
    domain: task.domain,
    sourceSessionId: task.sourceSessionId,
    criteria: validated.criteria,
    ...(checks ? { checks } : {}),
    source:
      task.kind === 'notebook'
        ? { kind: 'notebook', promptMessageId: task.promptMessageId, language: task.language }
        : {
            kind: 'text',
            prompt: validated.prompt,
            files: structuredClone(validated.files),
            ...(refs?.length ? { inputArtifacts: refs } : {})
          }
  }
}
export async function appendTextFiles(
  files: CatalogTaskDraft['files'],
  selected: FileList
): Promise<CatalogTaskDraft['files']> {
  const next = structuredClone(files)
  for (const file of Array.from(selected)) {
    if (
      !/^[A-Za-z0-9_. -]{1,180}$/.test(file.name) ||
      file.name === '.' ||
      file.name === '..' ||
      !/\.(txt|md|csv|tsv|json|ya?ml|log)$/i.test(file.name) ||
      file.size > 64000 ||
      next.some(
        (f) => f.path.normalize('NFC').toLowerCase() === file.name.normalize('NFC').toLowerCase()
      )
    )
      throw new Error('Unsupported text file')
    const content = await file.text()
    if (content.includes('\0') || content.includes('\uFFFD'))
      throw new Error('Unsupported text encoding')
    next.push({ path: file.name, content })
  }
  if (
    next.length > 32 ||
    next.reduce((n, f) => n + new TextEncoder().encode(f.content).byteLength, 0) > 128000
  )
    throw new Error('Text inputs exceed limit')
  return next
}
