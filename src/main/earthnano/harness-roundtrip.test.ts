import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import fixtures from '../../../contracts/execution/fixtures.json'
import { ExecutionCore, emptyExecutionState } from './execution-core'
import type { ExecutionRequest } from '../../shared/earthnano/execution-port'

it('routes a Python improver and a TypeScript ordinary request through one core and budget', async () => {
  let state = emptyExecutionState()
  const roles: string[] = []
  const core = new ExecutionCore(
    {
      load: () => state,
      commit: (next) => {
        state = structuredClone(next)
      }
    },
    {
      async execute(request, context) {
        context.running()
        roles.push(request.role)
        return {
          phase: 'completed',
          cleanup: 'confirmed',
          evidence: {
            status: 'complete',
            scope: 'test-public-output',
            text: `executed:${request.role}`,
            artifacts: [],
            references: [],
            limitations: []
          }
        }
      }
    }
  )
  core.configureBudget('demo', 'trial', 2)
  await core.submit({ ...fixtures.valid, requestKey: 'typescript-task' } as ExecutionRequest)
  const child = spawn('python3', ['-B', 'contracts/execution/stdio-roundtrip.py'], {
    env: { ...process.env, PYTHONPATH: resolve('vendor/harness2') },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const lines = createInterface({ input: child.stdout })
  let stderr = ''
  child.stderr.on('data', (data) => {
    stderr += String(data)
  })
  let result: { text: string; stopped: boolean } | undefined
  let handlerError: unknown
  let pending = Promise.resolve()
  lines.on('line', (line) => {
    pending = pending
      .then(async () => {
        const message = JSON.parse(line)
        try {
          let value: unknown
          switch (message.operation) {
            case 'submit':
              value = await core.submit(message.request)
              break
            case 'get':
              value = await core.get(message.executionId)
              break
            case 'cancel':
              value = await core.cancel(message.executionId)
              break
            case 'events': {
              const events = []
              for await (const event of core.events(message.executionId, message.afterSequence))
                events.push(event)
              value = events
              break
            }
            case 'done':
              result = message
              value = true
              break
            default:
              throw new Error('Unexpected test operation')
          }
          child.stdin.write(JSON.stringify({ result: value }) + '\n')
        } catch (error) {
          child.stdin.write(
            JSON.stringify({
              error: {
                code: (error as { code?: string }).code ?? 'test-error',
                message: String(error)
              }
            }) + '\n'
          )
        }
      })
      .catch((error) => {
        handlerError = error
        child.kill()
      })
  })
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error(`Python roundtrip timed out: ${stderr}`))
      }, 10000)
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        resolve(code)
      })
    })
    await pending
    expect(handlerError).toBeUndefined()
    expect(code, stderr).toBe(0)
    expect(result).toMatchObject({ text: 'executed:proposer', stopped: true })
    expect(roles).toEqual(['task', 'proposer'])
    expect(Object.values(state.records)).toHaveLength(2)
    expect(Object.values(state.records).every((r) => r.phase === 'completed')).toBe(true)
  } finally {
    lines.close()
    child.kill()
    core.dispose()
  }
})
