import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runHarnessProcess } from './harness-optimization'
import {
  HarnessProcessFailure,
  recordOptimizationFailure
} from './optimization-failure-diagnostics'

const roots: string[] = []
const root = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'earthnano-private-failure-'))
  roots.push(path)
  return path
}
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))
const secret = 'PRIVATE_PROVIDER_TOKEN_and_mission_and_python_traceback'

const assertInheritedWindowsAcl = (path: string): void => {
  const literal = path.replaceAll("'", "''")
  const script = `
$ErrorActionPreference = 'Stop'
$path = '${literal}'
$sidType = [System.Security.Principal.SecurityIdentifier]
$child = Get-Acl -LiteralPath $path
$parent = Get-Acl -LiteralPath ([IO.Path]::GetDirectoryName($path))
$owner = $child.GetOwner($sidType).Value
$group = $child.GetGroup($sidType).Value
$allows = @($child.GetAccessRules($true, $true, $sidType) | Where-Object { $_.AccessControlType -eq 'Allow' })
$inheritable = @($parent.GetAccessRules($true, $true, $sidType) | Where-Object {
  $_.AccessControlType -eq 'Allow' -and
  ($_.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0
})
$unmatched = @($allows | Where-Object {
  $rule = $_
  $matches = @($inheritable | Where-Object {
    $sid = $_.IdentityReference.Value
    if ($sid -eq 'S-1-3-0') { $sid = $owner }
    if ($sid -eq 'S-1-3-1') { $sid = $group }
    $sid -eq $rule.IdentityReference.Value -and
    (([int]$rule.FileSystemRights -band [int]$_.FileSystemRights) -eq [int]$rule.FileSystemRights)
  })
  $matches.Count -eq 0
})
@{
  protected = [bool]$child.AreAccessRulesProtected
  allowCount = $allows.Count
  explicitAllowCount = @($allows | Where-Object { !$_.IsInherited }).Count
  inheritedAllowCount = @($allows | Where-Object { $_.IsInherited }).Count
  unmatchedAllowCount = $unmatched.Count
} | ConvertTo-Json -Compress
`
  const stdout = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true }
  )
  const acl = JSON.parse(stdout.trim())
  expect(acl).toMatchObject({
    protected: false,
    explicitAllowCount: 0,
    unmatchedAllowCount: 0
  })
  expect(Number.isSafeInteger(acl.allowCount)).toBe(true)
  expect(acl.allowCount).toBeGreaterThan(0)
  expect(acl.inheritedAllowCount).toBe(acl.allowCount)
}
const processOptions = (): Parameters<typeof runHarnessProcess>[0] => ({
  binding: { dispatch: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
  python: 'python3',
  args: [],
  cwd: process.cwd(),
  env: { PATH: process.env.PATH },
  timeoutMs: 3000
})

it.each([
  {
    script: `import sys; sys.stderr.write('${secret}'); sys.exit(7)`,
    expected: { category: 'harness-exit', exitCode: 7 }
  },
  { script: 'print("bad-json",flush=True)', expected: { category: 'harness-protocol' } },
  {
    script:
      'import json,sys; print(json.dumps({"id":1,"operation":"done","result":{"status":"failed"}}),flush=True); sys.stdin.readline(); sys.exit(1)',
    expected: { category: 'harness-exit', exitCode: 1, protocolStatus: 'failed' }
  },
  {
    script: `import json,sys; print(json.dumps({"id":1,"operation":"done","result":{"status":"${secret}"}}),flush=True); sys.stdin.readline(); sys.exit(1)`,
    expected: { category: 'harness-exit', exitCode: 1 }
  },
  { script: 'pass', expected: { category: 'harness-result-missing', exitCode: 0 } }
])('retains only fixed process facts: $expected.category', async ({ script, expected }) => {
  const options = processOptions()
  const error = await runHarnessProcess({ ...options, args: ['-c', script] }).catch(
    (value: unknown) => value
  )
  expect(error).toBeInstanceOf(HarnessProcessFailure)
  expect((error as HarnessProcessFailure).details).toMatchObject(expected)
  expect(JSON.stringify(error)).not.toContain(secret)
  expect(String(error)).not.toContain(secret)
  expect(options.binding.dispatch).not.toHaveBeenCalled()
})

it.each(['budget-exhausted', secret])(
  'bounds original binding error codes without retaining exception data',
  async (code) => {
    const options = processOptions()
    options.binding.dispatch = vi.fn(async () => {
      throw Object.assign(new Error(secret), { code })
    })
    const error = await runHarnessProcess({
      ...options,
      args: [
        '-c',
        'import json,sys; print(json.dumps({"id":1,"operation":"get"}),flush=True); sys.stdin.readline()'
      ]
    }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(HarnessProcessFailure)
    expect((error as HarnessProcessFailure).details).toEqual({
      category: 'harness-binding',
      ...(code === 'budget-exhausted' ? { bindingCode: code } : {})
    })
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(options.binding.dispatch).toHaveBeenCalledOnce()
    expect(options.binding.stop).toHaveBeenCalled()
  }
)

it('distinguishes process spawn, timeout and explicit cancellation without storing their reasons', async () => {
  const missing = await runHarnessProcess({
    ...processOptions(),
    python: '/nonexistent-earthnano-private-diagnostics'
  }).catch((value: unknown) => value)
  expect((missing as HarnessProcessFailure).details).toEqual({ category: 'harness-spawn' })
  const timed = await runHarnessProcess({
    ...processOptions(),
    args: ['-c', 'import time; time.sleep(10)'],
    timeoutMs: 40
  }).catch((value: unknown) => value)
  expect((timed as HarnessProcessFailure).details).toEqual({ category: 'harness-timeout' })
  const controller = new AbortController()
  const pending = runHarnessProcess({
    ...processOptions(),
    args: ['-c', 'import time; time.sleep(10)'],
    signal: controller.signal
  })
  controller.abort(new Error(secret))
  const cancelled = await pending.catch((value: unknown) => value)
  expect((cancelled as HarnessProcessFailure).details).toEqual({ category: 'harness-cancelled' })
  expect(JSON.stringify(cancelled)).not.toContain(secret)
})

it('appends bounded private facts across resume and ignores arbitrary exception fields', () => {
  const directory = root(),
    path = join(directory, 'failure-diagnostics.jsonl')
  recordOptimizationFailure(
    directory,
    'semantic-assessment',
    Object.assign(new Error(secret), { category: secret, exitCode: 7, stack: secret })
  )
  recordOptimizationFailure(
    directory,
    'method-process',
    new HarnessProcessFailure({
      category: 'harness-exit',
      exitCode: 1,
      protocolStatus: 'failed',
      bindingCode: secret
    })
  )
  expect(
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  ).toEqual([
    { schemaVersion: 1, stage: 'semantic-assessment', category: 'stage-failed' },
    {
      schemaVersion: 1,
      stage: 'method-process',
      category: 'harness-exit',
      exitCode: 1,
      protocolStatus: 'failed'
    }
  ])
  if (process.platform === 'win32') {
    // Follow the original private-snapshot platform contract: Windows mode bits do not prove 0600.
    // This read-only check proves no added grants beyond the existing parent, not parent privacy.
    assertInheritedWindowsAcl(path)
  } else expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(readFileSync(path, 'utf8')).not.toContain(secret)
  for (let index = 0; index < 1000; index++)
    recordOptimizationFailure(directory, 'cleanup', undefined, 'cleanup-unconfirmed')
  expect(statSync(path).size).toBeLessThanOrEqual(64 * 1024)
})

it('does not replace the original failure when its private file is unavailable or linked', () => {
  const directory = root(),
    outside = join(root(), 'outside')
  writeFileSync(outside, 'retained')
  symlinkSync(outside, join(directory, 'failure-diagnostics.jsonl'))
  expect(() =>
    recordOptimizationFailure(directory, 'method-process', new Error(secret))
  ).not.toThrow()
  expect(readFileSync(outside, 'utf8')).toBe('retained')
  expect(() =>
    recordOptimizationFailure(join(directory, 'absent'), 'cleanup', new Error(secret))
  ).not.toThrow()
})
