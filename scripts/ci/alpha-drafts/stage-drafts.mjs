// Operational first-draft staging only. No release/tag API writes are implemented here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SOURCE = "4a31b9ae72654cf6ddf7749103abb48b5f85043f";
export const PREPARER = "a96a94b4fbc4cc7f6803f6e6e1248c665c62bc51";
export const TAGS = ["v0.1.0-alpha.1", "alpha"];
const VERSION = "0.1.0-alpha.1";
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, value) =>
  writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const numeric = (value) => {
  assert.match(value ?? "", /^[1-9][0-9]*$/);
  const n = Number(value);
  assert(Number.isSafeInteger(n));
  return n;
};
const digest = async (file) => {
  const stat = await lstat(file);
  assert(stat.isFile());
  assert(stat.size > 0);
  const hash = createHash("sha256");
  for await (const part of createReadStream(file)) hash.update(part);
  return { bytes: stat.size, sha256: hash.digest("hex") };
};
const pages = (value) => {
  assert(Array.isArray(value));
  return value.flat();
};
const git = (dir, ...args) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const invoke = (source, script, args, cwd = source) =>
  execFileSync(process.execPath, [join(source, script), ...args], {
    cwd,
    stdio: "inherit",
  });

export function validatePreparation(
  run,
  attempt,
  jobs,
  artifact,
  releases,
  workflowStates,
  tagStates,
  input,
) {
  for (const value of [run, attempt]) {
    assert.equal(value.id, input.run);
    assert.equal(value.run_attempt, input.attempt);
    assert.equal(value.head_sha, PREPARER);
    assert.equal(value.head_branch, "ci/earthnano-alpha-assets");
    assert.equal(value.path, ".github/workflows/earthnano-ci.yml");
    assert.equal(value.event, "workflow_dispatch");
    assert.equal(value.status, "completed");
    assert.equal(value.conclusion, "success");
    assert.equal(value.repository.full_name, "lust0yixiong/EarthNano");
  }
  const matches = jobs.filter((job) => job.name === "prepare-alpha-assets");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].status, "completed");
  assert.equal(matches[0].conclusion, "success");
  for (const name of [
    "Require real native, source and QA completion before downloading packages",
    "Verify actual source, bytes, original certifications and QA; stage without overwrites",
    "Original Unix certification aggregate",
    "Original mac feed merge for the explicit Alpha channel",
    "Original real-byte SHA256SUMS recipe",
    "Original complete Alpha manifest generator with explicit Unix scope",
    "Upload prepared Alpha assets as an Actions artifact only (no publication)",
  ]) {
    const step = matches[0].steps.filter((step) => step.name === name);
    assert.equal(step.length, 1, name);
    assert.equal(step[0].conclusion, "success", name);
  }
  assert.equal(artifact.id, input.artifact);
  assert.equal(artifact.expired, false);
  assert.equal(
    artifact.name,
    `earthnano-alpha-prepared-4a31-${input.run}-${input.attempt}`,
  );
  assert.equal(artifact.digest, input.digest);
  assert(artifact.size_in_bytes > 0);
  assert.equal(artifact.workflow_run.id, input.run);
  assert.equal(artifact.workflow_run.head_sha, PREPARER);
  assert.equal(artifact.workflow_run.head_branch, "ci/earthnano-alpha-assets");
  for (const tag of TAGS)
    assert.equal(
      releases.filter((release) => release.tag_name === tag).length,
      0,
      `First creation only: ${tag} already has a release`,
    );
  for (const [name, state] of Object.entries(workflowStates)) {
    assert.equal(state.path, `.github/workflows/${name}`);
    assert.match(state.state, /^disabled_/);
  }
  assert.deepEqual(Object.keys(workflowStates).sort(), [
    "nightly-publish.yml",
    "release.yml",
  ]);
  for (const tag of TAGS) {
    const refs = tagStates[tag].refs.filter(
      (ref) => ref.ref === `refs/tags/${tag}`,
    );
    assert(refs.length <= 1);
    if (refs.length)
      assert.equal(
        tagStates[tag].commit.sha,
        SOURCE,
        `Existing ${tag} must resolve to fixed4a`,
      );
    else assert.equal(tagStates[tag].commit, null);
  }
}

