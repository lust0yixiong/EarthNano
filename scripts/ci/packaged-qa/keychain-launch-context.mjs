// Operational acceptance adapter. The fixed application and original fixture are not modified.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const installed = new WeakSet();
const SOURCE = "4a31b9ae72654cf6ddf7749103abb48b5f85043f";
const fail = (code) => {
  throw new Error(`Packaged Keychain context: ${code}`);
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const defaultPorts = () => ({
  platform: process.platform,
  realpath,
  lstat,
  mkdir,
  readFile,
  appendFile,
  loadPlaywright: (source) =>
    createRequire(join(source, "package.json"))("playwright"),
  loadProbe: (modulePath) =>
    createRequire(modulePath)(modulePath).executablePath,
  run: (file, args, env, maxBuffer = 65536) =>
    spawnSync(file, args, {
      env,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
    }),
});
const okay = (result) => !result.error && result.status === 0 && !result.signal;
const parseSearchList = (stdout) => {
  const lines = String(stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1 || !/^"[^"\r\n]+"$/.test(lines[0]))
    fail("expected exactly one wrapper Keychain");
  return lines[0].slice(1, -1);
};
const probeResult = (result) => {
  if (!okay(result)) fail("original metadata probe did not exit successfully");
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    fail("invalid original metadata probe JSON");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.keys(value).every((key) =>
      [
        "schemaVersion",
        "platform",
        "identity",
        "status",
        "reason",
        "osStatus",
        "account",
      ].includes(key),
    ) ||
    value.schemaVersion !== 1 ||
    value.platform !== "darwin" ||
    value.identity !== "Open-Science" ||
    value.status !== "exists" ||
    value.reason !== "account-metadata-found" ||
    value.osStatus !== 0 ||
    value.account !== "Open-Science Key"
  )
    fail("original seeded identity is not confirmed");
  return value;
};

