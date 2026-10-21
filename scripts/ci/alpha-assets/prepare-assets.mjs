import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE = "4a31b9ae72654cf6ddf7749103abb48b5f85043f";
export const NATIVE_RUN = 39629283517;
export const SOURCE_RUN = 39629363410;
export const VERSION = "0.1.0-alpha.1";
export const TARGETS = [
  ["macos-26", "macos-arm64", "darwin", "arm64"],
  ["macos-26-intel", "macos-x64", "darwin", "x64"],
  ["ubuntu-24.04", "linux-x64", "linux", "x64"],
  ["ubuntu-24.04-arm", "linux-arm64", "linux", "arm64"],
];
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = async (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n");
const git = (root, ...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export async function digest(path) {
  assert((await lstat(path)).isFile(), `Not a regular input: ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function requireStep(job, name) {
  const matches = job.steps.filter((step) => step.name === name);
  assert.equal(matches.length, 1, `Missing original step: ${name}`);
  assert.equal(matches[0].conclusion, "success", name);
}
function requireRun(record, id) {
  assert.equal(record.databaseId, id);
  assert.equal(record.headSha, SOURCE);
  assert.equal(record.workflowName, "EarthNano CI");
  assert.equal(record.status, "completed");
  assert.equal(record.conclusion, "success");
}

export function validateRuns(native, source, qa, qaId, qaSha) {
  requireRun(native, NATIVE_RUN);
  requireRun(source, SOURCE_RUN);
  for (const [os, , platform] of TARGETS) {
    const jobs = native.jobs.filter((job) =>
      job.name
        .split(" / ")
        .includes(`Unsigned native build and original launch ${os}`),
    );
    assert.equal(jobs.length, 1, os);
    const job = jobs[0];
    assert.equal(job.status, "completed");
    assert.equal(job.conclusion, "success");
    for (const name of [
      "Install original dependencies",
      "Require exact lockfile Electron binary",
      "Stage original pinned resources",
      "Original full application build",
      "Original target Prisma engine pruning",
      "Native unsigned packaging (never publish)",
      "Original Unix package certification evidence",
      "Retain validated unsigned packages (CI artifacts, no release publication)",
      "Source identity, license and streamed artifact digests",
    ])
      requireStep(job, name);
    requireStep(
      job,
      platform === "darwin"
        ? "Require original Icon Composer compiler"
        : "Original Linux build and smoke dependencies",
    );
    requireStep(
      job,
      platform === "darwin"
        ? "Original macOS DMG/ZIP resource, catalog/fallback and launch smoke"
        : "Original Linux DEB lifecycle, AppImage resources and installed launch smoke",
    );
  }
  for (const name of [
    "Enforce pinned original source comparison",
    "Pinned Harness source and original unittest comparison (Python 3.12)",
  ]) {
    const jobs = source.jobs.filter((job) => job.name === name);
    assert.equal(jobs.length, 1, name);
    assert.equal(jobs[0].status, "completed");
    assert.equal(jobs[0].conclusion, "success");
  }
  assert(
    Number.isSafeInteger(qaId) &&
      qaId > 0 &&
      qaId !== NATIVE_RUN &&
      qaId !== SOURCE_RUN,
    "Supply the real completed QA run ID",
  );
  assert.match(qaSha, /^[a-f0-9]{40}$/);
  assert.equal(qa.databaseId, qaId);
  assert.equal(
    qa.headSha,
    qaSha,
    "Approved operational SHA, separate from app source",
  );
  assert.equal(qa.headBranch, "ci/earthnano-packaged-qa");
  assert.equal(qa.workflowName, "EarthNano CI");
  assert.equal(qa.status, "completed");
  assert.equal(qa.conclusion, "success");
  assert(Number.isSafeInteger(qa.attempt) && qa.attempt > 0);
}

export async function verifyFile(path, original) {
  assert(Number.isSafeInteger(original.bytes) && original.bytes > 0);
  assert.match(original.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await lstat(path)).size, original.bytes);
  assert.equal(await digest(path), original.sha256);
}

export function nativeFileNames(target) {
  if (target.startsWith("macos-")) {
    const arch = target.slice("macos-".length);
    return {
      required: [
        `EarthNano-${VERSION}-mac-${arch}.dmg`,
        `EarthNano-${VERSION}-mac-${arch}.zip`,
        "alpha-mac.yml",
      ],
      allowed: (name) =>
        name === "alpha-mac.yml" ||
        new RegExp(
          `^EarthNano-0\\.1\\.0-alpha\\.1-mac-${arch}\\.(?:dmg|zip)(?:\\.blockmap)?$`,
        ).test(name),
    };
  }
  const arm = target === "linux-arm64",
    arch = arm ? "arm64" : "(?:x64|x86_64)",
    deb = arm ? "arm64" : "amd64",
    feed = arm ? "alpha-linux-arm64.yml" : "alpha-linux.yml";
  const image = new RegExp(
    `^EarthNano-0\\.1\\.0-alpha\\.1-linux-${arch}\\.AppImage$`,
  );
  const blockmap = new RegExp(
    `^EarthNano-0\\.1\\.0-alpha\\.1-linux-${arch}\\.AppImage\\.blockmap$`,
  );
  return {
    required: [image, `EarthNano_${VERSION}_${deb}.deb`, feed],
    allowed: (name) =>
      [
        feed,
        `EarthNano_${VERSION}_${deb}.deb`,
        `EarthNano_${VERSION}_${deb}.deb.blockmap`,
      ].includes(name) ||
      image.test(name) ||
      blockmap.test(name),
  };
}

export function validateQaArchitecture(
  manifest,
  nativeManifests,
  origins,
  acceptance,
) {
  assert.equal(manifest.platform, "darwin");
  assert(["arm64", "x64"].includes(manifest.arch));
  const matching = nativeManifests.filter(
    (record) => record.platform === "darwin" && record.arch === manifest.arch,
  );
  assert.equal(matching.length, 1);
  assert.deepEqual(
    manifest,
    matching[0],
    "QA must carry the same original target manifest from the fixed native run",
  );
  for (const record of [origins, acceptance]) {
    if (record.arch !== undefined) assert.equal(record.arch, manifest.arch);
    if (record.macArch !== undefined)
      assert.equal(record.macArch, manifest.arch);
    if (record.macTarget !== undefined)
      assert.equal(
        record.macTarget,
        manifest.arch === "x64" ? "macos-26-intel" : "macos-26",
      );
    if (record.platform !== undefined)
      assert.equal(record.platform, manifest.platform);
  }
  return {
    platform: manifest.platform,
    arch: manifest.arch,
    source: manifest.source,
  };
}

async function validateQa(root, source, expectedOperationalSha) {
  const qa = join(root, "inputs/qa/evidence");
  const origins = await json(join(qa, "origins.json"));
  assert.equal(origins.applicationSource, SOURCE);
  assert.equal(origins.nativeRun, NATIVE_RUN);
  assert.equal(origins.sourceRun, SOURCE_RUN);
  assert.equal(origins.operationalSource, expectedOperationalSha);
  assert.equal(
    origins.originalKeychainWrapperSha256,
    await digest(join(source, "scripts/ci/run-macos-packaged-e2e.sh")),
  );
  const proof = await json(join(qa, "spec-byteproof.json"));
  assert.equal(
    proof.originalSha256,
    await digest(join(source, "e2e/earthnano-notebook-optimization.spec.ts")),
  );
  assert.equal(proof.restoredSha256, proof.originalSha256);
  assert.equal(proof.businessBytesUnchanged, true);
  const acceptance = await json(join(qa, "acceptance.json"));
  assert.equal(acceptance.status, "passed");
  assert.equal(acceptance.source, SOURCE);
  for (const name of [
    "samePackageReopened",
    "explicitStopResume",
    "bundleUnchanged",
  ])
    assert.equal(acceptance[name], true);
  assert.equal(acceptance.upstreamRequests, 0);
  assert.deepEqual(await json(join(qa, "process-exit.json")), {
    originalWrapperAndTestExit: 0,
    teeExit: 0,
  });
  assert.equal(
    (await json(join(qa, "final-verification-exit.json")))
      .finalVerificationExit,
    0,
  );
  const manifestPath = join(
    root,
    "inputs/qa/native-evidence/test-results/native-evidence/artifact-manifest.json",
  );
  const manifest = await json(manifestPath);
  const manifests = await Promise.all(
    TARGETS.map(([os]) =>
      json(
        join(
          root,
          "inputs/native",
          `earthnano-native-evidence-${os}`,
          "test-results/native-evidence/artifact-manifest.json",
        ),
      ),
    ),
  );
  const architecture = validateQaArchitecture(
    manifest,
    manifests,
    origins,
    acceptance,
  );
  const matching = TARGETS.find(
    ([, , platform, arch]) =>
      platform === architecture.platform && arch === architecture.arch,
  );
  const originalPath = join(
    root,
    "inputs/native",
    `earthnano-native-evidence-${matching[0]}`,
    "test-results/native-evidence/artifact-manifest.json",
  );
  assert.deepEqual(
    await readFile(manifestPath),
    await readFile(originalPath),
    "Preserve original QA-carried native manifest bytes",
  );
  await save(join(root, "evidence/qa-architecture.json"), {
    ...architecture,
    originalManifestSha256: await digest(originalPath),
    nativeArtifact: `earthnano-native-evidence-${matching[0]}`,
    scope: "Actual QA target only; not a second architecture GUI claim",
  });
}

async function collect(root, source) {
  const stage = join(root, "assets");
  await mkdir(stage); // Never merge an unknown/previous staging directory.
  const expectedPackages = TARGETS.map(
    ([os]) => `earthnano-unsigned-${os}`,
  ).sort();
  const expectedEvidence = TARGETS.map(
    ([os]) => `earthnano-native-evidence-${os}`,
  ).sort();
  assert.deepEqual(
    (await readdir(join(root, "inputs/packages"))).sort(),
    expectedPackages,
  );
  assert.deepEqual(
    (await readdir(join(root, "inputs/native"))).sort(),
    expectedEvidence,
  );
  const provenance = [];
  const upstreams = await json(join(source, "UPSTREAMS.json")),
    lock = await json(join(source, "package-lock.json"));
  for (const [os, target, platform, arch] of TARGETS) {
    const evidence = join(
        root,
        "inputs/native",
        `earthnano-native-evidence-${os}`,
      ),
      packages = join(root, "inputs/packages", `earthnano-unsigned-${os}`);
    const manifest = await json(
      join(evidence, "test-results/native-evidence/artifact-manifest.json"),
    );
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.source, SOURCE);
    assert.equal(manifest.sourceTree, git(source, "rev-parse", "HEAD^{tree}"));
    assert.equal(manifest.sourceDirty, false);
    assert.equal(manifest.version, VERSION);
    assert.equal(manifest.productName, "EarthNano");
    assert.equal(manifest.platform, platform);
    assert.equal(manifest.arch, arch);
    assert.equal(manifest.distribution, "unsigned-ci");
    assert.equal(manifest.packageArtifactCount, 2);
    assert.deepEqual(manifest.upstreams, upstreams);
    assert.equal(manifest.electron.status, 0);
    for (const key of ["expected", "installed", "binary"])
      assert.equal(
        manifest.electron[key],
        lock.packages["node_modules/electron"].version,
      );
    const names = await readdir(packages),
      rules = nativeFileNames(target);
    for (const name of rules.required) {
      if (name instanceof RegExp)
        assert.equal(
          names.filter((value) => name.test(value)).length,
          1,
          `Require one original ${target} AppImage`,
        );
      else assert(names.includes(name), `Missing ${target}/${name}`);
    }
    async function stageFile(input, originalName, outputName = originalName) {
      const records = manifest.files.filter(
        (file) => file.path === `dist/${originalName}`,
      );
      assert.equal(
        records.length,
        1,
        `Original manifest must identify ${originalName}`,
      );
      await verifyFile(input, records[0]);
      await link(input, join(stage, outputName)); // Same owned runner FS, no duplicate 2.5GB copy or original-byte mutation.
      provenance.push({
        target,
        sourcePath: `dist/${originalName}`,
        stagedName: outputName,
        bytes: records[0].bytes,
        sha256: records[0].sha256,
      });
    }
    for (const name of names) {
      assert(
        rules.allowed(name),
        `Unselected/unexpected native asset: ${target}/${name}`,
      );
      const outputName = name === "alpha-mac.yml" ? `${arch}-mac.yml` : name;
      await stageFile(join(packages, name), name, outputName);
    }
    for (const name of [
      `certification-${target}.json`,
      `database-migration-certification-${target}.json`,
    ])
      await stageFile(join(evidence, "dist", name), name);
  }
  await save(join(root, "evidence/staging-origins.json"), provenance);
}

async function main() {
  const source = resolve(process.env.ALPHA_SOURCE_ROOT),
    root = resolve(process.env.ALPHA_ROOT);
  assert(root.startsWith(resolve(process.env.RUNNER_TEMP) + "/"));
  assert.equal(git(source, "rev-parse", "HEAD"), SOURCE);
  assert.equal(git(source, "status", "--porcelain"), "");
  const native = await json(join(root, "evidence/native-run.json")),
    sourceRun = await json(join(root, "evidence/source-run.json")),
    qa = await json(join(root, "evidence/qa-run.json"));
  validateRuns(
    native,
    sourceRun,
    qa,
    Number(process.env.ALPHA_QA_RUN_ID),
    process.env.ALPHA_QA_OPERATIONAL_SHA,
  );
  if (process.argv[2] === "verify-runs") {
    assert(process.env.GITHUB_OUTPUT);
    await writeFile(
      process.env.GITHUB_OUTPUT,
      `qa_artifact=earthnano-packaged-science-${qa.databaseId}-${qa.attempt}\n`,
      { flag: "a" },
    );
    const operation = dirname(fileURLToPath(import.meta.url)),
      operationSource = resolve(operation, "../../..");
    assert.equal(
      git(operationSource, "rev-parse", "HEAD"),
      process.env.ALPHA_OPERATION_SHA,
    );
    await save(join(root, "evidence/operation-origins.json"), {
      applicationSource: SOURCE,
      operationalSource: process.env.ALPHA_OPERATION_SHA,
      workflowRef: process.env.GITHUB_WORKFLOW_REF,
      operationalRun: process.env.GITHUB_RUN_ID,
      nativeRun: NATIVE_RUN,
      sourceRun: SOURCE_RUN,
      qaRun: qa.databaseId,
      qaOperationalSource: qa.headSha,
      noPublicationPerformed: true,
    });
  } else if (process.argv[2] === "collect") {
    await validateQa(root, source, qa.headSha);
    await collect(root, source);
  } else throw new Error("Expected verify-runs or collect");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