async function context() {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_OS, "Linux");
  const root = await realpath(process.env.ALPHA_DRAFT_ROOT);
  assert(root.startsWith((await realpath(process.env.RUNNER_TEMP)) + "/"));
  const source = await realpath(process.env.ALPHA_SOURCE_ROOT),
    preparer = await realpath(process.env.ALPHA_PREPARER_ROOT);
  assert.equal(git(source, "rev-parse", "HEAD"), SOURCE);
  assert.equal(git(source, "status", "--porcelain"), "");
  assert.equal(git(preparer, "rev-parse", "HEAD"), PREPARER);
  assert.equal(git(preparer, "status", "--porcelain"), "");
  const operation = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  assert.match(process.env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.equal(git(operation, "rev-parse", "HEAD"), process.env.GITHUB_SHA);
  assert.equal(git(operation, "status", "--porcelain"), "");
  const input = {
    run: numeric(process.env.PREPARED_RUN_ID),
    attempt: numeric(process.env.PREPARED_RUN_ATTEMPT),
    artifact: numeric(process.env.PREPARED_ARTIFACT_ID),
    digest: process.env.PREPARED_ARTIFACT_DIGEST,
  };
  assert.match(input.digest ?? "", /^sha256:[a-f0-9]{64}$/);
  return {
    root,
    source,
    preparer,
    input,
    evidence: join(root, "evidence"),
    publication: {
      operationalSha: process.env.GITHUB_SHA,
      run: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      workflowRef: process.env.GITHUB_WORKFLOW_REF,
    },
  };
}

async function preflight(c) {
  const { evidence, input } = c;
  const releases = pages(
    await json(join(evidence, "releases-before.pages.json")),
  );
  validatePreparation(
    await json(join(evidence, "prepared-run.json")),
    await json(join(evidence, "prepared-attempt.json")),
    (await json(join(evidence, "prepared-jobs.pages.json"))).flatMap(
      (page) => page.jobs,
    ),
    await json(join(evidence, "prepared-artifact.json")),
    releases,
    {
      "release.yml": await json(join(evidence, "release-workflow.json")),
      "nightly-publish.yml": await json(
        join(evidence, "nightly-workflow.json"),
      ),
    },
    Object.fromEntries(
      await Promise.all(
        TAGS.map(async (tag) => [
          tag,
          {
            refs: await json(join(evidence, `tag-${tag}-refs-before.json`)),
            commit: await json(join(evidence, `tag-${tag}-commit-before.json`)),
          },
        ]),
      ),
    ),
    input,
  );
  await save(join(evidence, "preflight.json"), {
    source: SOURCE,
    preparation: { ...input, operationalSha: PREPARER },
    firstCreationOnly: true,
    publication: c.publication,
  });
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `prepared_artifact_id=${input.artifact}\n`,
  );
}

