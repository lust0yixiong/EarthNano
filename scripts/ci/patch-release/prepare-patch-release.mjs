import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const repo = "lust0yixiong/EarthNano";
const version = "0.1.1-alpha.1";
const targets = [
  ["macos-26", "macos-arm64", "darwin", "arm64"],
  ["macos-26-intel", "macos-x64", "darwin", "x64"],
  ["ubuntu-24.04", "linux-x64", "linux", "x64"],
  ["ubuntu-24.04-arm", "linux-arm64", "linux", "arm64"],
];
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const api = (path) =>
  JSON.parse(
    execFileSync("gh", ["api", `repos/${repo}/${path}`], { encoding: "utf8" }),
  );
const save = async (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n");
const digest = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
const stableRelease = (release) => ({
  ...Object.fromEntries(
    [
      "id",
      "tag_name",
      "target_commitish",
      "name",
      "body",
      "draft",
      "prerelease",
      "published_at",
    ].map((key) => [key, release[key] ?? null]),
  ),
  assets: release.assets
    .map((asset) =>
      Object.fromEntries(
        ["id", "name", "size", "digest", "content_type", "created_at"].map(
          (key) => [key, asset[key] ?? null],
        ),
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name)),
});

async function preserve(operation, evidence) {
  const expected = await json(join(operation, "preserved-old-state.json"));
  for (const tag of ["v0.1.0-alpha.1", "alpha"]) {
    const observed = {
      release: stableRelease(api(`releases/tags/${tag}`)),
      ref: api(`git/ref/tags/${tag}`).object,
    };
    // Use the same ordering for both snapshots; download counters are intentionally excluded.
    const wanted = expected[tag];
    wanted.release.assets.sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(
      observed,
      wanted,
      `The existing ${tag} release/tag/assets changed`,
    );
  }
  await save(join(evidence, "old-releases-preserved.json"), {
    verified: true,
    tags: Object.keys(expected),
  });
}

async function gates(source, root, sha, runId) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.match(runId, /^[1-9][0-9]*$/);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8",
    }).trim(),
    sha,
  );
  assert.equal((await json(join(source, "package.json"))).version, version);
  const run = api(`actions/runs/${runId}`);
  assert.equal(run.head_sha, sha);
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  const jobs = api(`actions/runs/${runId}/jobs?per_page=100`).jobs;
  for (const name of [
    "Enforce pinned original source comparison",
    "Pinned Harness source and original unittest comparison (Python 3.12)",
    "Bundled upstream cases in the actual Mac ARM64 package",
  ])
    assert(
      jobs.some((job) => job.name === name && job.conclusion === "success"),
      name,
    );
  for (const [os] of targets)
    assert(
      jobs.some(
        (job) =>
          job.name
            .split(" / ")
            .includes(`Unsigned native build and original launch ${os}`) &&
          job.conclusion === "success",
      ),
      os,
    );
  const pr = api("pulls/27");
  assert.equal(pr.merged, true);
  assert.equal(pr.head.sha, sha);
  assert.equal(pr.base.ref, "main");
  await save(join(root, "evidence/source-run.json"), run);
  await save(join(root, "evidence/source-jobs.json"), jobs);
  await save(join(root, "evidence/merged-pr.json"), {
    number: pr.number,
    head: pr.head.sha,
    mergedAt: pr.merged_at,
    mergeCommit: pr.merge_commit_sha,
  });
}

