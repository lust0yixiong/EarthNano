import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { dirname as pathDirname, resolve as pathResolve } from "node:path";
import { fileURLToPath as toPath, pathToFileURL } from "node:url";
const SOURCE_ROOT =
  process.env.QA_FIXTURE_SOURCE_ROOT ??
  pathResolve(pathDirname(toPath(import.meta.url)), "../../..");
const PREPARE_PATH =
  process.env.QA_FIXTURE_PREPARE_PATH ??
  pathResolve(pathDirname(toPath(import.meta.url)), "prepare.mjs");
import { installKeychainLaunchContext } from "./keychain-launch-context.mjs";
const ROOT = "/Users/runner/work/_temp/qa";
const TEMP = "/Users/runner/work/_temp";
const OUTER = "/Users/runner"; // Deliberately an ancestor of QA_ROOT, as on actual GHA.
const FIXTURE = `${ROOT}/tmp/open-science-electron-e2e-Ab1234`;
const HOME = `${FIXTURE}/isolated home`;
const APP = `${ROOT}/extracted/EarthNano.app`;
const VAULT_DIR = `${TEMP}/open-science-p0-keychain.Abc123`;
const VAULT = `${VAULT_DIR}/test.keychain-db`;
const PROBE = `${APP}/Contents/Resources/backend/node_modules/@aipoch/credential-identity-probe-native/build/Release/credential_identity_probe`;
const ENV = {
  QA_ROOT: ROOT,
  QA_SOURCE_ROOT: "/source",
  QA_APP_BUNDLE: APP,
  QA_KEYCHAIN_HOME: OUTER,
  RUNNER_TEMP: TEMP,
  GITHUB_ACTIONS: "true",
  RUNNER_OS: "macOS",
};
const metadata = {
  schemaVersion: 1,
  platform: "darwin",
  identity: "Open-Science",
  status: "exists",
  reason: "account-metadata-found",
  osStatus: 0,
  account: "Open-Science Key",
};
const opts = () =>
  Object.freeze({
    executablePath: `${APP}/Contents/MacOS/EarthNano`,
    args: Object.freeze([`--user-data-dir=${FIXTURE}/electron-profile`]),
    cwd: "/source",
    env: Object.freeze({
      HOME,
      OPEN_SCIENCE_E2E_ISOLATE_HOME: "1",
      OPEN_SCIENCE_E2E_EXECUTABLE: `${APP}/Contents/MacOS/EarthNano`,
      OPEN_SCIENCE_CONFIG_ROOT: `${FIXTURE}/storage`,
      OPEN_SCIENCE_USER_DATA: `${FIXTURE}/electron-profile`,
      OPEN_SCIENCE_INSTALLATION_STATE_ROOT: `${FIXTURE}/storage/installation-state`,
    }),
  });
function fixture(electronOverride) {
  const dirs = new Set([
    ROOT,
    TEMP,
    OUTER,
    APP,
    `${ROOT}/evidence`,
    FIXTURE,
    VAULT_DIR,
  ]);
  const files = new Set([PROBE, VAULT]);
  const calls = [],
    delegated = [],
    records = [];
  const state = {
    outerPaths: [VAULT],
    mappings: new Map(),
    nativeValue: metadata,
    override: undefined,
    aliases: new Map(),
  };
  const original = async function (options) {
    delegated.push({ options, receiver: this });
    return { fakeApplication: true };
  };
  const electron = electronOverride ?? { launch: original };
  const ports = {
    platform: "darwin",
    loadPlaywright: (source) => {
      assert.equal(source, "/source");
      return { _electron: electron };
    },
    loadProbe: (path) => {
      assert(path.endsWith("/credential-identity-probe-native/index.cjs"));
      return PROBE;
    },
    realpath: async (path) => {
      if (state.aliases.has(path)) return state.aliases.get(path);
      if (!dirs.has(path) && !files.has(path))
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return path;
    },
    lstat: async (path) => ({
      isFile: () => files.has(path),
      isDirectory: () => dirs.has(path),
    }),
    mkdir: async (path) => {
      if (dirs.has(path))
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      dirs.add(path);
    },
    readFile: async (path) => {
      assert.equal(path, PROBE);
      return Buffer.from("fixed fake metadata helper; never executed");
    },
    appendFile: async (path, value) => {
      assert.equal(path, `${ROOT}/evidence/keychain-context-binding.jsonl`);
      records.push(JSON.parse(value));
    },
    run: (file, args, env, maxBuffer) => {
      calls.push({ file, args, env, maxBuffer });
      if (state.override) {
        const result = state.override(file, args, env);
        if (result) return result;
      }
      if (file === "/usr/bin/security") {
        assert.deepEqual(args.slice(0, 3), ["list-keychains", "-d", "user"]);
        if (args.length === 5) {
          assert.equal(args[3], "-s");
          assert.equal(args[4], VAULT);
          assert.equal(env.HOME, HOME);
          // Actual hosted control 39653685174: exit 0 without persistence
          // when the new HOME lacks the Preferences parent directory.
          if (dirs.has(`${env.HOME}/Library/Preferences`))
            state.mappings.set(env.HOME, [args[4]]);
          return { status: 0, signal: null, stdout: "" };
        }
        assert.equal(args.length, 3);
        const paths =
          env.HOME === OUTER
            ? state.outerPaths
            : (state.mappings.get(env.HOME) ?? []);
        return {
          status: 0,
          signal: null,
          stdout: paths.map((path) => `    "${path}"\n`).join(""),
        };
      }
      assert.equal(file, PROBE);
      assert.deepEqual(args, ["Open-Science"]);
      assert.equal(env.HOME, HOME);
      assert.equal(maxBuffer, 4096);
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify(state.nativeValue),
      };
    },
  };
  return { ports, electron, original, state, calls, delegated, records, dirs };
}
const install = (f) =>
  installKeychainLaunchContext({ environment: ENV, ports: f.ports });

