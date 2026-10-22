import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_RESOURCE_BUDGETS } from '../resource-budget'

import {
  createCandidateSnapshotStore,
  type CandidateExecutionRefs,
  type CandidateSnapshotInput,
  type CandidateSnapshotStore,
  type CandidateContextAsset
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

const fixture = async (
  materializeAsset?: Parameters<typeof createCandidateSnapshotStore>[0]['materializeAsset']
): Promise<{ root: string; store: CandidateSnapshotStore }> => {
  const root = await fs.mkdtemp(join(tmpdir(), 'earthnano-candidates-'))
  roots.push(root)
  return {
    root,
    store: await createCandidateSnapshotStore({
      root: join(root, 'store'),
      candidatesRoot: join(root, 'candidates'),
      ...(materializeAsset ? { materializeAsset } : {})
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

describe('immutable invocation context files', () => {
  const context = [
    { path: 'rollouts/base1.md', content: '遥感 🌍\r\n@source !`echo untouched`\n' },
    { path: 'adoption.json', content: '{"chosen":"A"}\n' }
  ]
  it('preserves the exact legacy invocation envelope and digest when context files are absent', async () => {
    const { root, store } = await fixture()
    const refs = await freeze(store)
    const legacy = JSON.stringify({
      kind: 'invocation',
      value: {
        harnessRevisionRef: {
          digest: refs.harnessRevisionRef.digest,
          id: refs.harnessRevisionRef.id,
          version: refs.harnessRevisionRef.version
        },
        mission: input().task.prompt,
        taskSnapshotRef: {
          digest: refs.taskSnapshotRef.digest,
          id: refs.taskSnapshotRef.id,
          version: refs.taskSnapshotRef.version
        }
      },
      version: 1
    })
    expect(await fs.readFile(objectPath(root, refs.invocationRef.digest), 'utf8')).toBe(legacy)
    expect(refs.invocationRef.digest).toBe(
      `sha256:${createHash('sha256').update(legacy).digest('hex')}`
    )
    expect((await store.resolve(refs)).invocation).not.toHaveProperty('contextFiles')
  })

  it('reopens complete context bytes and materializes them into the original readonly INPUT manifest', async () => {
    const { root, store } = await fixture()
    const refs = await freeze(store)
    const offered = structuredClone(context)
    const invocationRef = await store.freezeInvocation({
      ...(await store.resolve(refs)).invocation,
      contextFiles: offered
    })
    offered[0].content = 'changed after freeze'
    const reopened = await createCandidateSnapshotStore({
      root: join(root, 'store'),
      candidatesRoot: join(root, 'candidates')
    })
    const frozen = await reopened.resolve({ ...refs, invocationRef })
    expect(frozen.task).toEqual(input().task)
    expect(frozen.invocation.contextFiles).toEqual([...context].reverse())
    expect(Object.isFrozen(frozen.invocation.contextFiles![0])).toBe(true)
    const value = await reopened.materialize({
      executionId: 'with-context',
      refs: { ...refs, invocationRef }
    })
    for (const file of context) {
      const path = join(value.inputDir, file.path)
      expect(await fs.readFile(path)).toEqual(Buffer.from(file.content, 'utf8'))
      expect(value.manifest).toContainEqual({
        path: `workspace/inputs/${file.path}`,
        bytes: Buffer.byteLength(file.content),
        digest: `sha256:${createHash('sha256').update(file.content).digest('hex')}`
      })
      if (process.platform !== 'win32') expect((await fs.stat(path)).mode & 0o222).toBe(0)
    }
    expect(frozen.invocation.mission).toBe(input().task.prompt)
    const reordered = await reopened.freezeInvocation({
      ...frozen.invocation,
      contextFiles: context
    })
    expect(reordered).toEqual(invocationRef)
    const controller = new AbortController()
    controller.abort()
    await expect(
      reopened.materialize({
        executionId: 'cancelled-context',
        refs: { ...refs, invocationRef },
        signal: controller.signal
      })
    ).rejects.toThrow()
    expect(await fs.readdir(join(root, 'candidates'))).toEqual(['with-context'])
  })

  it.each([
    [{ path: '../escape', content: 'x' }],
    [{ path: '/absolute', content: 'x' }],
    [{ path: 'CON.txt', content: 'x' }],
    [{ path: 'data/SOURCE.txt', content: 'collision with task' }],
    [{ path: 'notes.txt/nested', content: 'prefix collision with task' }],
    [
      { path: 'é.md', content: 'x' },
      { path: 'e\u0301.md', content: 'y' }
    ],
    [{ path: 'valid.md', content: '\0' }],
    [{ path: 'valid.md', content: '\ud800' }]
  ])(
    'rejects invalid or colliding context manifest %j before materialization',
    async (...contextFiles) => {
      const { root, store } = await fixture()
      const refs = await freeze(store)
      await expect(
        store.freezeInvocation({ ...(await store.resolve(refs)).invocation, contextFiles })
      ).rejects.toThrow()
      expect(await fs.readdir(join(root, 'candidates'))).toEqual([])
    }
  )

  it('rejects context collisions with binary assets and counts context against the existing aggregate budget before owner I/O', async () => {
    const materializeAsset = vi.fn(async () => {
      throw new Error('Must reject before owner I/O')
    })
    const { root, store } = await fixture(materializeAsset)
    const refs = await freeze(store, { ...input(), task: { prompt: 'same task', files: [] } })
    const invocation = (await store.resolve(refs)).invocation
    const asset = (path: string): CandidateContextAsset => ({
      path,
      sourceExecutionId: 'source',
      artifact: {
        path: 'large.bin',
        representation: 'binary',
        sizeBytes: LOCAL_RESOURCE_BUDGETS.artifactFileBytes,
        digest: `sha256:${'a'.repeat(64)}`,
        artifactRef: { artifactId: 'a', versionId: 'v', checksum: 'a'.repeat(64) }
      }
    })
    await expect(
      store.freezeInvocation({
        ...invocation,
        contextFiles: context,
        assets: [asset('ROLLOUTS/base1.md')]
      })
    ).rejects.toThrow('collide')
    const invocationRef = await store.freezeInvocation({
      ...invocation,
      contextFiles: context,
      assets: [asset('a.bin'), asset('b.bin')]
    })
    await expect(
      store.materialize({ executionId: 'over-budget-context', refs: { ...refs, invocationRef } })
    ).rejects.toThrow('Local resource turn budget exceeded')
    expect(materializeAsset).not.toHaveBeenCalled()
    expect(await fs.readdir(join(root, 'candidates'))).toEqual([])
  })
})

describe('version-bound binary invocation assets', () => {
  const bytes = Buffer.from([0x89, 0, 0xff, 0x80])
  const checksum = createHash('sha256').update(bytes).digest('hex')
  const asset: CandidateContextAsset = {
    path: 'context/candidates/A/opaque.bin',
    sourceExecutionId: 'original-execution',
    artifact: {
      path: 'data.bin',
      representation: 'binary',
      sizeBytes: bytes.length,
      contentType: 'application/octet-stream',
      digest: `sha256:${checksum}`,
      artifactRef: { artifactId: 'artifact', versionId: 'version-1', checksum }
    }
  }
  const withAssets = async (
    store: CandidateSnapshotStore,
    refs: CandidateExecutionRefs,
    assets: readonly CandidateContextAsset[] = [asset]
  ): Promise<CandidateExecutionRefs> => ({
    ...refs,
    invocationRef: await store.freezeInvocation({
      taskSnapshotRef: refs.taskSnapshotRef,
      harnessRevisionRef: refs.harnessRevisionRef,
      mission: input().task.prompt,
      assets
    })
  })

  it('keeps ordinary snapshot bytes while binding asset Version and source identity into invocation', async () => {
    const { store } = await fixture()
    const plainRefs = await freeze(store)
    expect((await store.resolve(plainRefs)).invocation).not.toHaveProperty('assets')
    const assetRefs = await withAssets(store, plainRefs)
    expect(assetRefs.taskSnapshotRef).toEqual(plainRefs.taskSnapshotRef)
    expect(assetRefs.harnessRevisionRef).toEqual(plainRefs.harnessRevisionRef)
    expect(assetRefs.environmentSpecRef).toEqual(plainRefs.environmentSpecRef)
    expect(assetRefs.invocationRef).not.toEqual(plainRefs.invocationRef)
    const otherSource = await withAssets(store, plainRefs, [
      { ...asset, sourceExecutionId: 'different-execution' }
    ])
    expect(otherSource.invocationRef).not.toEqual(assetRefs.invocationRef)
    const otherVersion = await withAssets(store, plainRefs, [
      {
        ...asset,
        artifact: {
          ...asset.artifact,
          artifactRef: { ...asset.artifact.artifactRef, versionId: 'version-2' }
        }
      }
    ])
    expect(otherVersion.invocationRef).not.toEqual(assetRefs.invocationRef)
  })

  it('copies exact owner bytes into readonly INPUT with the frozen digest and cancellation signal', async () => {
    const materializeAsset = vi.fn(async () => ({
      file: structuredClone(asset.artifact),
      assetPath
    }))
    const { root, store } = await fixture(materializeAsset)
    const assetPath = join(root, 'owner-asset.bin')
    await fs.writeFile(assetPath, bytes)
    const refs = await withAssets(store, await freeze(store))
    const controller = new AbortController()
    const value = await store.materialize({
      executionId: 'binary',
      refs,
      signal: controller.signal
    })
    const path = join(value.inputDir, asset.path)
    expect(await fs.readFile(path)).toEqual(bytes)
    const mode = (await fs.stat(path)).mode
    if (process.platform === 'win32') expect(mode & 0o222).toBe(0)
    else expect(mode & 0o777).toBe(0o400)
    expect(materializeAsset).toHaveBeenCalledExactlyOnceWith(asset, controller.signal)
    expect(value.manifest).toContainEqual({
      path: `workspace/inputs/${asset.path}`,
      digest: asset.artifact.digest,
      bytes: bytes.length
    })
    expect(value.snapshots.task).not.toHaveProperty('assets')
  })

  it.each(['file', 'turn'] as const)(
    'rejects assets above the original %s budget before opening any original Version',
    async (dimension) => {
      const materializeAsset = vi.fn(async () => {
        throw new Error('Oversized manifests must not open a Version')
      })
      const { root, store } = await fixture(materializeAsset)
      const large = {
        ...asset,
        artifact: {
          ...asset.artifact,
          sizeBytes: LOCAL_RESOURCE_BUDGETS.artifactFileBytes + (dimension === 'file' ? 1 : 0)
        }
      }
      const assets =
        dimension === 'file'
          ? [large]
          : [0, 1, 2].map((index) => ({ ...large, path: `context/${index}.bin` }))
      const refs = await withAssets(store, await freeze(store), assets)
      await expect(store.materialize({ executionId: 'oversized', refs })).rejects.toThrow(
        `Local resource ${dimension} budget exceeded`
      )
      expect(materializeAsset).not.toHaveBeenCalled()
      expect(await fs.readdir(join(root, 'candidates'))).toEqual([])
    }
  )

  it('refuses missing owners, malformed manifests and collisions with ordinary frozen inputs', async () => {
    const { root, store } = await fixture()
    const refs = await freeze(store)
    const invocation = {
      taskSnapshotRef: refs.taskSnapshotRef,
      harnessRevisionRef: refs.harnessRevisionRef,
      mission: input().task.prompt
    }
    for (const assets of [
      undefined,
      [],
      [asset, asset],
      [{ ...asset, path: '../escape' }],
      [{ ...asset, path: 'notes.txt' }],
      [{ ...asset, sourceExecutionId: 'bad\nidentity' }],
      [{ ...asset, artifact: { ...asset.artifact, content: 'fake bytes' } }]
    ])
      await expect(store.freezeInvocation({ ...invocation, assets } as never)).rejects.toThrow()
    const assetRefs = await withAssets(store, refs)
    await expect(
      store.materialize({ executionId: 'missing-owner', refs: assetRefs })
    ).rejects.toThrow('owner is unavailable')
    expect(await fs.readdir(join(root, 'candidates'))).toEqual([])
  })

  it.each(['changed-bytes', 'different-Version', 'symlink', 'hardlink', 'cancelled'] as const)(
    'rejects %s before any native preparation can consume an asset',
    async (kind) => {
      let assetPath: string
      const controller = new AbortController()
      const callback = vi.fn(async () => {
        if (kind === 'cancelled') controller.abort(new Error('Stopped asset preparation'))
        return {
          file:
            kind === 'different-Version'
              ? {
                  ...asset.artifact,
                  artifactRef: { ...asset.artifact.artifactRef, versionId: 'other' }
                }
              : asset.artifact,
          assetPath
        }
      })
      const { root, store } = await fixture(callback)
      const original = join(root, 'owner-original.bin')
      await fs.writeFile(original, kind === 'changed-bytes' ? Buffer.alloc(bytes.length) : bytes)
      assetPath = join(root, 'owner-asset.bin')
      if (kind === 'symlink') await fs.symlink(original, assetPath)
      else if (kind === 'hardlink') await fs.link(original, assetPath)
      else assetPath = original
      const refs = await withAssets(store, await freeze(store))
      await expect(
        store.materialize({ executionId: 'rejected', refs, signal: controller.signal })
      ).rejects.toThrow()
      await expect(
        fs.stat(join(root, 'candidates/rejected/workspace/inputs', asset.path))
      ).rejects.toThrow()
    }
  )
})

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
    // Clear Windows readonly attributes only in this owned attack fixture before replacing its namespace.
    await writable(join(root, 'store/objects'))
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

const computeInput = (count = 0): CandidateSnapshotInput => {
  const original = scientificInput()
  return {
    ...original,
    task: {
      prompt: 'Run the original task on the selected Compute host.',
      files: [],
      managedInputs: Array.from({ length: count }, (_, i) => ({
        ...original.task.managedInputs![0],
        sourceFileId: `file-${i}`,
        inputFileVersionId: `version-${i}`
      }))
    },
    harness: { ...original.harness, tools: 'notebook-compute' },
    environment: {
      isolation: 'directory-process',
      network: 'provider-and-notebook-policy',
      compute: {
        sourceProjectId: 'project',
        sourceSessionId: 'source-session',
        access: { enabledProviderIds: ['ssh:lab'], selectedProviderIds: [] },
        hosts: [
          {
            id: 'host-original',
            providerId: 'ssh:lab',
            shape: 'direct_ssh',
            executionMode: 'direct_ssh'
          }
        ]
      }
    }
  }
}

describe('frozen original Compute control profile', () => {
  it.each([0, 2])(
    'freezes and materializes %i exact managed inputs without a data-language runtime',
    async (count) => {
      const { root, store } = await fixture()
      const original = computeInput(count)
      const first = await freeze(store, original)
      const next = await freeze(store, {
        ...original,
        harness: { ...original.harness, instructions: 'Revised original Compute workflow.' }
      })
      expect(next.taskSnapshotRef).toEqual(first.taskSnapshotRef)
      expect(next.environmentSpecRef).toEqual(first.environmentSpecRef)
      expect(next.harnessRevisionRef).not.toEqual(first.harnessRevisionRef)
      Object.assign(original.environment.compute!.hosts[0], { id: 'host-replacement' })
      const reopened = await createCandidateSnapshotStore({
        root: join(root, 'store'),
        candidatesRoot: join(root, 'candidates')
      })
      const resolved = await reopened.resolve(first)
      expect(resolved.environment.compute?.hosts[0].id).toBe('host-original')
      expect(resolved.environment.compute?.access.selectedProviderIds).toEqual([])
      expect(resolved.environment.notebook).toBeUndefined()
      expect(resolved.task.managedInputs).toHaveLength(count)
      expect(Object.isFrozen(resolved.environment.compute?.hosts)).toBe(true)
      const materialized = await reopened.materialize({
        executionId: `compute-${count}`,
        refs: first
      })
      expect(await fs.readdir(materialized.inputDir)).toEqual([])
      expect(materialized.snapshots).toEqual(resolved)
    }
  )

  it('rejects mixed control, data-runtime, input and host authority before writing any object', async () => {
    const { root, store } = await fixture()
    const original = computeInput(1)
    const foreign = structuredClone(original)
    Object.assign(foreign.task.managedInputs![0], { sourceProjectId: 'foreign-project' })
    for (const bad of [
      { ...original, harness: { ...original.harness, tools: 'workspace-only' } },
      { ...original, environment: scientificInput().environment },
      {
        ...original,
        environment: { ...original.environment, notebook: scientificInput().environment.notebook }
      },
      { ...original, environment: { ...original.environment, network: 'provider-only' } },
      {
        ...original,
        task: { ...original.task, files: [{ path: 'inline.txt', content: 'unmanaged' }] }
      },
      {
        ...original,
        environment: {
          ...original.environment,
          compute: { ...original.environment.compute, password: 'not-a-snapshot-field' }
        }
      },
      foreign
    ])
      await expect(store.freeze(bad as CandidateSnapshotInput)).rejects.toThrow()
    expect(await fs.readdir(join(root, 'store/objects'))).toEqual([])
  })

  it('rejects crossed Compute Project and profile references on reopening', async () => {
    const { store } = await fixture()
    const original = await freeze(store, computeInput(1))
    const foreign = computeInput(1)
    Object.assign(foreign.environment, {
      compute: { ...foreign.environment.compute!, sourceProjectId: 'foreign-project' }
    })
    Object.assign(foreign.task.managedInputs![0], { sourceProjectId: 'foreign-project' })
    const other = await freeze(store, foreign)
    await expect(
      store.resolve({ ...other, environmentSpecRef: original.environmentSpecRef })
    ).rejects.toThrow('another Project')
    const text = await freeze(store)
    await expect(
      store.resolve({ ...original, environmentSpecRef: text.environmentSpecRef })
    ).rejects.toThrow('Compute context')
  })

  it.each([0, 11])(
    'retains the original non-Compute attachment bound for %i inputs',
    async (count) => {
      const { store } = await fixture()
      const original = scientificInput()
      Object.assign(original.task, {
        managedInputs: Array.from({ length: count }, (_, i) => ({
          ...original.task.managedInputs![0],
          sourceFileId: `file-${i}`,
          inputFileVersionId: `version-${i}`
        }))
      })
      await expect(store.freeze(original)).rejects.toThrow()
    }
  )
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
