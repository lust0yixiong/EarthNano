import {
  MAX_SWEEP_EXECUTIONS,
  normalizeOptimizationCatalog,
  normalizeOptimizationSweep,
  type StartDesktopSweep,
  type OptimizationSweepTask
} from '../../shared/earthnano/optimization-sweep'
import { normalizeOptimizationArtifactInputs } from '../../shared/earthnano/optimization-input'
import { normalizeNotebookOptimizationSource } from '../../shared/earthnano/notebook-source'
import {
  normalizeOptimizationDomain,
  normalizeOutputChecks
} from '../../shared/earthnano/research-outcome'
import { semanticCriteria } from './semantic-evaluation'

const fail = (): never => {
  throw new Error('Invalid desktop optimization sweep')
}
const object = (
  value: unknown,
  required: string[],
  optional: string[] = []
): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail()
  const result = value as Record<string, unknown>
  if (
    required.some((key) => !Object.hasOwn(result, key)) ||
    Object.keys(result).some((key) => ![...required, ...optional].includes(key))
  )
    return fail()
  return result
}
const id = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : fail()

/** Validate every public task before original task_stream filters it. Source authority is still
 * granted independently by Main only for selected tasks, never by this structural parser. */
export function normalizeDesktopSweep(value: unknown): StartDesktopSweep {
  const request = object(
    value,
    ['projectId', 'sourceSessionId', 'requestKey', 'catalog', 'sweep', 'executionLimit'],
    ['previewPlanDigest']
  )
  if (
    Object.hasOwn(request, 'previewPlanDigest') &&
    (typeof request.previewPlanDigest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(request.previewPlanDigest))
  )
    return fail()
  if (!Array.isArray(request.catalog)) return fail()
  const identities = normalizeOptimizationCatalog(
    request.catalog.map((item) => {
      const task = object(
        item,
        ['taskId', 'domain', 'sourceSessionId', 'source', 'criteria'],
        ['checks']
      )
      return { taskId: task.taskId, domain: task.domain }
    })
  )
  const catalog = request.catalog.map((item, index): OptimizationSweepTask => {
    const task = object(
      item,
      ['taskId', 'domain', 'sourceSessionId', 'source', 'criteria'],
      ['checks']
    )
    if (typeof task.criteria !== 'string' || task.criteria.length > 16000) return fail()
    semanticCriteria(task.criteria)
    const checks = normalizeOutputChecks(task.checks)
    const source = object(
      task.source,
      ['kind'],
      ['promptMessageId', 'prompt', 'files', 'inputArtifacts']
    )
    let normalized: OptimizationSweepTask['source']
    if (source.kind === 'notebook') {
      object(source, ['kind', 'promptMessageId'])
      const notebook = normalizeNotebookOptimizationSource({
        promptMessageId: source.promptMessageId
      })!
      normalized = { kind: 'notebook', ...notebook }
    } else if (source.kind === 'text') {
      object(source, ['kind', 'prompt', 'files'], ['inputArtifacts'])
      const domain = normalizeOptimizationDomain({
        name: identities[index].domain,
        nextTasks: [
          {
            prompt: source.prompt,
            files: source.files,
            criteria: task.criteria,
            ...(checks ? { checks } : {})
          }
        ]
      })!
      const text = domain.nextTasks[0]
      const inputArtifacts = normalizeOptimizationArtifactInputs(source.inputArtifacts)
      if (text.files.length + (inputArtifacts?.length ?? 0) > 32) return fail()
      const paths = [
        ...text.files.map((file) => file.path),
        ...(inputArtifacts ?? []).map((file) => file.path)
      ].map((path) => path.normalize('NFC').toLowerCase())
      if (
        new Set(paths).size !== paths.length ||
        paths.some((path, index) =>
          paths.some((other, otherIndex) => index !== otherIndex && path.startsWith(other + '/'))
        )
      )
        return fail()
      normalized = {
        kind: 'text',
        prompt: text.prompt,
        files: text.files,
        ...(inputArtifacts ? { inputArtifacts } : {})
      }
    } else return fail()
    return {
      ...identities[index],
      sourceSessionId: id(task.sourceSessionId),
      source: normalized,
      criteria: task.criteria,
      ...(checks ? { checks } : {})
    }
  })
  if (
    !Number.isSafeInteger(request.executionLimit) ||
    (request.executionLimit as number) < 1 ||
    (request.executionLimit as number) > MAX_SWEEP_EXECUTIONS
  )
    return fail()
  return {
    projectId: id(request.projectId),
    sourceSessionId: id(request.sourceSessionId),
    requestKey: id(request.requestKey),
    ...(Object.hasOwn(request, 'previewPlanDigest')
      ? { previewPlanDigest: request.previewPlanDigest as string }
      : {}),
    catalog,
    sweep: normalizeOptimizationSweep(request.sweep),
    executionLimit: request.executionLimit as number
  }
}
