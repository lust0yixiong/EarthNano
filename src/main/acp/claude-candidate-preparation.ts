import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { claudeCodeFramework } from '../agent-framework/claude-code'
import type { ResolvedAgentBackend, SessionSetup } from '../agent-framework/types'
import type {
  MaterializedCandidate,
  ResolvedCandidateSnapshots
} from '../earthnano/candidate-snapshot'
import type {
  EffectiveConfiguration,
  ExecutionRequest
} from '../../shared/earthnano/execution-port'
import type { ResolvedProvider } from '../settings/provider-env'
import type { AcpRuntimeOptions } from './runtime-contract'
import { notebookLanguageForTools } from '../../shared/earthnano/notebook-profile'
import {
  isComputeToolsProfile,
  normalizeFrozenComputeContext
} from '../../shared/earthnano/compute-profile'
import type { NotebookLanguage } from '../../shared/notebook-language-contract'
import { readOpenFileChunks } from '../bounded-file-io'
import { assertWithinResourceBudget } from '../resource-budget'

export interface ClaudeCandidateBinding {
  executablePath: string
  runtimeVersion: string
  providerRef: string
  provider: ResolvedProvider
}

export interface PreparedClaudeCandidate {
  backend: ResolvedAgentBackend
  sessionSetup: SessionSetup
  configuration: EffectiveConfiguration
  runtimeOptions: Pick<
    AcpRuntimeOptions,
    'defaultCwd' | 'resolveBackend' | 'additionalProtectedReadRoots'
  >
}

const inheritedKeys = [
  'PATH',
  'Path',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'LANG',
  'LC_ALL'
] as const
const nativeTools = ['Read', 'Write', 'Edit', 'Skill']
const pluginName = 'earthnano-candidate'
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`

/** The native CLI expands file mentions before tool hooks. This initial profile deliberately
 * rejects every @ (including email), rather than guessing its tokenizer or silently rewriting text.
 * Recheck owner-composed prompt text/history with this same policy before dispatch. */
export const assertClaudeCandidateText = (text: string): void => {
  if (text.includes('@')) throw new Error('Claude candidate text containing @ is unsupported')
  if (/!\s*`|`{3,}\s*!/.test(text))
    throw new Error('Claude candidate dynamic shell context is unsupported')
}

const verifyMaterialization = async (materialized: MaterializedCandidate): Promise<void> => {
  const { task, harness, invocation } = materialized.snapshots
  const text = (content: string): { content: string; bytes: number; digest: string } => ({
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    digest: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`
  })
  const expected = new Map<string, { content?: string; bytes: number; digest: string }>([
    ...task.files.map(
      (file) => [join(materialized.inputDir, file.path), text(file.content)] as const
    ),
    ...(invocation.contextFiles ?? []).map(
      (file) => [join(materialized.inputDir, file.path), text(file.content)] as const
    ),
    [materialized.instructionsPath, text(harness.instructions)] as const,
    ...harness.skills.map(
      (file) => [join(materialized.skillsDir, file.path), text(file.content)] as const
    ),
    ...(invocation.assets ?? []).map(
      ({ path, artifact }) =>
        [
          join(materialized.inputDir, path),
          { bytes: artifact.sizeBytes, digest: artifact.digest }
        ] as const
    )
  ])
  if (expected.size !== materialized.manifest.length)
    throw new Error('Candidate manifest does not cover its frozen files')
  const seen = new Set<string>()
  for (const entry of materialized.manifest) {
    const path = join(materialized.root, entry.path)
    if (!inside(materialized.root, path) || !expected.has(path) || seen.has(path))
      throw new Error('Candidate manifest contains an unexpected path')
    seen.add(path)
    const frozen = expected.get(path)!
    if (entry.bytes !== frozen.bytes || entry.digest !== frozen.digest)
      throw new Error('Candidate manifest differs from its frozen files')
    let ancestor = dirname(path)
    while (inside(materialized.root, ancestor)) {
      const stat = await lstat(ancestor)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Candidate file ancestor is a link')
      if (ancestor === materialized.root) break
      ancestor = dirname(ancestor)
    }
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
      throw new Error('Candidate file is not a private regular file')
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      let size: number
      let digest: string
      if (frozen.content !== undefined) {
        const bytes = await handle.readFile()
        if (!bytes.equals(Buffer.from(frozen.content, 'utf8')))
          throw new Error('Candidate materialization bytes changed')
        size = bytes.byteLength
        digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      } else {
        const hash = createHash('sha256')
        size = 0
        // Reuse the original paced, bounded-memory reader on the already verified file handle.
        for await (const chunk of readOpenFileChunks(handle)) {
          size += chunk.byteLength
          assertWithinResourceBudget('file', size, frozen.bytes)
          hash.update(chunk)
        }
        digest = `sha256:${hash.digest('hex')}`
      }
      const after = await handle.stat()
      const current = await lstat(path)
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.dev !== before.dev ||
        stat.ino !== before.ino ||
        stat.size !== frozen.bytes ||
        size !== frozen.bytes ||
        digest !== frozen.digest ||
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.nlink !== 1 ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.nlink !== 1 ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        current.size !== after.size ||
        current.mtimeMs !== after.mtimeMs ||
        current.ctimeMs !== after.ctimeMs
      )
        throw new Error('Candidate materialization bytes changed')
    } finally {
      await handle.close()
    }
  }
}