test("binds one original wrapper vault across initial launch and same-owner relaunch without changing options", async () => {
  const f = fixture();
  install(f);
  const options = opts(),
    before = JSON.stringify(options);
  assert.deepEqual(await f.electron.launch(options), { fakeApplication: true });
  assert.deepEqual(await f.electron.launch(options), { fakeApplication: true });
  assert.equal(JSON.stringify(options), before);
  assert(
    f.delegated.every(
      (call) => call.options === options && call.receiver === f.electron,
    ),
  );
  assert.equal(f.calls.length, 8);
  assert.equal(f.records.length, 2);
  assert.deepEqual(
    f.records.map((row) => row.homeExisted),
    [false, true],
  );
  assert(
    f.records.every(
      (row) => row.vault === VAULT && row.metadata.status === "exists",
    ),
  );
  assert(
    !f.calls.some((call) =>
      call.args.some((arg) =>
        ["create-keychain", "add-generic-password", "-g", "-w", "-A"].includes(
          arg,
        ),
      ),
    ),
  );
});

test("requires original isolated options and fixed package before any native operation or delegation", async () => {
  for (const changed of [
    { executablePath: "/other/app" },
    { env: { ...opts().env, OPEN_SCIENCE_E2E_ISOLATE_HOME: "0" } },
    { env: { ...opts().env, HOME: OUTER } },
    { env: { ...opts().env, OPEN_SCIENCE_CONFIG_ROOT: "/other/storage" } },
  ]) {
    const f = fixture();
    install(f);
    await assert.rejects(
      f.electron.launch({ ...opts(), ...changed }),
      /Packaged Keychain context:/,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.delegated.length, 0);
  }
});

test("rejects canonical-path escapes before binding a search list", async () => {
  for (const path of [
    FIXTURE,
    HOME,
    `${HOME}/Library`,
    `${HOME}/Library/Preferences`,
  ]) {
    const f = fixture();
    f.state.aliases.set(path, "/foreign/path");
    install(f);
    await assert.rejects(
      f.electron.launch(opts()),
      /Packaged Keychain context:/,
    );
    assert(!f.calls.some((call) => call.args.includes("-s")));
    assert.equal(f.delegated.length, 0);
  }
});

test("rejects missing, ambiguous, foreign or aliased outer Keychain ownership and never delegates", async () => {
  for (const paths of [
    [],
    [VAULT, VAULT],
    ["/Users/runner/Library/Keychains/login.keychain-db"],
  ]) {
    const f = fixture();
    f.state.outerPaths = paths;
    install(f);
    await assert.rejects(f.electron.launch(opts()));
    assert.equal(f.calls.length, 1);
    assert.equal(f.delegated.length, 0);
  }
  const f = fixture();
  f.state.aliases.set(VAULT, "/foreign/test.keychain-db");
  install(f);
  await assert.rejects(f.electron.launch(opts()));
  assert.equal(f.delegated.length, 0);
});

