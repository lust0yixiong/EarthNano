import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import fixtures from '../../../contracts/execution/fixtures.json'
import type { ExecutionRequest } from '../../shared/earthnano/execution-port'
import { reconcilePersistentOptimization } from './optimization-reconciliation'
import { outputDigest } from './output-checks'
import { writeResumeJson, type OptimizationResumeIdentity } from './optimization-resume'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

it.skipIf(process.platform === 'win32')(
  'reconciles a real exited writer only after its original process-tree owner durably confirmed retirement, without replay',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'earthnano-real-owner-recovery-'))
    roots.push(root)
    const identity = {
      projectId: 'demo',
      sourceSessionId: 'source',
      executionLimit: 10
    } as OptimizationResumeIdentity
    writeResumeJson(join(root, 'resume.json'), {
      schemaVersion: 1,
      optimizationId: 'trial',
      identity,
      identityDigest: outputDigest(identity),
      methodDigest: `sha256:${'a'.repeat(64)}`
    })
    const request: ExecutionRequest = {
      ...(structuredClone(fixtures.valid) as ExecutionRequest),
      role: 'baseline',
      origin: { kind: 'optimization', optimizationId: 'trial', stageId: 'base1' },
      interactionPolicy: 'deny-unresolved'
    }
    // Use the same isolated TypeScript loading pattern as the original process-tree native probes.
    // The writer exits at the real post-reap/pre-Core-commit boundary; no lock PID is fabricated.
    const script = `
    const fs = require('node:fs')
    const ts = require('typescript')
    require.extensions['.ts'] = (instance, filename) => instance._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, filename)
    const {spawn} = require('node:child_process')
    const {ExecutionCore} = require(${JSON.stringify(resolve('src/main/earthnano/execution-core.ts'))})
    const {FileExecutionStore} = require(${JSON.stringify(resolve('src/main/earthnano/execution-store.ts'))})
    const {persistCandidateOwnerSettlement} = require(${JSON.stringify(resolve('src/main/earthnano/candidate-settlement-witness.ts'))})
    const tree = require(${JSON.stringify(resolve('src/main/process-tree.ts'))})
    const request = ${JSON.stringify(request)}
    const root = ${JSON.stringify(root)}
    let child
    const store = new FileExecutionStore(require('node:path').join(root,'execution.json'))
    const core = new ExecutionCore(store, {execute: async (request,context) => {
      const identity = {sessionId:'original-owned-session',promptMessageId:'original-owned-prompt'}
      context.identity(identity)
      context.running()
      child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'})
      tree.registerOwnedPosixProcessGroup(child)
      tree.trackOwnedPosixProcessTree(child)
      const cleanup = await tree.terminateProcessTree(child)
      if (!cleanup.reaped) throw new Error('Original process owner did not confirm retirement')
      await persistCandidateOwnerSettlement(root,{executionId:context.executionId,request,identity,outcome:{phase:'failed',cleanup:'confirmed',error:{code:'fixture-stopped',message:'No provider was dispatched'}}})
      fs.writeSync(1,JSON.stringify({pid:process.pid,executionId:context.executionId,reaped:cleanup.reaped}))
      process.exit(0)
    }})
    core.configureBudget('demo','trial',10)
    core.submit(request).catch(error=>{throw error})
    process.on('uncaughtException',error=>{try{child?.kill('SIGKILL')}catch{};fs.writeSync(2,String(error));process.exit(1)})
  `
    const report = JSON.parse(
      execFileSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000
      })
    )
    expect(report.reaped).toBe(true)
    expect(() => process.kill(report.pid, 0)).toThrow()
    const filename = join(root, 'execution.json')
    const before = JSON.parse(readFileSync(filename, 'utf8'))
    expect(before.records[report.executionId]).toMatchObject({
      phase: 'running',
      cleanup: 'pending'
    })
    expect(readFileSync(filename + '.lock', 'utf8')).toBe(String(report.pid))
    expect(
      await reconcilePersistentOptimization({
        workRoot: root,
        projectId: 'demo',
        sourceSessionId: 'source',
        authorize: async () => undefined
      })
    ).toMatchObject({
      status: 'settled',
      resumeAllowed: false,
      records: [{ phase: 'interrupted', cleanup: 'confirmed' }]
    })
    const after = JSON.parse(readFileSync(filename, 'utf8'))
    expect(after.budgets).toEqual(before.budgets)
    expect(Object.values(after.budgets)).toEqual([{ limit: 10, admitted: 1 }])
    expect(after.records[report.executionId].error.code).toBe('process_restarted')
  },
  45_000
)
