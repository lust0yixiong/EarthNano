import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

// HOME isolation also isolates Security.framework preferences. Point only the fresh test
// preferences at the explicitly supplied vault; never copy secrets or change the operator's
// search/default settings. Hosted CI owns the temporary vault, while local acceptance can use
// the application's existing OS identity through the unchanged packaged credential helper.
export const prepareIsolatedMacosKeychain = async (
  environment: Record<string, string>
): Promise<void> => {
  const keychain = process.env.OPEN_SCIENCE_E2E_MACOS_KEYCHAIN
  if (
    process.platform !== 'darwin' ||
    process.env.OPEN_SCIENCE_E2E_ISOLATE_HOME !== '1' ||
    !process.env.OPEN_SCIENCE_E2E_EXECUTABLE ||
    !keychain
  )
    return
  if (!isAbsolute(keychain) || !(await stat(keychain)).isFile())
    throw new Error('An existing absolute test Keychain path is required')
  const home = environment.HOME
  if (!home || !isAbsolute(home) || home === process.env.HOME)
    throw new Error('Keychain preferences require an isolated test HOME')
  const security = async (args: string[], env = process.env): Promise<string> =>
    (await execute('/usr/bin/security', args, { env, timeout: 10_000 })).stdout
  const outerState = async (): Promise<string> =>
    JSON.stringify([
      await security(['list-keychains', '-d', 'user']),
      await security(['default-keychain', '-d', 'user'])
    ])
  const before = await outerState()
  // Security.framework cannot persist these settings if Library/Preferences is absent.
  await mkdir(join(home, 'Library', 'Preferences'), { recursive: true })
  await security(['list-keychains', '-d', 'user', '-s', keychain], environment)
  await security(['default-keychain', '-d', 'user', '-s', keychain], environment)
  if ((await outerState()) !== before)
    throw new Error('The operator Keychain context changed during test preparation')
}