test("mapping/readback failures and unconfirmed native metadata are fail-closed", async () => {
  const cases = [
    (f) => {
      f.state.override = (_file, args) =>
        args.includes("-s")
          ? { status: 7, signal: null, stdout: "" }
          : undefined;
    },
    (f) => {
      f.state.override = (file, args, env) =>
        file === "/usr/bin/security" && args.length === 3 && env.HOME === HOME
          ? { status: 0, signal: null, stdout: "" }
          : undefined;
    },
    (f) => {
      f.state.nativeValue = {
        ...metadata,
        status: "not-found",
        reason: "account-not-found",
        osStatus: -25300,
      };
    },
    (f) => {
      f.state.nativeValue = { ...metadata, account: "wrong-account" };
    },
    (f) => {
      f.state.nativeValue = { ...metadata, secret: "NEVER-LOG-THIS" };
    },
    (f) => {
      f.state.override = (file) =>
        file === PROBE
          ? { status: null, signal: "SIGTERM", stdout: "" }
          : undefined;
    },
  ];
  for (const change of cases) {
    const f = fixture();
    change(f);
    install(f);
    await assert.rejects(f.electron.launch(opts()));
    assert.equal(f.delegated.length, 0);
    assert(!JSON.stringify(f.records).includes("NEVER-LOG-THIS"));
    assert.equal(f.records.at(-1).stage, "setup-failed");
  }
});

test("refuses a changed wrapper vault on relaunch instead of reseeding or fallback", async () => {
  const f = fixture();
  install(f);
  await f.electron.launch(opts());
  const nextDir = `${TEMP}/open-science-p0-keychain.Def456`,
    next = `${nextDir}/test.keychain-db`;
  f.state.outerPaths = [next];
  f.dirs.add(nextDir);
  const stat = f.ports.lstat;
  f.ports.lstat = async (path) =>
    path === next ? { isFile: () => true } : stat(path);
  const real = f.ports.realpath;
  f.ports.realpath = async (path) => (path === next ? next : real(path));
  await assert.rejects(f.electron.launch(opts()), /vault changed/);
  assert.equal(f.delegated.length, 1);
});

test("preserves the original delegated launch error and never retries it", async () => {
  const failure = new Error("original-launch-failure");
  let count = 0;
  const f = fixture({
    launch: async () => {
      count++;
      throw failure;
    },
  });
  install(f);
  await assert.rejects(f.electron.launch(opts()), (error) => error === failure);
  assert.equal(count, 1);
});

test("rejects non-hosted installation and duplicate decoration without probing", () => {
  const f = fixture();
  assert.throws(() =>
    installKeychainLaunchContext({
      environment: { ...ENV, GITHUB_ACTIONS: "false" },
      ports: f.ports,
    }),
  );
  assert.equal(f.calls.length, 0);
  install(f);
  assert.throws(() => install(f), /exactly once/);
});

test("decorates the actual source Playwright singleton, delegates only to a fake launch, and restores it", async () => {
  const req = createRequire(`${SOURCE_ROOT}/package.json`);
  const actual = req("playwright")._electron;
  const prior = Object.getOwnPropertyDescriptor(actual, "launch");
  const original = actual.launch;
  let count = 0;
  try {
    actual.launch = async (options) => {
      assert.equal(options, provided);
      count++;
      return "fake-only";
    };
    const f = fixture(actual);
    f.ports.loadPlaywright = () => req("playwright");
    const provided = opts();
    install(f);
    assert.equal(
      await req("playwright")._electron.launch(provided),
      "fake-only",
    );
    assert.equal(count, 1);
    assert.equal(f.calls.length, 4);
  } finally {
    if (prior) Object.defineProperty(actual, "launch", prior);
    else delete actual.launch;
  }
  assert.equal(actual.launch, original);
});

test("science finalizer additionally requires complete original metadata evidence for both launches", async () => {
  const { assertKeychainContextEvidence } =
    await import("./keychain-launch-context.mjs");
  const f = fixture();
  install(f);
  await f.electron.launch(opts());
  await f.electron.launch(opts());
  const context = {
    root: ROOT,
    runnerTemp: TEMP,
    app: APP,
    probeSha256: f.records[0].probeSha256,
  };
  assert.doesNotThrow(() => assertKeychainContextEvidence(f.records, context));
  for (const rows of [
    [],
    [f.records[0]],
    [f.records[0], { ...f.records[1], stage: "setup-failed" }],
    [f.records[0], { ...f.records[1], probeSha256: "a".repeat(64) }],
    [f.records[0], { ...f.records[1], home: "/foreign/isolated home" }],
    [
      f.records[0],
      {
        ...f.records[1],
        vault: `${TEMP}/open-science-p0-keychain.Other/test.keychain-db`,
      },
    ],
    [
      f.records[0],
      { ...f.records[1], metadata: { ...metadata, status: "not-found" } },
    ],
  ])
    assert.throws(() => assertKeychainContextEvidence(rows, context));
});