async function verify(c) {
  const { root, source, preparer, input, evidence } = c;
  assert.deepEqual((await json(join(evidence, "preflight.json"))).preparation, {
    ...input,
    operationalSha: PREPARER,
  });
  const downloaded = await realpath(join(root, "prepared")),
    ready = await realpath(join(downloaded, "assets"));
  assert.equal(downloaded, join(root, "prepared"));
  assert.equal(ready, join(downloaded, "assets"));
  const carried = join(downloaded, "evidence"),
    origin = await json(join(carried, "operation-origins.json"));
  assert.equal(origin.applicationSource, SOURCE);
  assert.equal(origin.operationalSource, PREPARER);
  assert.equal(origin.operationalRun, String(input.run));
  assert.equal(origin.noPublicationPerformed, true);
  assert.equal(
    origin.workflowRef,
    "lust0yixiong/EarthNano/.github/workflows/earthnano-ci.yml@refs/heads/ci/earthnano-alpha-assets",
  );
  const originalPreparer = await import(
    pathToFileURL(join(preparer, "scripts/ci/alpha-assets/prepare-assets.mjs"))
  );
  originalPreparer.validateRuns(
    await json(join(carried, "native-run.json")),
    await json(join(carried, "source-run.json")),
    await json(join(carried, "qa-run.json")),
    origin.qaRun,
    origin.qaOperationalSource,
  );
  assert.equal(origin.nativeRun, originalPreparer.NATIVE_RUN);
  assert.equal(origin.sourceRun, originalPreparer.SOURCE_RUN);
  const staged = await json(join(carried, "staging-origins.json"));
  assert(Array.isArray(staged) && staged.length > 0);
  const expected = new Set(),
    targets = new Set(originalPreparer.TARGETS.map(([, target]) => target));
  for (const entry of staged) {
    assert(targets.has(entry.target));
    assert.equal(entry.sourcePath, `dist/${basename(entry.sourcePath)}`);
    const originalName = basename(entry.sourcePath),
      rules = originalPreparer.nativeFileNames(entry.target);
    assert(
      rules.allowed(originalName) ||
        [
          `certification-${entry.target}.json`,
          `database-migration-certification-${entry.target}.json`,
        ].includes(originalName),
    );
    const mapped =
      originalName === "alpha-mac.yml"
        ? `${entry.target.slice("macos-".length)}-mac.yml`
        : originalName;
    assert.equal(entry.stagedName, mapped);
    assert(/^[A-Za-z0-9._-]+$/.test(mapped));
    assert(!expected.has(mapped));
    expected.add(mapped);
    await originalPreparer.verifyFile(join(ready, mapped), entry);
  }
  for (const target of targets) {
    const names = staged
      .filter((entry) => entry.target === target)
      .map((entry) => basename(entry.sourcePath));
    for (const required of originalPreparer.nativeFileNames(target).required)
      assert(
        names.some((name) =>
          required instanceof RegExp ? required.test(name) : required === name,
        ),
      );
    for (const name of [
      `certification-${target}.json`,
      `database-migration-certification-${target}.json`,
    ])
      assert(names.includes(name));
  }
  for (const name of [
    "alpha-mac.yml",
    "SHA256SUMS.txt",
    "RELEASE-CERTIFICATION.json",
    "version.json",
  ]) {
    assert(!expected.has(name));
    expected.add(name);
  }
  assert.deepEqual((await readdir(ready)).sort(), [...expected].sort());
  const checks = join(root, "checks");
  await mkdir(checks);
  invoke(source, "scripts/ci/release-certification-evidence.mjs", [
    "aggregate",
    "--directory",
    ready,
    "--output",
    join(checks, "RELEASE-CERTIFICATION.json"),
    "--expected-sha",
    SOURCE,
    "--platforms",
    "mac,linux",
  ]);
  assert.deepEqual(
    await readFile(join(checks, "RELEASE-CERTIFICATION.json")),
    await readFile(join(ready, "RELEASE-CERTIFICATION.json")),
  );
  const originalManifest = await import(
    pathToFileURL(join(source, "scripts/generate-version-manifest.mjs"))
  );
  const sums = originalManifest.parseSha256Sums(
    await readFile(join(ready, "SHA256SUMS.txt"), "utf8"),
  );
  const packages = [...expected]
    .filter((name) => /\.(dmg|zip|AppImage|deb)$/.test(name))
    .sort();
  assert.equal(packages.length, 8);
  assert.deepEqual(Object.keys(sums).sort(), packages);
  execFileSync("sha256sum", ["--check", "--strict", "SHA256SUMS.txt"], {
    cwd: ready,
    stdio: "inherit",
  });
  const mac = join(checks, "mac");
  await mkdir(mac);
  for (const name of packages.filter((name) => /\.(dmg|zip)$/.test(name)))
    await link(join(ready, name), join(mac, name));
  for (const name of ["arm64-mac.yml", "x64-mac.yml"]) {
    await copyFile(join(ready, name), join(mac, name));
  }
  invoke(source, "scripts/merge-mac-feed.mjs", [mac, "--channel", "alpha"]);
  assert.deepEqual(
    await readFile(join(mac, "alpha-mac.yml")),
    await readFile(join(ready, "alpha-mac.yml")),
  );
  const manifest = await json(join(ready, "version.json"));
  const rebuilt = originalManifest.buildManifest({
    dir: ready,
    version: VERSION,
    notes: manifest.notes,
    localizedNotes: manifest.localizedNotes,
    releaseDate: manifest.releaseDate,
    channel: "alpha",
    assetBaseUrl: `https://github.com/lust0yixiong/EarthNano/releases/download/v${VERSION}`,
    platforms: "mac,linux",
    requireComplete: true,
  });
  assert.deepEqual(rebuilt, manifest);
  const assets = await Promise.all(
    [...expected]
      .sort()
      .map(async (name) => ({ name, ...(await digest(join(ready, name))) })),
  );
  await save(join(evidence, "draft-assets.json"), {
    source: SOURCE,
    preparation: { ...input, operationalSha: PREPARER },
    assets,
  });
  const bodyPath = join(evidence, "draft-body.md");
  await writeFile(
    bodyPath,
    `# EarthNano ${VERSION}\n\n${manifest.notes}\n\nUnsigned macOS/Linux preview; Windows is deferred to 0.2. Not Developer ID signed or notarized.\n\nApplication source: ${SOURCE}\nPrepared run/attempt: ${input.run}/${input.attempt}; artifact ${input.artifact}, ${input.digest}.\n`,
    { flag: "wx" },
  );
  const bodySha256 = (await digest(bodyPath)).sha256;
  await save(join(evidence, "draft-plan.json"), {
    tags: TAGS,
    source: SOURCE,
    draft: true,
    prerelease: true,
    makeLatest: false,
    bodySha256,
  });
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `reviewed_body_path=${bodyPath}\nexact_asset_paths<<ALPHA_DRAFT_PATHS\n${assets.map(({ name }) => join(ready, name)).join("\n")}\nALPHA_DRAFT_PATHS\n`,
  );
}

