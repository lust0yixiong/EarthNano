import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
  chmod,
  lstat,
  readdir
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCandidateSnapshotStore,
  type CandidateTextFile,
  type ResolvedCandidateSnapshots,
  type MaterializedCandidate
} from '../earthnano/candidate-snapshot'
import {
  prepareClaudeCandidate,
  assertClaudeCandidateText,
  type ClaudeCandidateBinding
} from './claude-candidate-preparation'
import type { CandidateBinaryArtifactFile } from '../../shared/earthnano/candidate-artifact'

const roots: string[] = []
afterEach(async () => {
  const unlock = async (path: string): Promise<void> => {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      await chmod(path, 0o700)
      for (const entry of await readdir(path)) await unlock(join(path, entry))
    }
  }
  for (const root of roots.splice(0)) {
    await unlock(root)
    await rm(root, { recursive: true, force: true })
  }
})
const fixture = async (
  skills: readonly CandidateTextFile[] = [],
  scientific: boolean | 'r' = false,
  binary?: Buffer
): Promise<{
  resolved: ResolvedCandidateSnapshots
  materialized: MaterializedCandidate
  binding: ClaudeCandidateBinding
}> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-candidate-prep-')))
  roots.push(root)
  const binarySource = join(root, 'original.png')
  const binaryArtifact: CandidateBinaryArtifactFile | undefined = binary && {
    path: 'figure.png',
    representation: 'binary',
    sizeBytes: binary.byteLength,
    contentType: 'image/png',
    digest: `sha256:${createHash('sha256').update(binary).digest('hex')}`,
    artifactRef: {
      artifactId: 'artifact',
      versionId: 'immutable-png',
      checksum: createHash('sha256').update(binary).digest('hex')
    }
  }
  if (binary) await writeFile(binarySource, binary)
  const store = await createCandidateSnapshotStore({
    root: join(root, 'snapshots'),
    candidatesRoot: join(root, 'candidates'),
    ...(binaryArtifact
      ? { materializeAsset: async () => ({ file: binaryArtifact, assetPath: binarySource }) }
      : {})
  })
  const refs = await store.freeze({
    task: scientific
      ? {
          prompt: 'Analyze the frozen CSV',
          files: [],
          managedInputs: [
            {
              sourceKind: 'upload-version',
              sourceProjectId: 'project',
              sourceSessionId: 'source',
              sourceFileId: 'upload',
              inputFileVersionId: 'old-version',
              filename: 'data.csv',
              sizeBytes: 4,
              checksum: 'a'.repeat(64)
            }
          ]
        }
      : { prompt: 'Read the frozen input', files: [{ path: 'input.txt', content: 'frozen' }] },
    harness: {
      instructions: 'SYSTEM_ALPHA',
      skills,
      tools: scientific === 'r' ? 'notebook-r' : scientific ? 'notebook-python' : 'workspace-only'
    },
    agent: {
      backend: 'claude-code',
      model: 'claude-sonnet-4-5',
      providerRef: 'local-probe',
      runtimeVersion: '2.1.232'
    },
    environment: scientific
      ? {
          isolation: 'directory-process',
          network: 'provider-and-notebook-policy',
          notebook: {
            runtime: {
              language: scientific === 'r' ? 'r' : 'python',
              runtimeId: scientific === 'r' ? '/usr/bin/R' : '/usr/bin/python3',
              source: 'external',
              provenance: 'user-own',
              interpreterPath: scientific === 'r' ? '/usr/bin/R' : '/usr/bin/python3'
            }
          }
        }
      : { isolation: 'directory-process', network: 'provider-only' }
  })
  const invocationRef = await store.freezeInvocation({
    taskSnapshotRef: refs.taskSnapshotRef,
    harnessRevisionRef: refs.harnessRevisionRef,
    mission: 'Run the task',
    ...(binaryArtifact
      ? {
          assets: [{ path: 'anonymous.png', sourceExecutionId: 'source', artifact: binaryArtifact }]
        }
      : {})
  })
  const allRefs = { ...refs, invocationRef }
  const resolved = await store.resolve(allRefs)
  const materialized = await store.materialize({ executionId: 'unit', refs: allRefs })
  const binding: ClaudeCandidateBinding = {
    executablePath: join(root, 'claude'),
    runtimeVersion: resolved.agent.runtimeVersion,
    providerRef: resolved.agent.providerRef,
    provider: {
      type: 'custom',
      model: resolved.agent.model,
      key: 'synthetic-key',
      baseUrl: 'http://127.0.0.1:1',
      apiEndpoints: ['messages']
    }
  }
  await writeFile(binding.executablePath, "#!/bin/sh\necho '2.1.232 (Claude Code)'\n", {
    mode: 0o700
  })
  return { resolved, materialized, binding }
}
const runGate = (root: string, tool: string, args: object): string => {
  const result = spawnSync(process.execPath, [join(root, 'runtime/tool-gate.cjs')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: args }),
    encoding: 'utf8'
  })
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision
}

