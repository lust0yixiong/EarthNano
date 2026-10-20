import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createCandidateSnapshotStore,
  type CandidateExecutionRefs,
  type CandidateSnapshotInput,
  type CandidateSnapshotStore
} from './candidate-snapshot'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdir: vi.fn(actual.mkdir) }
})

const roots: string[] = []
const writable = async (path: string): Promise<void> => {
  const stat = await fs.lstat(path)
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    await fs.chmod(path, 0o700)
    for (const child of await fs.readdir(path)) await writable(join(path, child))
  } else await fs.chmod(path, 0o600)
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(fs.mkdir).mockReset()
  for (const root of roots.splice(0)) {
    await writable(root)
    await fs.rm(root, { recursive: true, force: true })
  }
})

const input = (): CandidateSnapshotInput => ({
  task: {
    prompt: '读取输入，写入outputs/result.txt。',
    files: [
      { path: 'data/source.txt', content: '遥感输入\n42\n' },
      { path: 'notes.txt', content: 'Same frozen task for both candidates.' }
    ]
  },
  harness: {
    instructions: 'CANDIDATE_A_INSTRUCTIONS',
    tools: 'workspace-only',
    skills: [
      {
        path: 'analysis/SKILL.md',
        content: '---\nname: analysis\ndescription: Analyze data.\n---\nRead references/rules.md.'
      },
      { path: 'analysis/references/rules.md', content: 'CANDIDATE_A_SKILL_RULE' }
    ]
  },
  agent: {
    backend: 'claude-code',
    model: 'fixture-model',
    providerRef: 'provider:local-fixture',
    runtimeVersion: 'fixture-1'
  },
  environment: { isolation: 'directory-process', network: 'provider-only' }
})

const fixture = async (): Promise<{ root: string; store: CandidateSnapshotStore }> => {
  const root = await fs.mkdtemp(join(tmpdir(), 'earthnano-candidates-'))
  roots.push(root)
  return {
    root,
    store: await createCandidateSnapshotStore({
      root: join(root, 'store'),
      candidatesRoot: join(root, 'candidates')
    })
  }
}
const freeze = async (
  store: CandidateSnapshotStore,
  value = input()
): Promise<CandidateExecutionRefs> => {
  const refs = await store.freeze(value)
  return {
    ...refs,
    invocationRef: await store.freezeInvocation({
      taskSnapshotRef: refs.taskSnapshotRef,
      harnessRevisionRef: refs.harnessRevisionRef,
      mission: value.task.prompt
    })
  }
}
const objectPath = (root: string, digest: string): string =>
  join(root, 'store/objects', `${digest.slice(7)}.json`)

