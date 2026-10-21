import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, matchesGlob, relative, resolve } from 'node:path'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

const sourceRoot = resolve(process.env.QA_FIXTURE_SOURCE_ROOT ?? '.')

it('loads the original method bytes from the actual packaged Node owner resource layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'earthnano-packaged-harness-'))
  try {
    const builder = load(
      await readFile(
        process.env.QA_PACKAGED_BUILDER ?? join(sourceRoot, 'electron-builder.yml'),
        'utf8'
      )
    ) as {
      extraResources: Array<{ from: string; to: string; filter?: string[] }>
    }
    const entries = builder.extraResources.filter((entry) => entry.from === 'vendor/harness2')
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    const source = join(sourceRoot, entry.from)
    const outerResources = join(root, 'EarthNano.app/Contents/Resources')
    const target = join(outerResources, entry.to)
    const copied: string[] = []
    for (const path of await readdir(source, {
      recursive: true,
      withFileTypes: true
    })) {
      if (!path.isFile()) continue
      const original = join(path.parentPath, path.name)
      const file = relative(source, original).split('\\').join('/')
      if (!entry.filter?.some((pattern) => matchesGlob(file, pattern))) continue
      await mkdir(dirname(join(target, file)), { recursive: true })
      await cp(original, join(target, file))
      copied.push(file)
    }
    expect(copied).toContain('harness2/earthnano_sweep.py')
    expect(copied).toContain('harness2/core/schedule.py')
    expect(copied).toContain('harness2/core/execution_schema.json')

    const { desktopBackendPaths } = await import(
      join(sourceRoot, 'src/main/desktop-runtime-launcher.ts')
    )
    const { entry: backendEntry } = desktopBackendPaths({
      packaged: true,
      resourcesPath: outerResources,
      applicationPath: root
    })
    // Original Node-entry/resource conventions, guarded against silent source drift.
    const nodeEntry = await readFile(join(sourceRoot, 'src/main/node-entry.ts'), 'utf8')
    expect(nodeEntry).toContain("const applicationPath = resolve(dirname(mainEntryPath), '../..')")
    expect(nodeEntry).toContain("resourcesPath: join(applicationPath, 'resources')")
    const composition = await readFile(
      join(sourceRoot, 'src/main/composition/desktop-optimization.ts'),
      'utf8'
    )
    expect(composition).toContain("join(runtimeMetadata().resourcesPath, 'earthnano', 'harness2')")
    const backendRoot = resolve(dirname(backendEntry), '../..')
    const harnessRoot = join(backendRoot, 'resources/earthnano/harness2')
    const { optimizationMethodDigest } = await import(
      join(sourceRoot, 'src/main/earthnano/optimization-resume.ts')
    )
    const originalDigest = optimizationMethodDigest(source)
    // A complete former outer-only copy still fails this owner's source read.
    const oldOuter = join(root, 'old-layout/Contents/Resources/earthnano/harness2')
    await cp(target, oldOuter, { recursive: true })
    expect(optimizationMethodDigest(oldOuter)).toBe(originalDigest)
    expect(() =>
      optimizationMethodDigest(
        join(root, 'old-layout/Contents/Resources/backend/resources/earthnano/harness2')
      )
    ).toThrow()
    expect(optimizationMethodDigest(harnessRoot)).toBe(originalDigest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
