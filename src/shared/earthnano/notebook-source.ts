/** A source-message identity, never renderer-supplied paths, inputs or runtime authority. */
export interface NotebookOptimizationSource {
  promptMessageId: string
}
export function normalizeNotebookOptimizationSource(
  value: unknown
): NotebookOptimizationSource | undefined {
  if (value === undefined) return undefined
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'promptMessageId') ||
    typeof (value as NotebookOptimizationSource).promptMessageId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test((value as NotebookOptimizationSource).promptMessageId)
  )
    throw new Error('Invalid Notebook source message')
  return { promptMessageId: (value as NotebookOptimizationSource).promptMessageId }
}