describe.skipIf(process.platform === 'win32')('frozen POSIX Claude candidate preparation', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0xff])

  it('verifies frozen binary assets and allows native Read of their private copies', async () => {
    const f = await fixture([], false, png)
    await prepareClaudeCandidate(f)
    const path = join(f.materialized.inputDir, 'anonymous.png')
    expect(await readFile(path)).toEqual(png)
    expect(runGate(f.materialized.root, 'Read', { file_path: path })).toBe('allow')
    expect(runGate(f.materialized.root, 'Write', { file_path: path, content: 'changed' })).toBe(
      'deny'
    )
  })

  it.each(['bytes', 'manifest', 'missing', 'extra', 'link'] as const)(
    'rejects binary %s substitution before native runtime resources are created',
    async (mutation) => {
      const f = await fixture([], false, png)
      const path = join(f.materialized.inputDir, 'anonymous.png')
      if (mutation === 'bytes') {
        await chmod(path, 0o600)
        await writeFile(path, Buffer.alloc(png.byteLength, 1))
      } else if (mutation === 'manifest') {
        const forged = f.materialized.manifest.map((entry) =>
          entry.path.endsWith('anonymous.png')
            ? { ...entry, digest: `sha256:${'0'.repeat(64)}` }
            : entry
        )
        f.materialized = { ...f.materialized, manifest: forged }
      } else if (mutation === 'missing') {
        f.materialized = {
          ...f.materialized,
          manifest: f.materialized.manifest.filter((entry) => !entry.path.endsWith('anonymous.png'))
        }
      } else if (mutation === 'extra') {
        f.materialized = {
          ...f.materialized,
          manifest: [
            ...f.materialized.manifest,
            { path: 'INPUT/unlisted.png', bytes: 0, digest: '' }
          ]
        }
      } else {
        await chmod(f.materialized.inputDir, 0o700)
        await rm(path)
        await symlink(join(dirname(f.materialized.root), '..', 'original.png'), path)
      }
      await expect(prepareClaudeCandidate(f)).rejects.toThrow(
        /manifest|bytes changed|private regular/
      )
      expect(await readdir(f.materialized.runtimeHome)).toEqual([])
    }
  )

  it('uses native framework configuration and replaces inherited process and hook environment', async () => {
    const f = await fixture()
    const prepared = await prepareClaudeCandidate({
      ...f,
      sourceEnv: {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'host-secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth',
        HTTP_PROXY: 'host-proxy',
        HOME: '/personal',
        CLAUDE_CONFIG_DIR: '/personal/config',
        OPEN_SCIENCE_DEBUG_AGENT: '1'
      }
    })
    expect(prepared.backend.env.HOME).toBe(join(f.materialized.runtimeHome, 'home'))
    expect(prepared.backend.env.ANTHROPIC_AUTH_TOKEN).toBe('synthetic-key')
    expect(prepared.backend.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(prepared.backend.env).not.toHaveProperty('HTTP_PROXY')
    expect(prepared.configuration.status).toBe('unknown')
    expect(JSON.stringify(prepared.configuration)).not.toContain('synthetic-key')
    expect(JSON.stringify(prepared.sessionSetup)).not.toContain('synthetic-key')
    const options = (prepared.sessionSetup.meta?.claudeCode as { options: Record<string, unknown> })
      .options
    expect(options.settingSources).toEqual([])
    expect(options.skills).toEqual([])
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Agent', 'Task']))
    expect(options.tools).toEqual(['Read', 'Write', 'Edit'])
    const spawning = vi.fn(() => ({ on: vi.fn() }))
    prepared.backend.framework.spawn({
      executablePath: f.binding.executablePath,
      args: [],
      env: { CLAUDE_CONFIG_DIR: 'ignored', ANTHROPIC_AUTH_TOKEN: 'another-key' },
      spawnProcess: spawning as never
    })
    const [command, args, spawnOptions] = spawning.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; shell: boolean }
    ]
    expect(command).toBe(process.execPath)
    expect(args[0]).toContain('claude-agent-acp/dist/index.js')
    expect(spawnOptions.shell).toBe(false)
    expect(spawnOptions.env).toEqual(prepared.backend.env)
  })

  it('permits only frozen reads/output writes and rejects unknown tools, fields and links', async () => {
    const f = await fixture()
    await prepareClaudeCandidate(f)
    const root = f.materialized.root
    expect(runGate(root, 'Read', { file_path: join(f.materialized.inputDir, 'input.txt') })).toBe(
      'allow'
    )
    expect(
      runGate(root, 'Write', {
        file_path: join(f.materialized.outputDir, 'new.txt'),
        content: 'ok'
      })
    ).toBe('allow')
    expect(
      runGate(root, 'Edit', {
        file_path: join(f.materialized.inputDir, 'input.txt'),
        old_string: 'frozen',
        new_string: 'changed'
      })
    ).toBe('deny')
    expect(runGate(root, 'Read', { file_path: '/etc/hosts' })).toBe('deny')
    expect(
      runGate(root, 'Read', {
        file_path: join(f.materialized.inputDir, 'input.txt'),
        unknown: true
      })
    ).toBe('deny')
    expect(runGate(root, 'Bash', { command: 'true' })).toBe('deny')
    expect(runGate(root, 'WebFetch', { url: 'https://example.com' })).toBe('deny')
    await symlink('/etc', join(f.materialized.outputDir, 'escape'))
    expect(
      runGate(root, 'Write', {
        file_path: join(f.materialized.outputDir, 'escape/new.txt'),
        content: 'bad'
      })
    ).toBe('deny')
    await symlink(join(root, 'outside-new.txt'), join(f.materialized.outputDir, 'dangling'))
    expect(
      runGate(root, 'Write', {
        file_path: join(f.materialized.outputDir, 'dangling'),
        content: 'bad'
      })
    ).toBe('deny')
    expect(await readFile(join(f.materialized.inputDir, 'input.txt'), 'utf8')).toBe('frozen')
  })

  it.each(['providerRef', 'runtimeVersion'] as const)(
    'rejects mismatched binding %s',
    async (field) => {
      const f = await fixture()
      f.binding[field] = 'different'
      await expect(prepareClaudeCandidate(f)).rejects.toThrow('binding')
    }
  )

  it('rejects shared credentials, model mismatch and unsupported protocols', async () => {
    for (const patch of [
      { type: 'claude-shared' as const },
      { model: 'different' },
      { apiEndpoints: ['responses' as const] }
    ]) {
      const f = await fixture()
      Object.assign(f.binding.provider, patch)
      await expect(prepareClaudeCandidate(f)).rejects.toThrow('binding')
    }
  })

  it('rejects instructions and input bytes changed after materialization', async () => {
    for (const target of ['instructions', 'input']) {
      const f = await fixture()
      const path =
        target === 'instructions'
          ? f.materialized.instructionsPath
          : join(f.materialized.inputDir, 'input.txt')
      await chmod(path, 0o600)
      await writeFile(path, 'changed')
      await expect(prepareClaudeCandidate(f)).rejects.toThrow('bytes changed')
    }
  })

  it.each(['plugin', 'home', 'tmp', 'claude'])(
    'rejects a pre-existing runtime %s symlink',
    async (name) => {
      const f = await fixture()
      const outside = join(f.materialized.root, 'outside')
      await mkdir(outside)
      await symlink(outside, join(f.materialized.runtimeHome, name))
      await expect(prepareClaudeCandidate(f)).rejects.toThrow()
      expect(await readdir(outside)).toEqual([])
    }
  )

  it.each([
    '---\nname: probe\nhooks: {}\n---\ntext',
    '---\nname: probe\ndescription: Probe\n---\n  !`echo bad`',
    '---\nname: probe\ndescription: Probe\n---\n```!\necho bad\n```'
  ])('rejects executable or extended Skill syntax %s', async (content) => {
    const f = await fixture([{ path: 'probe/SKILL.md', content }])
    await expect(prepareClaudeCandidate(f)).rejects.toThrow(/Skill|dynamic shell/)
  })

  it('checks the actual bounded native --version, not only matching binding declarations', async () => {
    const f = await fixture()
    await writeFile(f.binding.executablePath, "#!/bin/sh\necho '0.0.0 (Claude Code)'\n")
    await expect(prepareClaudeCandidate(f)).rejects.toThrow('version differs')
  })
  it('explicitly rejects the unsupported Windows command-hook profile', async () => {
    const f = await fixture()
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      await expect(prepareClaudeCandidate(f)).rejects.toThrow('POSIX profile')
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })
  it.each([
    '@/absolute/file',
    '@../relative',
    '@"quoted path"',
    '(@/punctuation)',
    'email@example.com'
  ])('rejects native @ text before any version probe or owner: %s', (text) => {
    expect(() => assertClaudeCandidateText(text)).toThrow('containing @ is unsupported')
  })

  it('checks all frozen native text surfaces before materializing runtime resources', async () => {
    for (const field of ['task', 'invocation', 'harness', 'skills']) {
      const f = await fixture()
      const resolved = {
        ...f.resolved,
        ...(field === 'task' ? { task: { ...f.resolved.task, prompt: '@../host' } } : {}),
        ...(field === 'invocation'
          ? { invocation: { ...f.resolved.invocation, mission: '@../host' } }
          : {}),
        ...(field === 'harness'
          ? { harness: { ...f.resolved.harness, instructions: '@../host' } }
          : {}),
        ...(field === 'skills'
          ? {
              harness: {
                ...f.resolved.harness,
                skills: [{ path: 'probe/SKILL.md', content: '@../host' }]
              }
            }
          : {})
      }
      await expect(prepareClaudeCandidate({ ...f, resolved })).rejects.toThrow(
        'containing @ is unsupported'
      )
      expect(await readdir(f.materialized.runtimeHome)).toEqual([])
    }
  })

  it('does not allow Skill arguments to reintroduce native automatic context expansion', async () => {
    const f = await fixture([
      { path: 'probe/SKILL.md', content: '---\nname: probe\ndescription: Probe\n---\nStatic text' }
    ])
    await prepareClaudeCandidate(f)
    expect(runGate(f.materialized.root, 'Skill', { skill: 'earthnano-candidate:probe' })).toBe(
      'allow'
    )
    expect(
      runGate(f.materialized.root, 'Skill', {
        skill: 'earthnano-candidate:probe',
        args: '@../host'
      })
    ).toBe('deny')
    expect(
      runGate(f.materialized.root, 'Skill', {
        skill: 'earthnano-candidate:probe',
        args: 'other text'
      })
    ).toBe('deny')
  })
})