// A CLI command hook, not an SDK callback serialized over ACP. Unknown tools/fields fail closed.
// This is a capability gate for this directory/process profile, not an OS filesystem sandbox.
const gateSource = (
  input: string,
  output: string,
  plugin: string,
  names: string[],
  scientificInputs?: readonly string[],
  scientificLanguage?: NotebookLanguage,
  compute?: true
): string => `
const fs = require('node:fs');
const path = require('node:path');
const roots = ${JSON.stringify({ input, output, plugin, names, scientificInputs, scientificLanguage, compute })};
const inside = (root, target) => { const rel=path.relative(root,target); return rel==='' || (rel!=='..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel)); };
const checked = target => {
  if (!path.isAbsolute(target)) throw Error('Absolute path required');
  let cursor=path.resolve(target);
  while (true) {
    let stat;
    try { stat=fs.lstatSync(cursor); } catch(error) { if(error.code!=='ENOENT') throw error; }
    if (stat) {
      if (stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink>1)) throw Error('Link denied');
      if (fs.realpathSync(cursor)!==cursor) throw Error('Aliased path denied');
    }
    const next=path.dirname(cursor); if(next===cursor) break; cursor=next;
  }
  return path.resolve(target);
};
let data='';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk=>{ data+=chunk; if(data.length>1048576) process.exit(2); });
process.stdin.on('end', ()=>{
  let decision='deny';
  try {
    const event=JSON.parse(data), tool=event.tool_name, args=event.tool_input;
    if(event.hook_event_name!=='PreToolUse' || !args || typeof args!=='object' || Array.isArray(args)) throw Error('Invalid hook');
    const scientific = roots.scientificInputs;
    const mcp = /^(?:mcp__open_science_notebook__|mcp__open-science-notebook__)(notebook_execute|notebook_state|list_notebook_runtimes)$/.exec(tool);
    const artifact = /^(?:mcp__open_science_artifacts__|mcp__open-science-artifacts__)write_artifact_file$/.test(tool);
    const control = roots.compute && /^(?:mcp__open_science_notebook__|mcp__open-science-notebook__)repl_execute$/.test(tool);
    if ((scientific && (mcp || artifact)) || (roots.compute && (control || artifact))) {
      if (control) {
        if(Object.keys(args).some(key=>!['code','background','timeoutMs'].includes(key)) || typeof args.code!=='string' || (args.background!==undefined && args.background!==false) || (args.timeoutMs!==undefined && (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs<=0))) throw Error('Outside frozen Compute control profile');
      } else if (mcp?.[1]==='notebook_execute') {
        if(Object.keys(args).some(key=>!['code','cellId','language','background','kernelSkillIds','artifactVersionInputs'].includes(key)) || typeof args.code!=='string' || (roots.scientificLanguage==='r' ? args.language!=='r' : args.language!==undefined && args.language!=='python') || (args.background!==undefined && args.background!==false) || (args.kernelSkillIds!==undefined && (!Array.isArray(args.kernelSkillIds) || args.kernelSkillIds.length)) || (args.artifactVersionInputs!==undefined && (!Array.isArray(args.artifactVersionInputs) || args.artifactVersionInputs.some(id=>!scientific.includes(id))))) throw Error('Outside frozen scientific language profile');
      } else if (artifact && (typeof args.producerRunId!=='string' || !args.producerRunId)) throw Error('Notebook producer required');
      decision='ask';
      process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:decision,permissionDecisionReason:'Original application permission broker owns this scoped MCP call'}}));
      return;
    }
    const fields={Read:['file_path','offset','limit','pages'],Write:['file_path','content'],Edit:['file_path','old_string','new_string','replace_all'],Skill:['skill','args']}[tool];
    if(!fields || Object.keys(args).some(key=>!fields.includes(key))) throw Error('Unsupported tool/input');
    if(tool==='Skill') {
      if(roots.names.includes(args.skill) && (args.args===undefined || args.args==='')) decision='allow';
    } else {
      if(typeof args.file_path!=='string') throw Error('Missing path');
      const target=checked(args.file_path);
      const readable=[roots.input,roots.output,roots.plugin].some(root=>inside(root,target));
      if(tool==='Read' ? readable : inside(roots.output,target)) decision='allow';
    }
  } catch {}
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:decision,permissionDecisionReason:decision==='allow'?'Frozen candidate capability':'Outside frozen candidate capability'}}));
});
`