async function collect(source, root, sha, runId) {
  const reports = [];
  async function readTrialReports(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await readTrialReports(path);
      else if (entry.name === "upstream-trial.json")
        reports.push(await json(path));
    }
  }
  await readTrialReports(join(root, "evidence/packaged-trials"));
  assert.deepEqual(reports.map((report) => report.trial).sort(), [
    "harness2-ledger",
    "openscience-case16",
  ]);
  for (const report of reports) {
    assert.equal(report.status, "passed");
    assert.equal(report.live, false);
    assert.equal(report.provider.rejected, 0);
    assert(
      report.notebookRuns.some((run) => run.status === "completed"),
      report.trial,
    );
  }
  const scientific = reports.find(
    (report) => report.trial === "openscience-case16",
  );
  assert.deepEqual(
    scientific.artifacts.map(({ name, sha256 }) => ({ name, sha256 })),
    [
      {
        name: "trial_calculations.csv",
        sha256:
          "ce5be45173e72f859c525876424d87eacd4a9c88d79afce550fbf3232e719da6",
      },
      {
        name: "availability_summary.csv",
        sha256:
          "64e40cf520346dd84f3e07310314b3b7a8e5ce44929aa9963967b23e42c8721e",
      },
    ],
  );
  const optimization = reports.find(
    (report) => report.trial === "harness2-ledger",
  ).optimization;
  assert.equal(optimization.state, "completed");
  const tasks = optimization.sweep.domains.flatMap(
    (domain) => domain.summary.tasks,
  );
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].assessments.baseline.outcome, "pass");
  assert.equal(tasks[0].assessments.candidate.outcome, "pass");
  assert.equal(tasks[0].outcome.artifact.status, "passed");
  await save(join(root, "evidence/verified-trial-outcomes.json"), {
    verified: true,
    source: sha,
    runId,
    trials: reports.map(({ trial }) => trial),
    independentAssessmentOutcomes: "baseline and candidate pass",
  });
  const assets = join(root, "assets");
  await mkdir(assets);
  const upstreams = await json(join(source, "UPSTREAMS.json"));
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: source,
    encoding: "utf8",
  }).trim();
  const origins = [];
  for (const [os, target, platform, arch] of targets) {
    const evidence = join(
      root,
      "inputs/native",
      `earthnano-native-evidence-${os}`,
    );
    const packages = join(root, "inputs/packages", `earthnano-unsigned-${os}`);
    const manifest = await json(
      join(evidence, "test-results/native-evidence/artifact-manifest.json"),
    );
    assert.equal(manifest.source, sha);
    assert.equal(manifest.sourceTree, tree);
    assert.equal(manifest.sourceDirty, false);
    assert.equal(manifest.version, version);
    assert.equal(manifest.productName, "EarthNano");
    assert.equal(manifest.platform, platform);
    assert.equal(manifest.arch, arch);
    assert.equal(manifest.distribution, "unsigned-ci");
    assert.equal(manifest.packageArtifactCount, 2);
    assert.deepEqual(manifest.upstreams, upstreams);
    const native = await json(
      join(evidence, "dist", `certification-${target}.json`),
    );
    assert.equal(native.source.sha, sha);
    assert.equal(native.source.runId, runId);
    async function stage(path, name, destination = name) {
      const records = manifest.files.filter(
        (file) => file.path === `dist/${name}`,
      );
      assert.equal(records.length, 1, name);
      const observed = {
        bytes: (await stat(path)).size,
        sha256: await digest(path),
      };
      assert.equal(observed.bytes, records[0].bytes, name);
      assert.equal(observed.sha256, records[0].sha256, name);
      await link(path, join(assets, destination));
      origins.push({ target, name: destination, ...observed });
    }
    for (const name of await readdir(packages)) {
      assert(
        /\.(dmg|zip|AppImage|deb|blockmap)$/.test(name) ||
          /^alpha-(mac|linux|linux-arm64)\.yml$/.test(name),
        name,
      );
      await stage(
        join(packages, name),
        name,
        name === "alpha-mac.yml" ? `${arch}-mac.yml` : name,
      );
    }
    for (const name of [
      `certification-${target}.json`,
      `database-migration-certification-${target}.json`,
    ])
      await stage(join(evidence, "dist", name), name);
  }
  const installers = origins.filter((entry) =>
    /\.(dmg|zip|AppImage|deb)$/.test(entry.name),
  );
  assert.equal(installers.length, 8);
  await save(join(root, "evidence/staging-origins.json"), origins);
  await writeFile(
    join(assets, "SHA256SUMS.txt"),
    installers
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => `${entry.sha256}  ${entry.name}\n`)
      .join(""),
  );
}

const source = resolve(process.env.PATCH_SOURCE_ROOT);
const root = resolve(process.env.PATCH_ROOT);
const operation = resolve(process.env.PATCH_OPERATION_ROOT);
const sha = process.env.PATCH_SOURCE_SHA;
const runId = process.env.PATCH_SOURCE_RUN;
const mode = process.argv[2];
if (mode === "gates") {
  await mkdir(join(root, "evidence"), { recursive: true });
  await preserve(operation, join(root, "evidence"));
  await gates(source, root, sha, runId);
} else if (mode === "collect") {
  await collect(source, root, sha, runId);
} else if (mode === "preserve") {
  await preserve(operation, join(root, "evidence"));
} else throw new Error("Expected gates, collect or preserve");