it('routes only exact foreground Python/artifact MCP calls to the original broker', async () => {
  const f = await fixture([], true)
  await prepareClaudeCandidate(f)
  const root = f.materialized.root
  expect(
    runGate(root, 'mcp__open_science_notebook__notebook_execute', {
      code: 'print(1)',
      language: 'python',
      artifactVersionInputs: ['old-version']
    })
  ).toBe('ask')
  expect(runGate(root, 'mcp__open_science_notebook__notebook_execute', { code: 'print(1)' })).toBe(
    'ask'
  )
  expect(
    runGate(root, 'mcp__open_science_artifacts__write_artifact_file', {
      filename: 'report.json',
      source: { kind: 'localPath', path: 'report.json' },
      producerRunId: 'real-run'
    })
  ).toBe('ask')
  for (const [tool, args] of [
    ['mcp__other__notebook_execute', { code: 'print(1)' }],
    ['mcp__open_science_notebook__notebook_execute', { code: 'print(1)', language: 'r' }],
    ['mcp__open_science_notebook__notebook_execute', { code: 'print(1)', background: true }],
    [
      'mcp__open_science_notebook__notebook_execute',
      { code: 'print(1)', artifactVersionInputs: ['foreign'] }
    ],
    ['mcp__open_science_notebook__manage_packages', { language: 'python', packages: ['x'] }],
    [
      'mcp__open_science_notebook__notebook_switch_runtime',
      { language: 'python', runtimeId: 'other' }
    ],
    [
      'mcp__open_science_artifacts__write_artifact_file',
      { filename: 'report.json', content: '{}' }
    ],
    ['Bash', { command: 'python3 code.py' }]
  ] as const)
    expect(runGate(root, tool, args)).toBe('deny')
})

