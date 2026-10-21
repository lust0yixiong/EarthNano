import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  bundleInventory,
  exportRuntimeIconAssets,
  hashFile,
  packagedEntrypointSha256,
} from "./packaged-diagnostics.mjs";

export const SOURCE_SHA = "4a31b9ae72654cf6ddf7749103abb48b5f85043f";
export const NATIVE_RUN = 39629283517;
export const SOURCE_RUN = 39629363410;
const VERSION = "0.1.0-alpha.1";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = async (file, data) =>
  writeFile(file, JSON.stringify(data, null, 2) + "\n");
const git = (source, ...args) =>
  execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();

export function validateRun(record, expectedId, native = false) {
  assert.equal(record.databaseId, expectedId);
  assert.equal(record.headSha, SOURCE_SHA);
  assert.equal(record.workflowName, "EarthNano CI");
  assert(
    [
      "queued",
      "requested",
      "waiting",
      "pending",
      "in_progress",
      "completed",
    ].includes(record.status),
  );
  if (native) {
    const jobs = record.jobs.filter((job) =>
      job.name
        .split(" / ")
        .includes("Unsigned native build and original launch macos-26"),
    );
    assert.equal(jobs.length, 1, "Require exactly the ARM64 native job");
    assert.equal(jobs[0].status, "completed");
    assert.equal(jobs[0].conclusion, "success");
    for (const name of [
      "Original full application build",
      "Native unsigned packaging (never publish)",
      "Original macOS DMG/ZIP resource, catalog/fallback and launch smoke",
      "Retain validated unsigned packages (CI artifacts, no release publication)",
      "Source identity, license and streamed artifact digests",
    ]) {
      const steps = jobs[0].steps.filter((step) => step.name === name);
      assert.equal(steps.length, 1, `Missing original native step: ${name}`);
      assert.equal(steps[0].conclusion, "success", name);
    }
  }
}

export function releaseGates(native, source) {
  const classify = (status, conclusion) =>
    status === "completed"
      ? conclusion === "success"
        ? "passed"
        : "failed"
      : "pending";
  const gates = {
    source: {
      status: source.status,
      conclusion: source.conclusion,
      result: classify(source.status, source.conclusion),
    },
  };
  for (const target of [
    "macos-26",
    "macos-26-intel",
    "ubuntu-24.04",
    "ubuntu-24.04-arm",
  ]) {
    const jobs = native.jobs.filter((job) =>
      job.name
        .split(" / ")
        .includes(`Unsigned native build and original launch ${target}`),
    );
    const job = jobs.length === 1 ? jobs[0] : undefined;
    gates[target] = {
      status: job?.status ?? "unavailable",
      conclusion: job?.conclusion ?? null,
      result: job
        ? classify(job.status, job.conclusion)
        : native.status === "completed"
          ? "failed"
          : "pending",
    };
  }
  return {
    gates,
    releaseGatesPending: Object.entries(gates)
      .filter(([, gate]) => gate.result === "pending")
      .map(([name]) => name),
    releaseGatesFailed: Object.entries(gates)
      .filter(([, gate]) => gate.result === "failed")
      .map(([name]) => name),
    purpose:
      "Mac ARM64 scientific acceptance only; never publication authorization",
  };
}

export function validateManifest(
  manifest,
  expectedTree,
  upstreams,
  electronVersion,
) {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.source, SOURCE_SHA);
  assert.equal(manifest.sourceTree, expectedTree);
  assert.equal(manifest.sourceDirty, false);
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.productName, "EarthNano");
  assert.equal(manifest.platform, "darwin");
  assert.equal(manifest.arch, "arm64");
  assert.equal(manifest.distribution, "unsigned-ci");
  assert.equal(manifest.packageArtifactCount, 2);
  assert.deepEqual(manifest.upstreams, upstreams);
  assert.equal(manifest.electron.status, 0);
  assert.equal(manifest.electron.expected, electronVersion);
  assert.equal(manifest.electron.installed, electronVersion);
  assert.equal(manifest.electron.binary, electronVersion);
  assert(Array.isArray(manifest.files));
}

