import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ComputeConnectionLease } from '@aipoch/compute/node'
import type { ComputeConnectionBroker } from '../../src/main/compute/connection-broker'

/** Protocol simulation only: never executes SSH/Linux scripts, creates a process, or supplies
 * cancellation/cleanup evidence. All Job state belongs to the original production repositories. */
export async function createComputeProtocolTransport(
  root: string,
  outputs: Readonly<Record<string, Buffer>>
): Promise<{
  broker: ComputeConnectionBroker
  calls: { kind: string; jobId?: string; path?: string }[]
  commands: string[]
}> {
  await mkdir(root, { recursive: true })
  const calls: { kind: string; jobId?: string; path?: string }[] = []
  const commands: string[] = []
  const owned = (path: string): string => {
    const resolved = resolve(path)
    const child = relative(root, resolved)
    if (!child || child.startsWith('..') || isAbsolute(child))
      throw new Error('Fixture transport path is outside its owned directory')
    return resolved
  }
  const unquote = (value: string): string => {
    if (!/^'[^']+'$/.test(value)) throw new Error('Unexpected fixture path quoting')
    return owned(value.slice(1, -1))
  }
  const ok = (stdout = ''): Awaited<ReturnType<ComputeConnectionLease['run']>> => ({
    stdout,
    stderr: '',
    exitCode: 0,
    timedOut: false,
    truncated: false
  })
  const snapshot = async (path: string): Promise<string> => {
    const info = await stat(owned(path), { bigint: true })
    return `${info.size} ${info.ino} ${info.mtimeNs / 1_000_000_000n}.${String(info.mtimeNs % 1_000_000_000n).padStart(9, '0')}`
  }
  const lease: ComputeConnectionLease = {
    run: async (command, options) => {
      options.signal?.throwIfAborted()
      if (command.includes('nohup setsid bash launcher.sh')) {
        const match = /^mkdir -p ('.*?') \|\|/m.exec(command)
        if (!match) throw new Error('Original launcher did not declare its directory')
        const workdir = unquote(match[1])
        const jobId = workdir.split('/').at(-1)!
        calls.push({ kind: 'dispatch', jobId })
        await mkdir(workdir, { recursive: true })
        const encoded = [
          ...command.matchAll(
            /printf '%s' "([A-Za-z0-9+/=]+)" \| base64 -d > (command\.sh|launcher\.sh)/g
          )
        ]
        if (encoded.length !== 2) throw new Error('Original script payload missing')
        for (const item of encoded) {
          const bytes = Buffer.from(item[1], 'base64')
          await writeFile(join(workdir, item[2]), bytes)
          if (item[2] === 'command.sh') commands.push(bytes.toString('utf8'))
        }
        for (const [path, bytes] of Object.entries(outputs))
          await writeFile(owned(join(workdir, path)), bytes, { flag: 'wx' })
        await writeFile(join(workdir, 'stdout'), '{"transport":"protocol-fixture"}\n')
        await writeFile(join(workdir, 'stderr'), '')
        await writeFile(join(workdir, 'exit_code'), '0\n')
        // Numeric field required by the wire protocol, not a real PID or ownership witness.
        return ok('900001\n')
      }
      const sections = [...command.matchAll(/echo "([a-f0-9]+_)JOB_START:([a-f0-9-]+)"/g)]
      if (sections.length) {
        return ok(
          (
            await Promise.all(
              sections.map(async ([, nonce, jobId]) => {
                const workdir = owned(join(root, '.open-science', 'jobs', jobId))
                calls.push({ kind: 'poll', jobId })
                return [
                  `${nonce}JOB_START:${jobId}`,
                  `${nonce}alive:0`,
                  `${nonce}exit:0`,
                  await readFile(join(workdir, 'stdout'), 'utf8'),
                  `${nonce}STDOUT_END:${jobId}`,
                  '',
                  `${nonce}STDERR_END:${jobId}`
                ].join('\n')
              })
            )
          ).join('\n')
        )
      }
      const enumeration = /^find ('[^']+') -type f -printf /.exec(command)
      if (enumeration) {
        const workdir = unquote(enumeration[1])
        calls.push({ kind: 'enumerate', path: workdir })
        return ok(
          (
            await Promise.all(
              (await readdir(workdir)).map(
                async (name) =>
                  `${name}\t${(await snapshot(join(workdir, name))).replaceAll(' ', '\t')}`
              )
            )
          ).join('\n')
        )
      }
      const fileStat = /^if \[ -f ('[^']+') \]; then/.exec(command)
      if (fileStat && command.includes("printf 'f %s")) {
        const path = unquote(fileStat[1])
        calls.push({ kind: 'stat', path })
        return ok(`f ${await snapshot(path)}\n`)
      }
      // No permissive default: in particular no kill/cleanup/reaper confirmation is invented.
      throw new Error('Unsupported transport operation; remote cleanup is unconfirmed')
    },
    upload: async (local, remote) => {
      calls.push({ kind: 'upload', path: remote })
      const target = owned(remote)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await readFile(local), { flag: 'wx' })
    },
    download: async (remote, local, maxBytes) => {
      const bytes = await readFile(owned(remote))
      const exceeded = bytes.length > maxBytes
      calls.push({ kind: 'download', path: remote })
      await mkdir(dirname(local), { recursive: true })
      await writeFile(local, bytes.subarray(0, maxBytes), { flag: 'wx' })
      return {
        exitCode: 0,
        stderr: '',
        timedOut: false,
        exceeded,
        bytesWritten: Math.min(bytes.length, maxBytes)
      }
    }
  }
  return {
    calls,
    commands,
    broker: {
      acquire: async (providerId, request) => {
        request.signal?.throwIfAborted()
        if (providerId !== 'ssh:fixture') throw new Error('Unexpected fixture provider')
        calls.push({ kind: `acquire:${request.intent}` })
        if (!['job_dispatch', 'job_poll', 'job_harvest'].includes(request.intent))
          throw new Error('Fixture does not attest remote cleanup or authentication')
        return lease
      },
      beginHostDeletion: async () => {
        throw new Error('No host deletion in workflow fixture')
      },
      abortHostDeletion: () => {
        throw new Error('No host deletion in workflow fixture')
      },
      completeHostDeletion: () => {
        throw new Error('No host deletion in workflow fixture')
      }
    }
  }
}
