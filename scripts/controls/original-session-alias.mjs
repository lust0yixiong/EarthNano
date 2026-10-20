/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone JavaScript control runs directly in Node without a build or TS loader. */
/** Opt-in causal control. Imports two exact subject files (original pin by default) from Git into an
 * isolated temporary overlay; sibling dependencies remain the checkout's retained modules.
 * No provider, ACP subprocess, Core, Notebook kernel, data files or remote host is used. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const args = process.argv.slice(2)
let outputPath, candidateRef
while (args.length) {
  const flag = args.shift(),
    value = args.shift()
  if (flag === '--output' && !outputPath && value && isAbsolute(value)) outputPath = value
  else if (flag === '--candidate-ref' && !candidateRef && /^[a-f0-9]{40}$/.test(value ?? ''))
    candidateRef = value
  else
    throw new Error(
      'Usage: node scripts/controls/original-session-alias.mjs [--output ABSOLUTE_JSON_PATH] [--candidate-ref FULL_COMMIT_SHA]'
    )
}
const root = fileURLToPath(new URL('../../', import.meta.url))
const pin = '9e18c7d3c143a9dba49c7a586ad6cac8096f6dd5'
const sourcePins = {
  'src/main/acp/session-capability-owner.ts':
    '572c7b412a56e4842c322ef73f375f41dd0f476234c1bb973f0aa310a7f914ca',
  'src/main/notebook/local-rpc-server.ts':
    '3fa48425983c7bb6eb866646e4fc7b0d940b5b52a31672ca9772f0561283d424'
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const overlay = await mkdtemp(join(tmpdir(), 'earthnano-original-alias-control-'))
const sourceEvidence = []
let rpc
const realNow = Date.now
try {
  // Copy only the named original source files. Resolve every other module against this checkout,
  // making the mixed-dependency boundary explicit instead of claiming a full upstream rebuild.
  await mkdir(join(overlay, 'src/main/acp'), { recursive: true })
  await mkdir(join(overlay, 'src/main/notebook'), { recursive: true })
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === 'src') continue
    await symlink(
      join(root, entry.name),
      join(overlay, entry.name),
      entry.isDirectory() ? 'dir' : 'file'
    )
  }
  for (const entry of await readdir(join(root, 'src'), { withFileTypes: true })) {
    if (entry.name === 'main') continue
    await symlink(
      join(root, 'src', entry.name),
      join(overlay, 'src', entry.name),
      entry.isDirectory() ? 'dir' : 'file'
    )
  }
  for (const entry of await readdir(join(root, 'src/main'), { withFileTypes: true })) {
    if (['acp', 'notebook'].includes(entry.name)) continue
    await symlink(
      join(root, 'src/main', entry.name),
      join(overlay, 'src/main', entry.name),
      entry.isDirectory() ? 'dir' : 'file'
    )
  }
  for (const directory of ['acp', 'notebook']) {
    for (const entry of await readdir(join(root, 'src/main', directory), { withFileTypes: true })) {
      const relative = `src/main/${directory}/${entry.name}`
      if (Object.hasOwn(sourcePins, relative)) continue
      await symlink(
        join(root, relative),
        join(overlay, relative),
        entry.isDirectory() ? 'dir' : 'file'
      )
    }
  }
  for (const [relative, expected] of Object.entries(sourcePins)) {
    const bytes = execFileSync('git', ['show', `${pin}:${relative}`], { cwd: root })
    assert.equal(sha256(bytes), expected, 'Original source pin changed')
    const subjectBytes = candidateRef
      ? execFileSync('git', ['show', `${candidateRef}:${relative}`], { cwd: root })
      : bytes
    await writeFile(join(overlay, relative), subjectBytes, { mode: 0o600 })
    sourceEvidence.push({
      path: relative,
      originalSha256: expected,
      subjectSha256: sha256(subjectBytes),
      checkoutSha256: sha256(await readFile(join(root, relative)))
    })
  }
  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false })
  const { AcpSessionCapabilityOwner, CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY } =
    await jiti.import(join(overlay, 'src/main/acp/session-capability-owner.ts'))
  const { NotebookLocalRpcServer } = await jiti.import(
    join(overlay, 'src/main/notebook/local-rpc-server.ts')
  )
  const { claudeCodeFramework } = await jiti.import(
    join(root, 'src/main/agent-framework/claude-code.ts')
  )
  const routed = []
  rpc = new NotebookLocalRpcServer(
    {
      state: async (request) => {
        routed.push({ sessionId: request.sessionId, projectId: request.projectId })
        return { sessionId: request.sessionId, projectId: request.projectId }
      }
    },
    { transport: 'tcp' }
  )
  const issued = []
  const createOwner = () =>
    new AcpSessionCapabilityOwner({
      artifacts: {
        dataRoot: overlay,
        projectId: 'project',
        mcpEntryPath: '/control/main.js',
        getRpcConnection: () => rpc.ensureStarted()
      },
      notebook: {
        projectId: 'project',
        mcpEntryPath: '/control/main.js',
        memoryTools: false,
        getRpcConnection: async ({ sessionId, projectId, memoryTools }) => {
          const connection = await rpc.issueSessionConnection(
            sessionId,
            projectId,
            `root-frame-${sessionId}`,
            memoryTools
          )
          issued.push(connection)
          return connection
        },
        registerSessionAlias: (alias, sessionId) => rpc.registerSessionAlias(alias, sessionId),
        releaseSessionCapabilities: (sessionId, tokens) =>
          rpc.releaseSessionCapabilitiesIfOwned(sessionId, tokens)
      }
    })
  const request = {
    framework: claudeCodeFramework,
    nativeMcpEnabled: true,
    bridgeMcpAliasesEnabled: false,
    policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
    sessionCwd: '/control/workspace',
    projectId: 'project'
  }
  const env = (provision, name) =>
    provision.mcpServers
      .flatMap((server) => ('env' in server ? server.env : []))
      .find((entry) => entry.name === name)?.value
  const call = async (connection) => {
    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'state',
        params: {
          sessionId: 'agent-body-is-not-authority',
          projectId: 'agent-project',
          workspaceCwd: '/control/workspace'
        }
      })
    })
    return { status: response.status, body: await response.json() }
  }
  // Two independent original owners, each at its first start, within the same millisecond.
  Date.now = () => 1792518290450
  const firstOwner = createOwner(),
    secondOwner = createOwner()
  const first = await firstOwner.provision(request)
  const firstBeforeReplacement = await call(issued[0])
  assert.equal(firstBeforeReplacement.status, 200)
  const second = await secondOwner.provision(request)
  const aliases = {
    firstArtifact: env(first, 'OPEN_SCIENCE_ARTIFACT_SESSION_ID'),
    secondArtifact: env(second, 'OPEN_SCIENCE_ARTIFACT_SESSION_ID'),
    firstNotebook: env(first, 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID'),
    secondNotebook: env(second, 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID')
  }
  assert.ok(aliases.firstArtifact && aliases.firstNotebook)
  const compareAliases = candidateRef ? assert.notEqual : assert.equal
  compareAliases(aliases.firstArtifact, aliases.secondArtifact)
  compareAliases(aliases.firstNotebook, aliases.secondNotebook)
  const firstAfterReplacement = await call(issued[0])
  if (candidateRef) assert.equal(firstAfterReplacement.status, 200)
  else
    assert.deepEqual(firstAfterReplacement, {
      status: 401,
      body: { error: 'Invalid notebook RPC token.' }
    })
  assert.equal((await call(issued[1])).status, 200)
  first.commit('canonical-first')
  const secondAfterFirstCommit = await call(issued[1])
  assert.deepEqual(secondAfterFirstCommit, {
    status: 200,
    body: {
      result: {
        sessionId: candidateRef ? aliases.secondNotebook : 'canonical-first',
        projectId: 'project'
      }
    }
  })
  second.commit('canonical-second')
  const secondAfterOwnCommit = await call(issued[1])
  // The second owner authenticated successfully but its surviving capability was already adopted
  // by first.commit. The candidate branch instead requires isolation and original owner cleanup.
  let afterFirstDispose
  if (candidateRef) {
    assert.deepEqual(secondAfterOwnCommit, {
      status: 200,
      body: { result: { sessionId: 'canonical-second', projectId: 'project' } }
    })
    assert.deepEqual(await call(issued[0]), {
      status: 200,
      body: { result: { sessionId: 'canonical-first', projectId: 'project' } }
    })
    firstOwner.dispose(['canonical-first'])
    afterFirstDispose = { first: await call(issued[0]), second: await call(issued[1]) }
    assert.deepEqual(afterFirstDispose.second, secondAfterOwnCommit)
    assert.equal(afterFirstDispose.first.status, 401)
  } else {
    assert.deepEqual(secondAfterOwnCommit, secondAfterFirstCommit)
    assert.equal(routed.at(-1).sessionId, 'canonical-first')
  }
  // Counterfactual controls preserve the original code. One shared owner has an increasing
  // sequence; explicit stable identities bypass provisional aliases. Neither reproduces crossover.
  Date.now = () => 1792518291450
  const sharedOwner = createOwner(),
    sharedStart = issued.length
  const sharedFirst = await sharedOwner.provision(request)
  const sharedSecond = await sharedOwner.provision(request)
  assert.notEqual(
    env(sharedFirst, 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID'),
    env(sharedSecond, 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID')
  )
  sharedFirst.commit('shared-owner-first')
  sharedSecond.commit('shared-owner-second')
  const sharedRoutes = await Promise.all(issued.slice(sharedStart).map(call))
  assert.deepEqual(
    sharedRoutes.map((row) => row.body.result.sessionId),
    ['shared-owner-first', 'shared-owner-second']
  )
  const stableStart = issued.length
  const stableFirst = await createOwner().provision({
    ...request,
    stableAppSessionId: 'stable-first'
  })
  const stableSecond = await createOwner().provision({
    ...request,
    stableAppSessionId: 'stable-second'
  })
  assert.equal(env(stableFirst, 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID'), 'stable-first')
  assert.equal(env(stableSecond, 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID'), 'stable-second')
  stableFirst.commit('stable-first')
  stableSecond.commit('stable-second')
  const stableRoutes = await Promise.all(issued.slice(stableStart).map(call))
  assert.deepEqual(
    stableRoutes.map((row) => row.body.result.sessionId),
    ['stable-first', 'stable-second']
  )
  Date.now = realNow
  const report = JSON.stringify(
    {
      schemaVersion: 1,
      control: candidateRef
        ? 'candidate-first-start-alias-isolation'
        : 'original-first-start-alias-collision',
      status: candidateRef ? 'isolated' : 'confirmed',
      subjectRef: candidateRef ?? pin,
      originalPin: pin,
      checkoutHead: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8'
      }).trim(),
      sources: sourceEvidence,
      dependencies:
        'retained checkout modules; only owner/RPC copied byte-exact from subjectRef; original pin hashes separately verified',
      runtime: { node: process.version },
      aliases,
      observations: {
        firstBeforeReplacement,
        firstAfterReplacement,
        secondAfterFirstCommit,
        secondAfterOwnCommit,
        ...(afterFirstDispose ? { afterFirstDispose } : {})
      },
      counterfactuals: {
        sameOwnerSameMillisecond: sharedRoutes,
        independentOwnersStableIds: stableRoutes
      },
      limitations: [
        'No full upstream dependency rebuild',
        'Notebook service only records authenticated state routing; no kernel or real Artifact publication',
        'No original token/secret is printed',
        'No live API/model/Core/remote dispatch'
      ]
    },
    null,
    2
  )
  if (outputPath) await writeFile(outputPath, report + '\n', { mode: 0o600 })
  else process.stdout.write(report + '\n')
} finally {
  Date.now = realNow
  await rpc?.close()
  await rm(overlay, { recursive: true, force: true })
}