export async function verifyPackageDirectory(directory, manifest) {
  const required = [
    `EarthNano-${VERSION}-mac-arm64.dmg`,
    `EarthNano-${VERSION}-mac-arm64.zip`,
  ];
  const names = await readdir(directory);
  for (const name of required) assert(names.includes(name), `Missing ${name}`);
  for (const name of names) {
    assert(
      required.includes(name) ||
        name === "alpha-mac.yml" ||
        /^EarthNano-0\.1\.0-alpha\.1-mac-arm64\.(?:dmg|zip)\.blockmap$/.test(
          name,
        ),
      `Unexpected package file: ${name}`,
    );
    const entries = manifest.files.filter(
      (file) => file.path === `dist/${name}`,
    );
    assert.equal(
      entries.length,
      1,
      `Missing/duplicate original digest: ${name}`,
    );
    assert.equal((await lstat(join(directory, name))).size, entries[0].bytes);
    assert.equal(
      await hashFile(join(directory, name)),
      entries[0].sha256,
      name,
    );
  }
}

const originalProjection = `bundleEntrypointSha256: Object.fromEntries(
        await Promise.all(
          [
            'out/backend/index.cjs',
            'out/main/index.js',
            'out/preload/index.js',
            'out/renderer/index.html'
          ].map(async (path) => [
            path,
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex')
          ])
        )
      )`;