/** Compiles only this supported frozen profile. It neither creates Sessions nor claims native loading. */
export const prepareClaudeCandidate = async ({
  resolved,
  materialized,
  binding,
  role,
  sourceEnv = process.env
}: {
  resolved: ResolvedCandidateSnapshots
  materialized: MaterializedCandidate
  binding: ClaudeCandidateBinding
  role?: ExecutionRequest['role']
  sourceEnv?: NodeJS.ProcessEnv
}): Promise<PreparedClaudeCandidate> => {
  if (process.platform === 'win32')
    throw new Error('Claude candidate command hooks require the POSIX profile')
  const { agent, harness, environment, invocation } = resolved
  const scientificLanguage = notebookLanguageForTools(harness.tools)
  const scientific = scientificLanguage !== undefined
  const compute = isComputeToolsProfile(harness.tools)
  if (compute) {
    if (role !== 'baseline' && role !== 'candidate')
      throw new Error('Compute tools require an original baseline or candidate execution role')
    normalizeFrozenComputeContext(environment.compute)
  }
  const scientificInputs = scientific
    ? resolved.task.managedInputs?.map((input) => input.inputFileVersionId)
    : undefined
  for (const text of [
    resolved.task.prompt,
    invocation.mission,
    harness.instructions,
    ...harness.skills.map((skill) => skill.content)
  ])
    assertClaudeCandidateText(text)
  if (
    agent.backend !== 'claude-code' ||
    (!scientific && !compute && harness.tools !== 'workspace-only') ||
    environment.isolation !== 'directory-process' ||
    (compute
      ? !environment.compute ||
        environment.notebook !== undefined ||
        environment.network !== 'provider-and-notebook-policy'
      : environment.compute !== undefined) ||
    (!compute &&
      (scientific
        ? !environment.notebook ||
          environment.notebook.runtime.language !== scientificLanguage ||
          !scientificInputs?.length ||
          environment.network !== 'provider-and-notebook-policy'
        : environment.network !== 'provider-only'))
  )
    throw new Error('Unsupported Claude candidate profile')
  if (
    binding.providerRef !== agent.providerRef ||
    binding.runtimeVersion !== agent.runtimeVersion ||
    binding.provider.model !== agent.model ||
    binding.provider.type !== 'custom' ||
    !binding.provider.key ||
    !binding.provider.baseUrl ||
    !isAbsolute(binding.executablePath) ||
    binding.provider.apiEndpoints?.some((endpoint) => endpoint !== 'messages')
  )
    throw new Error('Claude candidate binding does not match the frozen Agent')
  const endpoint = new URL(binding.provider.baseUrl)
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('Unsupported Claude provider endpoint')
  if (JSON.stringify(resolved) !== JSON.stringify(materialized.snapshots))
    throw new Error('Materialized snapshots differ from resolved inputs')
  const root = await realpath(materialized.root)
  for (const path of [
    materialized.cwd,
    materialized.inputDir,
    materialized.outputDir,
    materialized.runtimeHome,
    materialized.harnessDir,
    materialized.skillsDir
  ]) {
    if (!inside(root, path) || (await realpath(path)) !== path)
      throw new Error('Candidate directory escapes its materialization')
  }
  if (materialized.instructionsPath !== join(materialized.harnessDir, 'instructions.md'))
    throw new Error('Unexpected candidate instructions path')
  await verifyMaterialization(materialized)

  const home = join(materialized.runtimeHome, 'home')
  const plugin = join(materialized.runtimeHome, 'plugin')
  const temp = join(materialized.runtimeHome, 'tmp')
  if ((await readdir(materialized.runtimeHome)).length)
    throw new Error('Candidate runtime must be empty')
  // These names must be new. Never traverse pre-existing runtime subdirectories or symlinks.
  for (const path of [home, plugin, temp, join(materialized.runtimeHome, 'claude')])
    await mkdir(path, { mode: 0o700 })
  const skillNames = new Set<string>()
  for (const skill of harness.skills) {
    // No candidate-provided executable hooks, plugins, configuration, or helper scripts.
    if (
      !/^[a-z0-9][a-z0-9-]*\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:md|txt|json)$/.test(
        skill.path
      ) ||
      skill.path.split('/').some((part) => part === '..') ||
      /^(?:hooks|allowed-tools|context|agent|disable-model-invocation)\s*:/m.test(skill.content) ||
      /!\s*`/.test(skill.content) ||
      skill.content.includes('```!')
    )
      throw new Error('Unsupported candidate Skill file or policy')
    if (skill.path.endsWith('/SKILL.md')) {
      // Deliberately narrow frontmatter grammar; no YAML extensibility or executable policies.
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill.content)
      if (!frontmatter) throw new Error('Skill requires simple name/description frontmatter')
      const fields = frontmatter[1]!.split(/\r?\n/)
      if (
        fields.length !== 2 ||
        fields.some(
          (line) => !/^(?:name|description): [a-zA-Z0-9][a-zA-Z0-9 .,()_-]*$/.test(line)
        ) ||
        !fields.includes(`name: ${skill.path.split('/')[0]}`) ||
        !fields.some((line) => line.startsWith('description: '))
      )
        throw new Error('Unsupported Skill frontmatter')
    }
    const target = join(plugin, 'skills', skill.path)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, skill.content, { mode: 0o400, flag: 'wx' })
    if (/^[^/]+\/SKILL\.md$/.test(skill.path)) skillNames.add(skill.path.split('/')[0]!)
  }
  for (const skill of harness.skills)
    if (!skillNames.has(skill.path.split('/')[0]!)) throw new Error('Skill requires SKILL.md')
  await mkdir(join(plugin, '.claude-plugin'), { mode: 0o700 })
  await writeFile(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: pluginName, version: '1.0.0' }),
    { mode: 0o400 }
  )
  const names = [...skillNames].map((name) => `${pluginName}:${name}`).sort()
  const gate = join(materialized.runtimeHome, 'tool-gate.cjs')
  await writeFile(
    gate,
    gateSource(
      materialized.inputDir,
      materialized.outputDir,
      plugin,
      names,
      scientificInputs,
      scientificLanguage,
      compute ? true : undefined
    ),
    {
      mode: 0o400,
      flag: 'wx'
    }
  )
  const modelConfig = claudeCodeFramework.prepareModelConfig(binding.provider, {
    storageRoot: materialized.runtimeHome,
    executablePath: binding.executablePath
  })
  const cleanEnv: Record<string, string> = {}
  for (const key of inheritedKeys) if (sourceEnv[key] !== undefined) cleanEnv[key] = sourceEnv[key]!
  Object.assign(cleanEnv, modelConfig.env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'appdata'),
    LOCALAPPDATA: join(home, 'local-appdata'),
    XDG_CONFIG_HOME: join(home, 'xdg-config'),
    XDG_CACHE_HOME: join(home, 'xdg-cache'),
    XDG_DATA_HOME: join(home, 'xdg-data'),
    XDG_STATE_HOME: join(home, 'xdg-state'),
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    NO_PROXY: endpoint.hostname,
    no_proxy: endpoint.hostname
  })
  const settingsEnv = Object.fromEntries(
    Object.entries(cleanEnv).filter(([key]) => !key.startsWith('ANTHROPIC_'))
  )
  const version = await promisify(execFile)(binding.executablePath, ['--version'], {
    cwd: materialized.cwd,
    env: settingsEnv,
    timeout: 10_000,
    maxBuffer: 4096,
    windowsHide: true,
    shell: false
  })
  if (version.stdout.trim() !== `${agent.runtimeVersion} (Claude Code)`)
    throw new Error('Native Claude version differs from the frozen Agent')
  const sessionOptions = {
    settingSources: [],
    strictMcpConfig: true,
    managedSettings: { disableSkillShellExecution: true },
    mcpServers: {},
    tools: names.length ? nativeTools : nativeTools.filter((tool) => tool !== 'Skill'),
    skills: names,
    plugins: names.length ? [{ type: 'local', path: plugin }] : [],
    settings: {
      disableSkillShellExecution: true,
      env: settingsEnv,
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(gate)}` }]
          }
        ]
      }
    }
  }
  const backend: ResolvedAgentBackend = {
    framework: {
      ...claudeCodeFramework,
      spawn: (input) =>
        claudeCodeFramework.spawn({
          ...input,
          // The normal spawner strips credentials, but otherwise inherits host env. Replace it here.
          spawnProcess: (command, args, options) =>
            (input.spawnProcess ?? spawn)(command, args, {
              ...options,
              cwd: materialized.cwd,
              env: {
                ...cleanEnv,
                ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {})
              },
              shell: false
            })
        })
    },
    executablePath: binding.executablePath,
    env: cleanEnv,
    providerId: binding.providerRef,
    backendId: `claude-candidate:${root}`,
    sessionOptions,
    systemPromptAppends: [harness.instructions],
    contextUsageModel: agent.model
  }
  const sessionSetup = backend.framework.buildSessionSetup({
    systemPromptAppends: [harness.instructions],
    sessionOptions
  })
  const configuration: EffectiveConfiguration = {
    status: 'unknown',
    requestedDigest: invocation.harnessRevisionRef.digest,
    materializedDigest:
      'sha256:' +
      createHash('sha256')
        .update(
          JSON.stringify({
            projection: materialized.materializedDigest,
            instructions: harness.instructions,
            skills: harness.skills,
            tools: sessionOptions.tools,
            version: binding.runtimeVersion,
            provider: { ref: binding.providerRef, endpoint: endpoint.href, model: agent.model },
            nativeSessionSetup: sessionSetup,
            gateDigest: createHash('sha256')
              .update(
                gateSource(
                  materialized.inputDir,
                  materialized.outputDir,
                  plugin,
                  names,
                  scientificInputs,
                  scientificLanguage,
                  compute ? true : undefined
                )
              )
              .digest('hex')
          })
        )
        .digest('hex'),
    backend: 'claude-code',
    model: agent.model,
    runtimeVersion: binding.runtimeVersion,
    instructions: [materialized.instructionsPath],
    skills: names,
    tools: sessionOptions.tools,
    confirmation:
      'Compiled native Session configuration; loading requires trusted runtime/provider observation. Directory/process isolation and tool-level network restriction; no OS sandbox claim.'
  }
  return {
    backend,
    sessionSetup,
    configuration,
    runtimeOptions: {
      defaultCwd: materialized.cwd,
      resolveBackend: () => backend,
      additionalProtectedReadRoots: [materialized.runtimeHome, materialized.harnessDir]
    }
  }
}