// Injection is exclusively for offline tests. Default ports run only inside this hosted guard.
export function installKeychainLaunchContext({
  environment = process.env,
  ports = defaultPorts(),
} = {}) {
  if (
    ports.platform !== "darwin" ||
    environment.GITHUB_ACTIONS !== "true" ||
    environment.RUNNER_OS !== "macOS"
  )
    fail("disposable macOS GHA context required");
  for (const key of [
    "QA_ROOT",
    "QA_SOURCE_ROOT",
    "QA_APP_BUNDLE",
    "QA_KEYCHAIN_HOME",
    "RUNNER_TEMP",
  ])
    if (!environment[key] || resolve(environment[key]) !== environment[key])
      fail(`absolute ${key} required`);
  const electron = ports.loadPlaywright(environment.QA_SOURCE_ROOT)._electron;
  if (
    !electron ||
    typeof electron.launch !== "function" ||
    installed.has(electron)
  )
    fail("launch hook must install exactly once");
  const originalLaunch = electron.launch;
  let vaultIdentity;
  let context;
  let attempt = 0;
  const initialize = async () => {
    const root = await ports.realpath(environment.QA_ROOT);
    const runnerTemp = await ports.realpath(environment.RUNNER_TEMP);
    if (root !== environment.QA_ROOT || !root.startsWith(runnerTemp + sep))
      fail("QA root is not canonical runner-owned storage");
    const app = await ports.realpath(environment.QA_APP_BUNDLE);
    if (app !== join(root, "extracted/EarthNano.app"))
      fail("unexpected fixed package path");
    const keychainHome = await ports.realpath(environment.QA_KEYCHAIN_HOME);
    if (
      keychainHome !== environment.QA_KEYCHAIN_HOME ||
      keychainHome === root ||
      keychainHome.startsWith(root + sep)
    )
      fail("outer Keychain HOME must remain separate");
    if (
      (await ports.realpath(join(root, "evidence"))) !== join(root, "evidence")
    )
      fail("evidence directory must be owned");
    const modulePath = join(
      app,
      "Contents/Resources/backend/node_modules/@aipoch/credential-identity-probe-native/index.cjs",
    );
    const probe = ports.loadProbe(modulePath);
    if (
      probe !==
      join(dirname(modulePath), "build/Release/credential_identity_probe")
    )
      fail("unexpected packaged native helper");
    if (!(await ports.lstat(probe)).isFile())
      fail("packaged metadata probe must be a file");
    return {
      root,
      runnerTemp,
      app,
      keychainHome,
      probe,
      probeSha256: sha(await ports.readFile(probe)),
    };
  };
  const record = async (data) => {
    if (!context) return;
    await ports.appendFile(
      join(context.root, "evidence/keychain-context-binding.jsonl"),
      JSON.stringify({
        operatorOnly: true,
        source: SOURCE,
        attempt,
        ...data,
      }) + "\n",
    );
  };
  electron.launch = async function (options) {
    attempt += 1;
    try {
      context ??= await initialize();
      const { root, runnerTemp, app, keychainHome, probe, probeSha256 } =
        context;
      if (
        !options ||
        options.executablePath !== join(app, "Contents/MacOS/EarthNano") ||
        !options.env ||
        options.env.OPEN_SCIENCE_E2E_ISOLATE_HOME !== "1" ||
        options.env.OPEN_SCIENCE_E2E_EXECUTABLE !== options.executablePath
      )
        fail("original isolated packaged launch required");
      const env = options.env; // This exact object is delegated unchanged.
      const home = env.HOME;
      if (
        typeof home !== "string" ||
        resolve(home) !== home ||
        !/^open-science-electron-e2e-[A-Za-z0-9]+\/isolated home$/.test(
          relative(join(root, "tmp"), home).split(sep).join("/"),
        )
      )
        fail("HOME is not the original owned fixture path");
      const fixtureRoot = dirname(home);
      if (
        (await ports.realpath(fixtureRoot)) !== fixtureRoot ||
        !(await ports.lstat(fixtureRoot)).isDirectory()
      )
        fail("fixture root must be canonical and already allocated");
      if (
        env.OPEN_SCIENCE_CONFIG_ROOT !== join(fixtureRoot, "storage") ||
        env.OPEN_SCIENCE_USER_DATA !== join(fixtureRoot, "electron-profile") ||
        env.OPEN_SCIENCE_INSTALLATION_STATE_ROOT !==
          join(fixtureRoot, "storage/installation-state")
      )
        fail("original fixture roots differ");
      if (home === keychainHome) fail("fixture HOME must not be outer HOME");
      const outerEnv = { ...environment, HOME: keychainHome };
      const outer = ports.run(
        "/usr/bin/security",
        ["list-keychains", "-d", "user"],
        outerEnv,
      );
      if (!okay(outer)) fail("cannot read original wrapper search list");
      const vault = parseSearchList(outer.stdout);
      const canonicalVault = await ports.realpath(vault);
      const vaultRoot = dirname(canonicalVault);
      if (
        vault !== canonicalVault ||
        dirname(vaultRoot) !== runnerTemp ||
        !/^open-science-p0-keychain\.[A-Za-z0-9]+$/.test(basename(vaultRoot)) ||
        basename(vault) !== "test.keychain-db" ||
        !(await ports.lstat(vaultRoot)).isDirectory() ||
        !(await ports.lstat(vault)).isFile()
      )
        fail("Keychain is not the original wrapper temporary vault");
      if (vaultIdentity && vaultIdentity !== vault)
        fail("wrapper vault changed across launches");
      vaultIdentity = vault;
      let homeExisted = true;
      try {
        await ports.mkdir(home);
        homeExisted = false;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      if (
        (await ports.realpath(home)) !== home ||
        !(await ports.lstat(home)).isDirectory()
      )
        fail("fixture HOME is not a canonical directory");
      const mapped = ports.run(
        "/usr/bin/security",
        ["list-keychains", "-d", "user", "-s", vault],
        env,
      );
      if (!okay(mapped))
        fail("cannot bind original temporary vault to fixture HOME");
      const visible = ports.run(
        "/usr/bin/security",
        ["list-keychains", "-d", "user"],
        env,
      );
      if (!okay(visible) || parseSearchList(visible.stdout) !== vault)
        fail("fixture search list differs after binding");
      const metadata = probeResult(
        ports.run(probe, ["Open-Science"], env, 4096),
      );
      await record({
        stage: "metadata-confirmed-before-launch",
        home,
        homeExisted,
        vault,
        probe,
        probeSha256,
        metadata,
      });
    } catch (error) {
      // Never launch through a different environment, key or credential backend on setup failure.
      await record({
        stage: "setup-failed",
        code: error.message?.startsWith("Packaged Keychain context: ")
          ? error.message
          : "setup I/O failure",
      });
      throw error;
    }
    // Keep Playwright receiver, options identity, argument list and original launch failures.
    return Reflect.apply(originalLaunch, this, [options]);
  };
  installed.add(electron);
  return { installed: true };
}

// Called only by the existing science finalizer, in addition to every original business check.
export function assertKeychainContextEvidence(
  rows,
  { root, runnerTemp, app, probeSha256 },
) {
  assert(
    Array.isArray(rows) && rows.length >= 2,
    "Expected metadata evidence for initial launch and explicit reopen",
  );
  let vault;
  for (const [index, row] of rows.entries()) {
    assert.equal(row.operatorOnly, true);
    assert.equal(row.source, SOURCE);
    assert.equal(row.attempt, index + 1);
    assert.equal(row.stage, "metadata-confirmed-before-launch");
    assert.equal(typeof row.home, "string");
    assert.match(
      relative(join(root, "tmp"), row.home).split(sep).join("/"),
      /^open-science-electron-e2e-[A-Za-z0-9]+\/isolated home$/,
    );
    assert.equal(typeof row.homeExisted, "boolean");
    assert.equal(
      row.probe,
      join(
        app,
        "Contents/Resources/backend/node_modules/@aipoch/credential-identity-probe-native/build/Release/credential_identity_probe",
      ),
    );
    assert.match(row.probeSha256, /^[a-f0-9]{64}$/);
    assert.equal(row.probeSha256, probeSha256);
    assert.equal(dirname(dirname(row.vault)), runnerTemp);
    assert.match(
      basename(dirname(row.vault)),
      /^open-science-p0-keychain\.[A-Za-z0-9]+$/,
    );
    assert.equal(basename(row.vault), "test.keychain-db");
    vault ??= row.vault;
    assert.equal(
      row.vault,
      vault,
      "Same test/reopen must retain the original temporary vault",
    );
    probeResult({
      status: 0,
      signal: null,
      stdout: JSON.stringify(row.metadata),
    });
  }
}
