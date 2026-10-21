import type { NotebookLanguage } from '../notebook-language-contract'
import type { NotebookRuntimeBinding } from '../notebook-runtime'

/** Exact, path-free source identity captured by the original immutable input owner. */
export type FrozenNotebookInput = Readonly<{
  sourceKind: 'upload-version' | 'artifact-version'
  sourceProjectId: string
  sourceSessionId: string
  sourceFileId: string
  inputFileVersionId: string
  filename: string
  sizeBytes: number
  checksum: string
}>

/** Host-selected original language target. Discovery and admission remain with the Notebook owner. */
export type FrozenNotebookRuntime = Readonly<
  Pick<
    NotebookRuntimeBinding,
    'runtimeId' | 'source' | 'provenance' | 'interpreterPath' | 'version'
  > & {
    language: NotebookLanguage
  }
>

const plain = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error('Notebook profile requires a plain object')
  const entry = value as Record<string, unknown>
  if (
    required.some((key) => !Object.hasOwn(entry, key)) ||
    Object.keys(entry).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new Error('Notebook profile has missing or unsupported fields')
  return entry
}

const text = (value: unknown, max = 4096): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('Notebook profile requires bounded nonempty text')
  for (const character of value) {
    const point = character.codePointAt(0)!
    if (point < 32 || point === 127 || (point >= 0xd800 && point <= 0xdfff))
      throw new Error('Notebook profile text has a control character or lone surrogate')
  }
  return value
}

export function normalizeFrozenNotebookInputs(value: unknown): FrozenNotebookInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10)
    throw new Error('Notebook profile requires one to ten immutable inputs')
  return normalizeFrozenManagedInputs(value)
}

/** Same immutable metadata contract; original Compute calls may have zero or multiple inputs.
 * Actual bytes, resource budgets and leases remain with the original input owner. */
export function normalizeFrozenManagedInputs(value: unknown): FrozenNotebookInput[] {
  if (!Array.isArray(value)) throw new Error('Immutable inputs require an array')
  const seen = new Set<string>()
  let projectId: string | undefined
  return value.map((item) => {
    const entry = plain(item, [
      'sourceKind',
      'sourceProjectId',
      'sourceSessionId',
      'sourceFileId',
      'inputFileVersionId',
      'filename',
      'sizeBytes',
      'checksum'
    ])
    if (entry.sourceKind !== 'upload-version' && entry.sourceKind !== 'artifact-version')
      throw new Error('Unsupported Notebook input source kind')
    const sourceProjectId = text(entry.sourceProjectId, 256)
    if (projectId !== undefined && projectId !== sourceProjectId)
      throw new Error('Notebook inputs must belong to one Project')
    projectId = sourceProjectId
    const sourceFileId = text(entry.sourceFileId, 256)
    const inputFileVersionId = text(entry.inputFileVersionId, 256)
    const filename = text(entry.filename, 1024)
    if (
      /[\\:*?"<>|]/.test(filename) ||
      filename
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))
    )
      throw new Error('Notebook input filename must be a safe relative name')
    if (
      !Number.isSafeInteger(entry.sizeBytes) ||
      (entry.sizeBytes as number) < 0 ||
      typeof entry.checksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.checksum)
    )
      throw new Error('Notebook input requires an exact byte size and checksum')
    const key = JSON.stringify([entry.sourceKind, inputFileVersionId])
    if (seen.has(key)) throw new Error('Duplicate Notebook input Version')
    seen.add(key)
    return {
      sourceKind: entry.sourceKind,
      sourceProjectId,
      sourceSessionId: text(entry.sourceSessionId, 256),
      sourceFileId,
      inputFileVersionId,
      filename,
      sizeBytes: entry.sizeBytes as number,
      checksum: entry.checksum
    }
  })
}

export function normalizeFrozenNotebookRuntime(value: unknown): FrozenNotebookRuntime {
  const entry = plain(
    value,
    ['language', 'runtimeId', 'source', 'provenance', 'interpreterPath'],
    ['version']
  )
  if (
    (entry.language !== 'python' && entry.language !== 'r') ||
    !['managed', 'external'].includes(entry.source as string) ||
    !['app-managed', 'user-own', 'agent-created'].includes(entry.provenance as string) ||
    (entry.source === 'external') !== (entry.provenance === 'user-own')
  )
    throw new Error('Notebook profile requires an original Python or R runtime descriptor')
  const runtimeId = text(entry.runtimeId)
  const interpreterPath = text(entry.interpreterPath)
  if (![runtimeId, interpreterPath].every((path) => /^(?:\/|[a-zA-Z]:[\\/])/.test(path)))
    throw new Error('Notebook runtime requires absolute discovered identities')
  return {
    language: entry.language as NotebookLanguage,
    runtimeId,
    source: entry.source as FrozenNotebookRuntime['source'],
    provenance: entry.provenance as FrozenNotebookRuntime['provenance'],
    interpreterPath,
    ...(Object.hasOwn(entry, 'version') ? { version: text(entry.version, 256) } : {})
  }
}

/** A single shared discriminant for native capability preparation, method transport and owners. */
export type NotebookToolsProfile = 'notebook-python' | 'notebook-r'
export function notebookLanguageForTools(tools: unknown): NotebookLanguage | undefined {
  return tools === 'notebook-python' ? 'python' : tools === 'notebook-r' ? 'r' : undefined
}
export function notebookToolsForLanguage(language: NotebookLanguage): NotebookToolsProfile {
  return language === 'python' ? 'notebook-python' : 'notebook-r'
}