describe('candidate immutable references', () => {
  it('freezes actual text and returns verified deeply frozen payloads after callers mutate their inputs', async () => {
    const { store } = await fixture()
    const original = input()
    const refs = await freeze(store, original)
    Object.assign(original.task, { prompt: 'changed source task' })
    Object.assign(original.task.files[0], { content: 'changed source bytes' })
    Object.assign(original.harness, { instructions: 'changed source instructions' })
    const frozen = await store.resolve(refs)
    expect(frozen.task.prompt).toBe('读取输入，写入outputs/result.txt。')
    expect(frozen.task.files[0].content).toBe('遥感输入\n42\n')
    expect(frozen.harness.instructions).toBe('CANDIDATE_A_INSTRUCTIONS')
    expect(Object.isFrozen(frozen.task.files[0])).toBe(true)
    expect(() => Object.assign(frozen.task, { prompt: 'altered snapshot' })).toThrow()
    expect(refs.taskSnapshotRef.id).not.toContain('/')
    expect(refs.taskSnapshotRef.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('canonicalizes file order, supports concurrent deduplication, and reopens refs without a live registry', async () => {
    const { root, store } = await fixture()
    const original = input()
    const reordered = {
      ...original,
      task: { ...original.task, files: [...original.task.files].reverse() },
      harness: { ...original.harness, skills: [...original.harness.skills].reverse() }
    }
    const [first, second] = await Promise.all([freeze(store, original), freeze(store, reordered)])
    expect(first).toEqual(second)
    const reopened = await createCandidateSnapshotStore({
      root: join(root, 'store'),
      candidatesRoot: join(root, 'candidates')
    })
    expect(await reopened.resolve(first)).toEqual(await store.resolve(first))
    expect(await fs.readdir(join(root, 'store/objects'))).toHaveLength(5)
  })

  it('binds invocation refs to the exact task and Harness pair', async () => {
    const { store } = await fixture()
    const first = await freeze(store)
    const second = await freeze(store, {
      ...input(),
      harness: { ...input().harness, instructions: 'B' }
    })
    await expect(store.resolve({ ...second, invocationRef: first.invocationRef })).rejects.toThrow(
      'different task or Harness'
    )
    const changedTask = await freeze(store, {
      ...input(),
      task: { ...input().task, prompt: 'Other task' }
    })
    await expect(
      store.resolve({ ...changedTask, invocationRef: first.invocationRef })
    ).rejects.toThrow('different task or Harness')
  })

  it('verifies object bytes and refuses tampered content before allocating any candidate', async () => {
    const { root, store } = await fixture()
    const refs = await freeze(store)
    const path = objectPath(root, refs.harnessRevisionRef.digest)
    await fs.chmod(path, 0o600)
    await fs.writeFile(path, '{}')
    await expect(store.materialize({ executionId: 'candidate-1', refs })).rejects.toThrow(
      'digest mismatch'
    )
    expect(await fs.readdir(join(root, 'candidates'))).toEqual([])
  })

  it('rejects missing, forged, wrong-kind and unsupported-version refs', async () => {
    const { store } = await fixture()
    const refs = await freeze(store)
    for (const bad of [
      { ...refs.taskSnapshotRef, id: '/mutable/workspace/task.txt' },
      { ...refs.taskSnapshotRef, version: '2' },
      refs.harnessRevisionRef,
      { id: `candidate:task:${'f'.repeat(64)}`, version: '1', digest: `sha256:${'f'.repeat(64)}` }
    ])
      await expect(store.resolve({ ...refs, taskSnapshotRef: bad })).rejects.toThrow()
  })

  it('refuses invalid UTF-8 even when lossy decoding would reproduce a prior Unicode digest', async () => {
    const { root, store } = await fixture()
    const refs = await freeze(store, { ...input(), task: { prompt: '\ufffd', files: [] } })
    const path = objectPath(root, refs.taskSnapshotRef.digest)
    const bytes = await fs.readFile(path)
    const marker = bytes.indexOf(Buffer.from('\ufffd'))
    expect(marker).toBeGreaterThan(0)
    await fs.chmod(path, 0o600)
    await fs.writeFile(
      path,
      Buffer.concat([bytes.subarray(0, marker), Buffer.from([0x80]), bytes.subarray(marker + 3)])
    )
    await expect(store.resolve(refs)).rejects.toThrow('valid UTF-8')
  })
})

describe('candidate paths, policy, and secrets', () => {
  it.each([
    '../escape',
    '/escape',
    'a/../../escape',
    'a\\escape',
    'C:/escape',
    'a//b',
    '.',
    '..',
    'a/./b',
    'a/trailing.',
    'NUL.txt',
    'a\0b'
  ])('rejects unsafe file path %j before committing objects', async (path) => {
    const { root, store } = await fixture()
    await expect(
      store.freeze({ ...input(), task: { prompt: 'task', files: [{ path, content: 'text' }] } })
    ).rejects.toThrow()
    expect(await fs.readdir(join(root, 'store/objects'))).toEqual([])
  })

  it.each([
    ['same.txt', 'same.txt'],
    ['A.txt', 'a.txt'],
    ['cafe\u0301.txt', 'café.txt'],
    ['dir', 'dir/file.txt']
  ])(
    'rejects duplicate, case/Unicode collision and file/directory overlap %j %j',
    async (left, right) => {
      const { store } = await fixture()
      await expect(
        store.freeze({
          ...input(),
          task: {
            prompt: 'task',
            files: [
              { path: left, content: 'A' },
              { path: right, content: 'B' }
            ]
          }
        })
      ).rejects.toThrow('collide')
    }
  )

  it('rejects unsupported backends, tools, environment policy, scripts and credential-shaped fields', async () => {
    const { root, store } = await fixture()
    for (const bad of [
      { ...input(), agent: { ...input().agent, backend: 'opencode' } },
      { ...input(), agent: { ...input().agent, key: 'must-not-be-written' } },
      { ...input(), agent: { ...input().agent, baseUrl: 'https://secret.example' } },
      { ...input(), agent: { ...input().agent, providerRef: 'https://credentials.example/token' } },
      { ...input(), harness: { ...input().harness, tools: 'arbitrary-shell' } },
      {
        ...input(),
        harness: {
          ...input().harness,
          skills: [{ path: 'skill/scripts/run.py', content: 'print(1)' }]
        }
      },
      { ...input(), environment: { isolation: 'directory-process', network: 'arbitrary' } },
      { ...input(), task: { prompt: '\ud800', files: [] } }
    ])
      await expect(store.freeze(bad as CandidateSnapshotInput)).rejects.toThrow()
    expect(await fs.readdir(join(root, 'store/objects'))).toEqual([])
  })

  it('never serializes the process environment or receives executable/credential configuration', async () => {
    const { root, store } = await fixture()
    vi.stubEnv('CANDIDATE_PERSONAL_KEY', 'PRIVATE_PROCESS_SENTINEL')
    try {
      await freeze(store)
      const values = await Promise.all(
        (await fs.readdir(join(root, 'store/objects'))).map((file) =>
          fs.readFile(join(root, 'store/objects', file), 'utf8')
        )
      )
      expect(values.join('')).not.toContain('PRIVATE_PROCESS_SENTINEL')
      expect(values.join('')).not.toContain('executablePath')
      expect(values.join('')).not.toContain('apiKey')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('rejects symlink store roots, symlink object directories and symlink/hardlink objects', async () => {
    const { root, store } = await fixture()
    const refs = await freeze(store)
    const elsewhere = join(root, 'elsewhere')
    await fs.mkdir(elsewhere)
    const alias = join(root, 'store-alias')
    await fs.symlink(join(root, 'store'), alias, 'dir')
    await expect(
      createCandidateSnapshotStore({ root: alias, candidatesRoot: elsewhere })
    ).rejects.toThrow('real directory')
    const path = objectPath(root, refs.taskSnapshotRef.digest)
    const copy = join(elsewhere, 'object.json')
    await fs.copyFile(path, copy)
    await fs.unlink(path)
    await fs.symlink(copy, path)
    await expect(store.resolve(refs)).rejects.toThrow()
    await fs.unlink(path)
    await fs.link(copy, path)
    await expect(store.resolve(refs)).rejects.toThrow('regular file')
    expect((await fs.readFile(copy, 'utf8')).length).toBeGreaterThan(0)
    await fs.rename(join(root, 'store/objects'), join(root, 'old-objects'))
    await fs.symlink(elsewhere, join(root, 'store/objects'), 'dir')
    await expect(store.freeze(input())).rejects.toThrow('identity changed')
  })

  it('keeps content and candidate roots separate and refuses reused directory identities', async () => {
    const { root, store } = await fixture()
    await expect(
      createCandidateSnapshotStore({ root: join(root, 'same'), candidatesRoot: join(root, 'same') })
    ).rejects.toThrow('overlap')
    await expect(
      createCandidateSnapshotStore({
        root: join(root, 'nested'),
        candidatesRoot: join(root, 'nested/candidates')
      })
    ).rejects.toThrow('overlap')
    const refs = await freeze(store)
    await store.materialize({ executionId: 'candidate-1', refs })
    await expect(store.materialize({ executionId: 'candidate-1', refs })).rejects.toMatchObject({
      code: 'EEXIST'
    })
    const target = join(root, 'outside')
    await fs.mkdir(target)
    await fs.symlink(target, join(root, 'candidates/link'), 'dir')
    await expect(store.materialize({ executionId: 'link', refs })).rejects.toMatchObject({
      code: 'EEXIST'
    })
    expect(await fs.readdir(target)).toEqual([])
    await expect(store.materialize({ executionId: '../escape', refs })).rejects.toThrow(
      'safe directory identity'
    )
  })

  it('does not follow a link inserted into a nested input parent during preparation', async () => {
    const { root, store } = await fixture()
    const refs = await freeze(store)
    const target = join(root, 'unrelated')
    await fs.mkdir(target)
    const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'))
      .mkdir
    let injected = false
    vi.mocked(fs.mkdir).mockImplementation((async (path, options) => {
      const result = await original(path, options)
      if (!injected && String(path).endsWith(`${join('workspace', 'inputs')}`)) {
        injected = true
        await fs.rmdir(path)
        await fs.symlink(target, path, 'dir')
      }
      return result
    }) as typeof fs.mkdir)
    await expect(store.materialize({ executionId: 'injected-link', refs })).rejects.toThrow(
      'contains a link'
    )
    expect(await fs.readdir(target)).toEqual([])
  })
})

describe('candidate independent projections', () => {
  it('makes independent read-only input/Harness files, empty runtime homes and writable outputs', async () => {
    const { store } = await fixture()
    const first = await freeze(store)
    const second = await freeze(store, {
      ...input(),
      harness: {
        ...input().harness,
        instructions: 'CANDIDATE_B_INSTRUCTIONS',
        skills: [{ path: 'analysis/SKILL.md', content: 'CANDIDATE_B_SKILL' }]
      }
    })
    expect(first.taskSnapshotRef).toEqual(second.taskSnapshotRef)
    expect(first.agentSpecRef).toEqual(second.agentSpecRef)
    expect(first.environmentSpecRef).toEqual(second.environmentSpecRef)
    expect(first.harnessRevisionRef).not.toEqual(second.harnessRevisionRef)
    const [a, b] = await Promise.all([
      store.materialize({ executionId: 'A', refs: first }),
      store.materialize({ executionId: 'B', refs: second })
    ])
    expect(a.runtimeHome).not.toBe(b.runtimeHome)
    expect(await fs.readdir(a.runtimeHome)).toEqual([])
    expect(await fs.readdir(b.runtimeHome)).toEqual([])
    expect(await fs.readFile(a.instructionsPath, 'utf8')).toBe('CANDIDATE_A_INSTRUCTIONS')
    expect(await fs.readFile(b.instructionsPath, 'utf8')).toBe('CANDIDATE_B_INSTRUCTIONS')
    const aInput = join(a.inputDir, 'data/source.txt')
    const bInput = join(b.inputDir, 'data/source.txt')
    const aStat = await fs.stat(aInput)
    const bStat = await fs.stat(bInput)
    expect(aStat.ino).not.toBe(bStat.ino)
    expect(aStat.nlink).toBe(1)
    if (process.platform !== 'win32') expect(aStat.mode & 0o777).toBe(0o400)
    await fs.writeFile(join(a.outputDir, 'result.txt'), 'A result')
    await fs.writeFile(join(b.outputDir, 'result.txt'), 'B result')
    // Same-UID permissions are advisory: even an intentional chmod/write cannot affect B/store.
    await fs.chmod(aInput, 0o600)
    await fs.writeFile(aInput, 'A changed its private copy')
    expect(await fs.readFile(bInput, 'utf8')).toBe('遥感输入\n42\n')
    expect((await store.resolve(first)).task.files[0].content).toBe('遥感输入\n42\n')
    expect(await fs.readFile(join(b.outputDir, 'result.txt'), 'utf8')).toBe('B result')
    expect(a.materializedDigest).not.toBe(b.materializedDigest)
  })

  it('reports reproducible projection manifests without mutable absolute paths or native-loading claims', async () => {
    const { store } = await fixture()
    const refs = await freeze(store)
    const a = await store.materialize({ executionId: 'same-A', refs })
    const b = await store.materialize({ executionId: 'same-B', refs })
    expect(a.materializedDigest).toBe(b.materializedDigest)
    expect(a.manifest).toEqual(b.manifest)
    expect(Object.isFrozen(a.manifest)).toBe(true)
    for (const entry of a.manifest) {
      expect(entry.path).not.toMatch(/^\//)
      const bytes = await fs.readFile(join(a.root, entry.path))
      expect(entry.digest).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`)
      expect(entry.bytes).toBe(bytes.length)
    }
    expect(dirname(a.cwd)).toBe(a.root)
    expect(a.snapshots.invocation.mission).toBe('读取输入，写入outputs/result.txt。')
  })
})

const scientificInput = (): CandidateSnapshotInput => ({
  ...input(),
  task: {
    prompt: 'Compute CSV statistics with Notebook.',
    files: [],
    managedInputs: [
      {
        sourceKind: 'upload-version',
        sourceProjectId: 'project',
        sourceSessionId: 'source-session',
        sourceFileId: 'source-upload',
        inputFileVersionId: 'old-version',
        filename: 'source.csv',
        sizeBytes: 8,
        checksum: 'a'.repeat(64)
      }
    ]
  },
  harness: { instructions: 'Use Notebook.', skills: [], tools: 'notebook-python' },
  environment: {
    isolation: 'directory-process',
    network: 'provider-and-notebook-policy',
    notebook: {
      runtime: {
        language: 'python',
        runtimeId: '/original/python',
        source: 'external',
        provenance: 'user-own',
        interpreterPath: '/original/python',
        version: '3.12.9'
      }
    }
  }
})

describe('frozen original Notebook profile', () => {
  it('preserves exact old input tuples and runtime across revised harnesses and reopening', async () => {
    const { root, store } = await fixture()
    const original = scientificInput()
    const first = await freeze(store, original)
    const changed = await freeze(store, {
      ...original,
      harness: { ...original.harness, instructions: 'Check row counts before publication.' }
    })
    expect(first.taskSnapshotRef).toEqual(changed.taskSnapshotRef)
    expect(first.environmentSpecRef).toEqual(changed.environmentSpecRef)
    expect(first.harnessRevisionRef).not.toEqual(changed.harnessRevisionRef)
    Object.assign(original.task.managedInputs![0]!, { inputFileVersionId: 'new-version' })
    Object.assign(original.environment.notebook!.runtime, { runtimeId: '/changed/python' })
    const reopened = await createCandidateSnapshotStore({
      root: join(root, 'store'),
      candidatesRoot: join(root, 'candidates')
    })
    const resolved = await reopened.resolve(first)
    expect(resolved.task.managedInputs?.[0]?.inputFileVersionId).toBe('old-version')
    expect(resolved.environment.notebook?.runtime.runtimeId).toBe('/original/python')
    expect(Object.isFrozen(resolved.task.managedInputs![0])).toBe(true)
    const projected = await store.materialize({ executionId: 'notebook', refs: first })
    expect(await fs.readdir(projected.inputDir)).toEqual([])
    expect(projected.snapshots.task.managedInputs).toEqual(resolved.task.managedInputs)
  })

  it('rejects mixed inline input, missing grants and mismatched reference combinations', async () => {
    const { root, store } = await fixture()
    const original = scientificInput()
    for (const bad of [
      { ...original, task: { ...original.task, files: [{ path: 'copy.csv', content: 'copy' }] } },
      { ...original, task: { prompt: 'task', files: [] } },
      { ...original, environment: input().environment },
      { ...original, harness: { ...original.harness, tools: 'workspace-only' } }
    ])
      await expect(store.freeze(bad as CandidateSnapshotInput)).rejects.toThrow()
    expect(await fs.readdir(join(root, 'store/objects'))).toEqual([])
    const scientific = await freeze(store, original)
    const textual = await freeze(store)
    await expect(
      store.resolve({ ...scientific, environmentSpecRef: textual.environmentSpecRef })
    ).rejects.toThrow('fixed managed inputs')
  })
})

describe('Notebook language/profile identity', () => {
  it('retains exact pre-R Python snapshot identities', async () => {
    const { store } = await fixture()
    const refs = await store.freeze(scientificInput())
    expect(refs.taskSnapshotRef.digest).toBe(
      'sha256:c22deb32e4840733259a2888773a7f540245fa4c541eb75542f120b3b3cfdac1'
    )
    expect(refs.harnessRevisionRef.digest).toBe(
      'sha256:ba655cc746f6c88ef4ad5b6677a6b6858754dbf1f7460fb26fce605a913222c1'
    )
    expect(refs.environmentSpecRef.digest).toBe(
      'sha256:28a91c743fe77697cb7f1d783723c90c12e0dd2cd9fabc83fe5275108d752a46'
    )
  })
  it('keeps one task across Python/R profiles but rejects profile/runtime crossover before writing', async () => {
    const { root, store } = await fixture()
    const python = scientificInput()
    const r = {
      ...python,
      harness: { ...python.harness, tools: 'notebook-r' as const },
      environment: {
        ...python.environment,
        notebook: {
          runtime: {
            ...python.environment.notebook!.runtime,
            language: 'r' as const,
            runtimeId: '/original/R',
            interpreterPath: '/original/R',
            version: '4.4.3'
          }
        }
      }
    }
    for (const bad of [
      { ...r, harness: python.harness },
      { ...python, harness: r.harness }
    ])
      await expect(store.freeze(bad)).rejects.toThrow()
    expect(await fs.readdir(join(root, 'store/objects'))).toEqual([])
    const pRefs = await freeze(store, python)
    const rRefs = await freeze(store, r)
    expect(pRefs.taskSnapshotRef).toEqual(rRefs.taskSnapshotRef)
    expect(pRefs.environmentSpecRef).not.toEqual(rRefs.environmentSpecRef)
    expect(pRefs.harnessRevisionRef).not.toEqual(rRefs.harnessRevisionRef)
    expect((await store.resolve(rRefs)).environment.notebook?.runtime.language).toBe('r')
    await expect(
      store.resolve({ ...rRefs, environmentSpecRef: pRefs.environmentSpecRef })
    ).rejects.toThrow('language')
    await expect(
      store.resolve({ ...pRefs, environmentSpecRef: rRefs.environmentSpecRef })
    ).rejects.toThrow('language')
  })
})