async function receipt(c) {
  const { evidence } = c;
  const errors = [],
    found = [];
  const plan = await json(join(evidence, "draft-plan.json")).catch(
    () => undefined,
  );
  const inventory = await json(join(evidence, "draft-assets.json")).catch(
    () => undefined,
  );
  const releases = pages(
    await json(join(evidence, "releases-after.pages.json")),
  );
  for (const tag of TAGS) {
    const matches = releases.filter((release) => release.tag_name === tag);
    if (matches.length !== 1) {
      errors.push(`${tag}: expected one newly created draft`);
      continue;
    }
    const entry = matches[0];
    const release = await json(join(evidence, `release-${entry.id}.json`));
    const assets = pages(
      await json(join(evidence, `release-${entry.id}-assets.pages.json`)),
    );
    const refs = (
      await json(join(evidence, `tag-${tag}-refs-after.json`))
    ).filter((ref) => ref.ref === `refs/tags/${tag}`);
    const commit = await json(join(evidence, `tag-${tag}-commit-after.json`));
    found.push({
      tag,
      id: release.id,
      url: release.html_url,
      draft: release.draft,
      prerelease: release.prerelease,
      assetCount: assets.length,
    });
    try {
      assert(plan && inventory);
      assert.equal(release.tag_name, tag);
      assert.equal(release.draft, true);
      assert.equal(release.prerelease, true);
      assert.equal(release.target_commitish, SOURCE);
      assert.equal(release.published_at, null);
      assert(refs.length <= 1);
      if (refs.length) assert.equal(commit.sha, SOURCE);
      else assert.equal(commit, null);
      assert.equal(
        createHash("sha256").update(release.body).digest("hex"),
        plan.bodySha256,
      );
      assert.equal(
        new Set(assets.map((asset) => asset.name)).size,
        assets.length,
      );
      assert.deepEqual(
        assets
          .map((asset) => ({
            name: asset.name,
            bytes: asset.size,
            sha256: String(asset.digest).replace(/^sha256:/, ""),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        [...inventory.assets].sort((a, b) => a.name.localeCompare(b.name)),
      );
      assert(
        assets.every(
          (asset) =>
            asset.state === "uploaded" &&
            /^sha256:[a-f0-9]{64}$/.test(asset.digest),
        ),
      );
    } catch {
      errors.push(
        `${tag}: draft metadata or complete asset digest/size set differs`,
      );
    }
  }
  await save(join(evidence, "draft-receipt.json"), {
    status: errors.length
      ? "incomplete-stop"
      : "drafts-byte-verified-not-published",
    source: SOURCE,
    preparation: { ...c.input, operationalSha: PREPARER },
    publication: c.publication,
    releases: found,
    errors,
    noAutomaticPublication: true,
    noAutomaticRecovery: true,
  });
  assert.deepEqual(
    errors,
    [],
    "Keep partial drafts; root must inspect before any further write",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const c = await context();
  if (process.argv[2] === "preflight") await preflight(c);
  else if (process.argv[2] === "verify") await verify(c);
  else if (process.argv[2] === "receipt") await receipt(c);
  else throw new Error("Expected preflight, verify or receipt");
}