it('requires explicit R in the R native gate and keeps original scoped broker ownership', async () => {
  const f = await fixture([], 'r')
  await prepareClaudeCandidate(f)
  const root = f.materialized.root
  for (const prefix of ['mcp__open_science_notebook__', 'mcp__open-science-notebook__']) {
    expect(
      runGate(root, prefix + 'notebook_execute', {
        code: 'print(1)',
        language: 'r',
        artifactVersionInputs: ['old-version']
      })
    ).toBe('ask')
    expect(runGate(root, prefix + 'notebook_state', {})).toBe('ask')
    expect(runGate(root, prefix + 'list_notebook_runtimes', {})).toBe('ask')
    for (const args of [
      { code: 'print(1)' },
      { code: 'print(1)', language: 'python' },
      { code: 'print(1)', language: 'r', background: true },
      { code: 'print(1)', language: 'r', artifactVersionInputs: ['foreign'] },
      { code: 'print(1)', language: 'r', kernelSkillIds: ['unfrozen'] },
      { code: 'print(1)', language: 'r', runtimeId: '/another/R' }
    ])
      expect(runGate(root, prefix + 'notebook_execute', args)).toBe('deny')
    for (const tool of [
      'manage_packages',
      'notebook_bind_runtime',
      'notebook_switch_runtime',
      'shell_execute'
    ])
      expect(runGate(root, prefix + tool, { language: 'r', runtimeId: '/usr/bin/R' })).toBe('deny')
  }
  expect(runGate(root, 'mcp__other__notebook_execute', { code: 'print(1)', language: 'r' })).toBe(
    'deny'
  )
  expect(runGate(root, 'Bash', { command: 'Rscript run.R' })).toBe('deny')
  expect(
    runGate(root, 'mcp__open_science_artifacts__write_artifact_file', {
      filename: 'report.json',
      source: { kind: 'localPath', path: 'report.json' },
      producerRunId: 'real-r-run'
    })
  ).toBe('ask')
})

it('rejects an R profile whose runtime language was replaced before native preparation', async () => {
  const f = await fixture([], 'r')
  const resolved: ResolvedCandidateSnapshots = {
    ...f.resolved,
    environment: {
      ...f.resolved.environment,
      notebook: {
        runtime: { ...f.resolved.environment.notebook!.runtime, language: 'python' }
      }
    }
  }
  await expect(prepareClaudeCandidate({ ...f, resolved })).rejects.toThrow(
    'Unsupported Claude candidate profile'
  )
})