export function adaptSpec(original, specPath, adapterPath) {
  assert.equal(
    original.split(originalProjection).length,
    2,
    "Diagnostic preamble drifted; do not guess",
  );
  const mappings = [];
  function remap(match, quote, name) {
    const replacement = match.replace(
      quote + name + quote,
      JSON.stringify(resolve(dirname(specPath), name)),
    );
    mappings.push({ original: match, replacement });
    return replacement;
  }
  let adapted = original
    .replace(/from (['"])(\.[^'"]+)\1/g, remap)
    .replace(/import\((['"])(\.[^'"]+)\1\)/g, remap);
  adapted = adapted.replace(
    originalProjection,
    "bundleEntrypointSha256: await packagedEntrypointSha256()",
  );
  const addedImport = `import { packagedEntrypointSha256 } from ${JSON.stringify(adapterPath)}\n`;
  adapted = addedImport + adapted;
  let restored = adapted
    .slice(addedImport.length)
    .replace(
      "bundleEntrypointSha256: await packagedEntrypointSha256()",
      originalProjection,
    );
  for (const mapping of mappings.toReversed())
    restored = restored.replace(mapping.replacement, mapping.original);
  assert.equal(
    restored,
    original,
    "Original business bytes must survive the reversible projection",
  );
  return {
    adapted,
    proof: {
      originalSha256: sha(original),
      restoredSha256: sha(restored),
      businessBytesUnchanged: true,
      importRelocations: mappings.length,
      diagnosticProjectionReplacements: 1,
    },
  };
}

async function verifyRuns(source, root) {
  assert.equal(git(source, "rev-parse", "HEAD"), SOURCE_SHA);
  assert.equal(
    git(source, "status", "--porcelain"),
    "",
    "Source checkout must be clean",
  );
  const native = await json(join(root, "evidence/native-run.json")),
    sourceRun = await json(join(root, "evidence/source-run.json"));
  validateRun(native, NATIVE_RUN, true);
  validateRun(sourceRun, SOURCE_RUN);
  const operation = dirname(fileURLToPath(import.meta.url)),
    operationCheckout = resolve(operation, "../../..");
  assert.match(process.env.QA_OPERATION_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.equal(
    git(operationCheckout, "rev-parse", "HEAD"),
    process.env.QA_OPERATION_SHA,
  );
  await save(
    join(root, "evidence/release-gates.json"),
    releaseGates(native, sourceRun),
  );
  await save(join(root, "evidence/origins.json"), {
    applicationSource: SOURCE_SHA,
    applicationTree: git(source, "rev-parse", "HEAD^{tree}"),
    nativeRun: NATIVE_RUN,
    sourceRun: SOURCE_RUN,
    operationalSource: process.env.QA_OPERATION_SHA,
    operationalWorkflowRef: process.env.QA_WORKFLOW_REF,
    operationalRun: process.env.GITHUB_RUN_ID,
    operationalAttempt: process.env.GITHUB_RUN_ATTEMPT,
    originalKeychainWrapperSha256: await hashFile(
      join(source, "scripts/ci/run-macos-packaged-e2e.sh"),
    ),
    operationalFiles: Object.fromEntries(
      await Promise.all(
        ["prepare.mjs", "packaged-diagnostics.mjs", "run.sh"].map(
          async (name) => [name, await hashFile(join(operation, name))],
        ),
      ),
    ),
  });
}

async function prepare(source, root, operation) {
  await verifyRuns(source, root);
  const manifest = await json(
    join(
      root,
      "native-evidence/test-results/native-evidence/artifact-manifest.json",
    ),
  );
  validateManifest(
    manifest,
    git(source, "rev-parse", "HEAD^{tree}"),
    await json(join(source, "UPSTREAMS.json")),
    (await json(join(source, "package-lock.json"))).packages[
      "node_modules/electron"
    ].version,
  );
  await verifyPackageDirectory(join(root, "packages"), manifest);
  const extracted = join(root, "extracted");
  await mkdir(extracted); // Fresh owned destination only; an old tree is an error.
  execFileSync(
    "/usr/bin/ditto",
    [
      "-x",
      "-k",
      join(root, `packages/EarthNano-${VERSION}-mac-arm64.zip`),
      extracted,
    ],
    { stdio: "inherit" },
  );
  const app = join(extracted, "EarthNano.app");
  assert.equal(await realpath(app), app);
  assert.deepEqual(
    (await readdir(extracted)).filter((name) => name.endsWith(".app")),
    ["EarthNano.app"],
  );
  const { loadPackageSmokeIdentity, readMacBundleExecutable } = await import(
    pathToFileURL(join(source, "scripts/package-smoke-identity.mjs"))
  );
  const identity = await loadPackageSmokeIdentity(source);
  assert.equal(identity.version, VERSION);
  assert.equal(await readMacBundleExecutable(app, identity), "EarthNano");
  for (const relative of [
    "Contents/MacOS/EarthNano",
    "Contents/Info.plist",
    "Contents/Resources/app.asar",
    "Contents/Resources/backend/index.cjs",
  ]) {
    const entries = manifest.files.filter((file) =>
      file.path.endsWith(`/EarthNano.app/${relative}`),
    );
    assert.equal(
      entries.length,
      1,
      `Missing original extracted digest: ${relative}`,
    );
    assert.equal(await hashFile(join(app, relative)), entries[0].sha256);
    assert.equal((await lstat(join(app, relative))).size, entries[0].bytes);
  }
  process.env.QA_APP_BUNDLE = app;
  await packagedEntrypointSha256();
  const icons = join(root, "evidence/icons");
  await mkdir(icons);
  const runtimeIcons = await exportRuntimeIconAssets(source, app, icons);
  const compiled = join(app, "Contents/Resources/icon.icns");
  await copyFile(compiled, join(icons, "icon.icns"));
  execFileSync(
    "/usr/bin/iconutil",
    ["-c", "iconset", compiled, "-o", join(icons, "compiled-icon.iconset")],
    { stdio: "inherit" },
  );
  await writeFile(
    join(icons, "actool-version.txt"),
    execFileSync("/usr/bin/xcrun", ["actool", "--version"]),
  );
  await save(join(icons, "icons.json"), {
    runtimeIcons,
    compiled: {
      "Contents/Resources/Assets.car": await hashFile(
        join(app, "Contents/Resources/Assets.car"),
      ),
      "Contents/Resources/icon.icns": await hashFile(compiled),
      "Contents/Info.plist": await hashFile(join(app, "Contents/Info.plist")),
    },
    purpose:
      "Actual packaged fallback/runtime pixels for visual review, no tint or notarization claim",
  });
  await save(
    join(root, "evidence/bundle-before.json"),
    await bundleInventory(app),
  );
  const specPath = join(source, "e2e/earthnano-notebook-optimization.spec.ts");
  const original = await readFile(specPath, "utf8");
  const adapterPath = join(operation, "packaged-diagnostics.mjs");
  const { adapted, proof } = adaptSpec(original, specPath, adapterPath);
  const generated = join(root, "generated");
  await mkdir(generated);
  await symlink(join(source, "node_modules"), join(generated, "node_modules"));
  await copyFile(
    specPath,
    join(root, "evidence/original-notebook-optimization.spec.ts"),
  );
  const projected = join(generated, "packaged-notebook-optimization.spec.ts");
  await writeFile(projected, adapted);
  await save(join(root, "evidence/spec-byteproof.json"), {
    ...proof,
    adaptedSha256: sha(adapted),
    adapterSha256: await hashFile(adapterPath),
    originalSource: SOURCE_SHA,
  });
  const diff = spawnSync(
    "git",
    ["diff", "--no-index", "--", specPath, projected],
    { encoding: "utf8" },
  );
  assert.equal(
    diff.status,
    1,
    "Expected exactly the recorded external diagnostic/import diff",
  );
  await writeFile(join(root, "evidence/spec-projection.diff"), diff.stdout);
  const config = `import base from ${JSON.stringify(join(source, "playwright.config.ts"))}\nexport default { ...base, testDir: ${JSON.stringify(generated)}, testMatch: 'packaged-notebook-optimization.spec.ts', outputDir: ${JSON.stringify(join(root, "results"))}, workers: 1, retries: 0, reporter: [['line'], ['json', { outputFile: ${JSON.stringify(join(root, "evidence/playwright.json"))} }]], use: { ...base.use, windowMode: 'normal', trace: 'on' } }\n`;
  await writeFile(join(root, "packaged.playwright.config.ts"), config);
  await writeFile(
    join(root, "evidence/launch.json"),
    JSON.stringify(
      {
        app,
        executable: join(app, "Contents/MacOS/EarthNano"),
        version: VERSION,
        profile:
          "real packaged; offline model; original same-task Notebook + explicit resume",
      },
      null,
      2,
    ) + "\n",
  );
}

async function finalize(source, root) {
  const { app } = await json(join(root, "evidence/launch.json"));
  const after = await bundleInventory(app);
  await save(join(root, "evidence/bundle-after.json"), after);
  assert.deepEqual(
    after,
    await json(join(root, "evidence/bundle-before.json")),
    "Packaged files changed during acceptance",
  );
  await verifyPackageDirectory(
    join(root, "packages"),
    await json(
      join(
        root,
        "native-evidence/test-results/native-evidence/artifact-manifest.json",
      ),
    ),
  );
  assert.equal(
    git(source, "status", "--porcelain"),
    "",
    "Do not change product source",
  );
  const reports = [];
  async function find(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await find(path);
      else if (entry.name === "notebook-optimization.json")
        reports.push(await json(path));
    }
  }
  await find(join(root, "results"));
  assert.equal(
    reports.length,
    1,
    "No skips or alternate result may stand in for the original test",
  );
  assert.equal(reports[0].acceptancePassed, true);
  assert.equal(reports[0].status, "passed");
  assert.equal(reports[0].live, false);
  assert.equal(reports[0].provider.upstreamRequests, 0);
  assert.deepEqual(reports[0].provider.upstreamStatuses, {});
  assert.equal(reports[0].provider.rejected, 0);
  assert.equal(reports[0].resume.noCallsOnReopen, true);
  assert.equal(reports[0].reopened, true);
  const playwright = await json(join(root, "evidence/playwright.json"));
  assert.equal(playwright.stats.expected, 1);
  for (const key of ["unexpected", "flaky", "skipped"])
    assert.equal(playwright.stats[key], 0);
  assert.deepEqual(playwright.errors ?? [], []);
  await save(join(root, "evidence/acceptance.json"), {
    status: "passed",
    originalBusinessAssertions: "unchanged",
    source: SOURCE_SHA,
    upstreamRequests: 0,
    samePackageReopened: true,
    explicitStopResume: true,
    bundleUnchanged: true,
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const source = resolve(process.env.QA_SOURCE_ROOT),
    root = resolve(process.env.QA_ROOT),
    operation = dirname(fileURLToPath(import.meta.url));
  assert(
    isAbsolute(root) && root.startsWith(resolve(process.env.RUNNER_TEMP) + "/"),
    "Only an owned real runner temporary directory",
  );
  if (process.argv[2] === "verify-runs") await verifyRuns(source, root);
  else if (process.argv[2] === "prepare")
    await prepare(source, root, operation);
  else if (process.argv[2] === "finalize") await finalize(source, root);
  else throw new Error("Expected verify-runs, prepare, or finalize");
}