test("CJS require can load the hook without top-level await or any native action", () => {
  const require = createRequire(import.meta.url);
  const module = require("./keychain-launch-context.mjs");
  assert.equal(typeof module.installKeychainLaunchContext, "function");
  assert.equal(typeof module.assertKeychainContextEvidence, "function");
});

test("updated projection preserves every original business byte and adds only the reviewed host hook", async () => {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const { adaptSpec } = await import(pathToFileURL(PREPARE_PATH));
  const source = SOURCE_ROOT;
  const specPath = join(source, "e2e/earthnano-notebook-optimization.spec.ts");
  const original = await readFile(specPath, "utf8");
  const { adapted, proof } = adaptSpec(
    original,
    specPath,
    join(dirname(PREPARE_PATH), "packaged-diagnostics.mjs"),
  );
  assert.equal(proof.originalSha256, proof.restoredSha256);
  assert.equal(proof.businessBytesUnchanged, true);
  assert.equal(proof.operationalLaunchHookAdded, true);
  assert.equal(adapted.split("installKeychainLaunchContext()").length, 2);
  assert(adapted.includes("process.env.OPEN_SCIENCE_E2E_ISOLATE_HOME !== '1'"));
  if (process.env.QA_FIXTURE_OUTPUT_ROOT) {
    await writeFile(
      join(process.env.QA_FIXTURE_OUTPUT_ROOT, "projection-byteproof.json"),
      JSON.stringify(proof, null, 2) + "\n",
    );
    await writeFile(
      join(process.env.QA_FIXTURE_OUTPUT_ROOT, "loader-probe.spec.ts"),
      adapted,
    );
  }
});

test("actual prepare verifier passes exact probe bytes and rejects changed bytes, missing helper or incomplete evidence", async () => {
  const { mkdir, mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { verifyKeychainContextEvidence } = await import(
    pathToFileURL(PREPARE_PATH)
  );
  const { tmpdir } = await import("node:os");
  const { realpath } = await import("node:fs/promises");
  const temp = await mkdtemp(
    join(await realpath(tmpdir()), "earthnano-keychain-finalizer-"),
  );
  try {
    const root = join(temp, "qa"),
      app = join(root, "extracted/EarthNano.app");
    const probe = join(
      app,
      "Contents/Resources/backend/node_modules/@aipoch/credential-identity-probe-native/build/Release/credential_identity_probe",
    );
    const audit = join(root, "evidence/keychain-context-binding.jsonl");
    await mkdir(dirname(probe), { recursive: true });
    await mkdir(dirname(audit), { recursive: true });
    const bytes = Buffer.from(
      "not executable; fake fixture bytes, never a native program",
    );
    await writeFile(probe, bytes, { mode: 0o600 });
    const row = {
      operatorOnly: true,
      source: "bdc0246383a25990030854f4c2fa100895f29ea6",
      stage: "metadata-confirmed-before-launch",
      home: join(root, "tmp/open-science-electron-e2e-Pure12/isolated home"),
      homeExisted: false,
      vault: join(temp, "open-science-p0-keychain.Fake12/test.keychain-db"),
      probe,
      probeSha256: createHash("sha256").update(bytes).digest("hex"),
      metadata,
    };
    const rows = [
      { ...row, attempt: 1 },
      { ...row, attempt: 2, homeExisted: true },
    ];
    const text = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    const exits = join(root, "evidence/process-exit.json");
    await writeFile(
      exits,
      JSON.stringify({ originalWrapperAndTestExit: 0, teeExit: 0 }),
    );
    await writeFile(audit, text);
    await assert.doesNotReject(verifyKeychainContextEvidence(root, app, temp));
    await writeFile(
      exits,
      JSON.stringify({ originalWrapperAndTestExit: 1, teeExit: 0 }),
    );
    await assert.rejects(
      verifyKeychainContextEvidence(root, app, temp),
      /Original wrapper\/test/,
    );
    await writeFile(
      exits,
      JSON.stringify({ originalWrapperAndTestExit: 0, teeExit: 0 }),
    );
    await writeFile(probe, Buffer.from("different bytes"));
    await assert.rejects(verifyKeychainContextEvidence(root, app, temp));
    await rm(probe);
    await assert.rejects(verifyKeychainContextEvidence(root, app, temp));
    await writeFile(probe, bytes, { mode: 0o600 });
    await writeFile(audit, JSON.stringify(rows[0]));
    await assert.rejects(
      verifyKeychainContextEvidence(root, app, temp),
      /Complete original launch-context/,
    );
    await writeFile(
      audit,
      JSON.stringify(rows[0]) +
        "\n" +
        JSON.stringify({ ...rows[1], stage: "setup-failed" }) +
        "\n",
    );
    await assert.rejects(verifyKeychainContextEvidence(root, app, temp));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
