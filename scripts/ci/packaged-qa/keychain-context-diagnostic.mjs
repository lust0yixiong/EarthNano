// DRAFT: hosted-runner metadata diagnosis only. Never launch the application or tests.
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "bdc0246383a25990030854f4c2fa100895f29ea6";
const identities = ["Open-Science", "Open Science"];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (path, data) =>
  writeFile(path, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
const statusOf = (result) => ({
  exit: result.status,
  signal: result.signal,
  ...(result.error ? { errorCode: result.error.code ?? "spawn-error" } : {}),
});
const safeEnvironment = (env) =>
  Object.fromEntries(
    [
      "HOME",
      "USER",
      "LOGNAME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "CI",
      "GITHUB_ACTIONS",
      "RUNNER_OS",
      "OPEN_SCIENCE_E2E_ISOLATE_HOME",
      "OPEN_SCIENCE_CONFIG_ROOT",
      "OPEN_SCIENCE_USER_DATA",
      "OPEN_SCIENCE_INSTALLATION_STATE_ROOT",
    ]
      .filter((key) => env[key] !== undefined)
      .map((key) => [key, env[key]]),
  );

export function parseNativeMetadata(native, identity) {
  try {
    const value = JSON.parse(native.stdout);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.platform, "darwin");
    assert.equal(value.identity, identity);
    assert(
      [
        "exists",
        "not-found",
        "access-blocked",
        "error",
        "unsupported",
      ].includes(value.status),
    );
    assert(
      Object.keys(value).every((key) =>
        [
          "schemaVersion",
          "platform",
          "identity",
          "status",
          "reason",
          "osStatus",
          "account",
        ].includes(key),
      ),
    );
    if (value.account !== undefined)
      assert([identity, `${identity} Key`].includes(value.account));
    assert(Number.isInteger(value.osStatus));
    assert(typeof value.reason === "string" && /^[a-z-]*$/.test(value.reason));
    return value;
  } catch {
    return {
      invalidOutput: true,
      stdoutBytes: Buffer.byteLength(native.stdout ?? ""),
    };
  }
}

// Ports are injected by pure tests; the CLI supplies them only after its hosted guards.
export async function observeBindingControls(
  {
    root,
    runnerTemp,
    probe,
    outerEnvironment,
    envI,
    launchEnvironment,
    saveResult,
  },
  ports,
) {
  assert.equal(await ports.realpath(root), root);
  assert(root.startsWith(runnerTemp + "/"));
  assert.equal(await ports.realpath(runnerTemp), runnerTemp);
  assert.equal(
    probe,
    join(
      root,
      "extracted/EarthNano.app/Contents/Resources/backend/node_modules/@aipoch/credential-identity-probe-native/build/Release/credential_identity_probe",
    ),
  );
  assert((await ports.lstat(probe)).isFile());
  const okay = (result) =>
    !result.error && result.status === 0 && !result.signal;
  const capture = (operation, result) => ({
    operation,
    ...statusOf(result),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
    stdoutSha256: sha(result.stdout ?? ""),
  });
  const pathsOf = (stdout) => {
    const lines = String(stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      nonemptyLineCount: lines.length,
      paths: lines.every((line) => /^"[^"\r\n]+"$/.test(line))
        ? lines.map((line) => line.slice(1, -1))
        : null,
    };
  };
  const inspect = async (home) => {
    const result = {};
    for (const [name, path] of Object.entries({
      home,
      library: join(home, "Library"),
      preferences: join(home, "Library/Preferences"),
      plist: join(home, "Library/Preferences/com.apple.security.plist"),
    })) {
      try {
        const stat = await ports.lstat(path);
        result[name] = {
          path,
          exists: true,
          file: stat.isFile(),
          directory: stat.isDirectory(),
          symlink: stat.isSymbolicLink(),
          mode: stat.mode & 0o777,
          uid: stat.uid,
          gid: stat.gid,
          bytes: stat.size,
          canonicalPath: await ports.realpath(path),
        };
        assert.equal(result[name].symlink, false, "No linked control path");
        assert.equal(
          result[name].canonicalPath,
          path,
          "Canonical owned control path required",
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        result[name] = { path, exists: false };
      }
    }
    return result;
  };
  // Read the actual single vault selected by the unchanged original wrapper, never invent one.
  const outer = ports.run(
    "/usr/bin/security",
    ["list-keychains", "-d", "user"],
    outerEnvironment,
  );
  const parsed = pathsOf(outer.stdout);
  await saveResult("binding-controls-owner.json", {
    diagnosticOnly: true,
    ...capture("original-wrapper-search-list", outer),
    ...parsed,
  });
  assert(
    okay(outer) && parsed.paths?.length === 1,
    "One original wrapper vault required",
  );
  const [vault] = parsed.paths;
  assert.equal(await ports.realpath(vault), vault);
  const vaultRoot = dirname(vault);
  assert.equal(dirname(vaultRoot), runnerTemp);
  assert(
    /^open-science-p0-keychain\.[A-Za-z0-9]+$/.test(
      vaultRoot.slice(runnerTemp.length + 1),
    ),
  );
  assert.equal(vault.slice(vaultRoot.length + 1), "test.keychain-db");
  assert((await ports.lstat(vaultRoot)).isDirectory());
  assert((await ports.lstat(vault)).isFile());
  const observations = [];
  for (const [name, createPreferences] of [
    ["home-only", false],
    ["home-with-preferences", true],
  ]) {
    const fixtureRoot = await ports.mkdtemp(
      join(root, "tmp/open-science-electron-e2e-"),
    );
    assert.equal(await ports.realpath(fixtureRoot), fixtureRoot);
    assert.equal(dirname(fixtureRoot), join(root, "tmp"));
    assert(
      /^open-science-electron-e2e-[A-Za-z0-9]+$/.test(
        fixtureRoot.slice(join(root, "tmp").length + 1),
      ),
    );
    const storageRoot = join(fixtureRoot, "storage");
    await ports.mkdir(storageRoot);
    const env = launchEnvironment(
      storageRoot,
      undefined,
      envI,
      undefined,
      "normal",
      false,
    );
    const home = join(fixtureRoot, "isolated home");
    assert.equal(env.HOME, home);
    assert.equal(env.OPEN_SCIENCE_E2E_ISOLATE_HOME, "1");
    await ports.mkdir(home);
    const allocated = await inspect(home);
    assert.equal(allocated.library.exists, false);
    if (createPreferences) {
      await ports.mkdir(join(home, "Library"));
      await ports.mkdir(join(home, "Library/Preferences"));
    }
    const beforeSet = await inspect(home);
    const set = ports.run(
      "/usr/bin/security",
      ["list-keychains", "-d", "user", "-s", vault],
      env,
    );
    const afterSet = await inspect(home);
    const readback = ports.run(
      "/usr/bin/security",
      ["list-keychains", "-d", "user"],
      env,
    );
    const readbackShape = pathsOf(readback.stdout);
    const afterReadback = await inspect(home);
    const native = ports.run(probe, ["Open-Science"], env, 4096);
    const metadata = parseNativeMetadata(native, "Open-Science");
    const afterMetadata = await inspect(home);
    const record = {
      diagnosticOnly: true,
      name,
      createPreferences,
      vault,
      probe,
      environment: safeEnvironment(env),
      allocated,
      beforeSet,
      afterSet,
      afterReadback,
      afterMetadata,
      commands: [
        capture("same-wrapper-vault-set-once", set),
        { ...capture("readback-once", readback), ...readbackShape },
        {
          operation: "original-packaged-native-metadata-probe",
          identity: "Open-Science",
          ...statusOf(native),
          result: metadata,
        },
      ],
      uniqueSameVaultReadback:
        okay(readback) &&
        readbackShape.paths?.length === 1 &&
        readbackShape.paths[0] === vault,
      applicationLaunched: false,
      noAcceptanceResult: true,
    };
    await saveResult(`binding-controls-${name}.json`, record);
    observations.push(record);
  }
  const outerAfter = ports.run(
    "/usr/bin/security",
    ["list-keychains", "-d", "user"],
    outerEnvironment,
  );
  const afterShape = pathsOf(outerAfter.stdout);
  await saveResult("binding-controls-outer-after.json", {
    diagnosticOnly: true,
    ...capture("original-wrapper-search-list-after", outerAfter),
    ...afterShape,
  });
  assert(
    okay(outerAfter) &&
      afterShape.paths?.length === 1 &&
      afterShape.paths[0] === vault,
    "Outer original wrapper search list changed",
  );
  return observations;
}

async function main() {
  // Do not loosen these guards to execute this diagnostic on an operator's machine.
  assert.equal(process.platform, "darwin");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_OS, "macOS");
  for (const key of ["QA_ROOT", "QA_SOURCE_ROOT", "RUNNER_TEMP"])
    assert(process.env[key]);
  const root = await realpath(process.env.QA_ROOT);
  assert(root.startsWith((await realpath(process.env.RUNNER_TEMP)) + "/"));
  const source = await realpath(process.env.QA_SOURCE_ROOT);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8",
    }).trim(),
    SOURCE,
  );
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: source,
      encoding: "utf8",
    }).trim(),
    "",
  );
  const launch = JSON.parse(
    await readFile(join(root, "evidence/launch.json"), "utf8"),
  );
  const app = await realpath(launch.app);
  assert.equal(app, join(root, "extracted/EarthNano.app"));
  assert.equal(launch.executable, join(app, "Contents/MacOS/EarthNano"));
  const modulePath = join(
    app,
    "Contents/Resources/backend/node_modules/@aipoch/credential-identity-probe-native/index.cjs",
  );
  const { executablePath: probe } = createRequire(modulePath)(modulePath);
  assert.equal(
    probe,
    join(dirname(modulePath), "build/Release/credential_identity_probe"),
  );
  assert((await lstat(probe)).isFile());
  const wrapper = join(source, "scripts/ci/run-macos-packaged-e2e.sh");
  const output = join(root, "evidence/keychain-context-diagnostic");
  const self = fileURLToPath(import.meta.url);

  if (process.argv[2] !== "--after-original-wrapper-seed") {
    assert.equal(process.argv.length, 2);
    await mkdir(output); // New diagnosis directory; never append/reuse a prior result.
    await save(join(output, "plan.json"), {
      diagnosticOnly: true,
      applicationSource: SOURCE,
      applicationExecutable: launch.executable,
      probe,
      probeSha256: sha(await readFile(probe)),
      wrapperSha256: sha(await readFile(wrapper)),
      purpose:
        "Compare metadata visibility after original wrapper setup; no application/scientific execution",
      isolatedSetupControl:
        "Two fresh HOME directories; only one precreates Library/Preferences; same wrapper vault, one set per HOME",
      commands: [
        [
          "/usr/bin/security",
          "list-keychains",
          "-d",
          "user",
          "-s",
          "<same-owned-wrapper-vault>",
        ],
        [probe, "<identity>"],
        ["/usr/bin/security", "list-keychains", "-d", "user"],
        [
          "/usr/bin/security",
          "find-generic-password",
          "-a",
          "<identity> Key",
          "-s",
          "<identity> Safe Storage",
        ],
      ],
    });
    const result = spawnSync(
      "bash",
      [wrapper, process.execPath, self, "--after-original-wrapper-seed"],
      {
        cwd: source,
        env: { ...process.env, OPEN_SCIENCE_E2E_EXECUTABLE: launch.executable },
        stdio: "inherit",
      },
    );
    await save(join(output, "wrapper-exit.json"), {
      diagnosticOnly: true,
      ...statusOf(result),
    });
    process.exitCode =
      result.status === 0 && !result.signal && !result.error ? 0 : 1;
  } else {
    assert.equal(process.argv.length, 3);
    assert((await lstat(join(output, "plan.json"))).isFile());
    // Match the App-relevant run.sh flags; the original launchEnvironment strips
  // host-only metadata. The second context changes only HOME.
    const envI = {
      PATH: process.env.PATH,
      HOME: join(root, "runner-home"),
      TMPDIR: join(root, "tmp"),
      QA_SOURCE_ROOT: source,
      QA_ROOT: root,
      QA_APP_BUNDLE: app,
      OPEN_SCIENCE_E2E_ISOLATE_HOME: "1",
      OPEN_SCIENCE_E2E_EXECUTABLE: launch.executable,
      EARTHNANO_LIVE_DEEPSEEK: "0",
      EARTHNANO_NOTEBOOK_LANGUAGE: "python",
      EARTHNANO_E2E_BINARY: "0",
      EARTHNANO_E2E_RESUME: "1",
      EARTHNANO_E2E_SWEEP: "0",
    };
    await mkdir(join(root, "tmp"), { recursive: true });
    await mkdir(join(root, "runner-home"), { recursive: true });
    const testRoot = await mkdtemp(
      join(root, "tmp/open-science-electron-e2e-"),
    );
    const storageRoot = join(testRoot, "storage");
    await mkdir(storageRoot);
    // Reuse the pinned original function itself; do not maintain a parallel OS/environment allowlist.
    // Importing the entire fixture would register Playwright tests, so transpile only this pure function.
    const fixture = await readFile(
      join(source, "e2e/fixtures/electron-app.ts"),
      "utf8",
    );
    const start = fixture.indexOf("const launchEnvironment = (");
    const end = fixture.indexOf("\nconst launchOpenScience =", start);
    assert(start >= 0 && end > start);
    const originalFunction = fixture.slice(start, end);
    const ts = createRequire(join(source, "package.json"))("typescript");
    const js = ts.transpileModule(originalFunction, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
      reportDiagnostics: true,
    });
    assert.deepEqual(js.diagnostics ?? [], []);
    const launchEnvironment = new Function(
      "join",
      "dirname",
      "delimiter",
      "process",
      js.outputText + "\nreturn launchEnvironment;",
    )(join, dirname, delimiter, process);
    const isolated = launchEnvironment(
      storageRoot,
      undefined,
      envI,
      undefined,
      "normal",
      false,
    );
    assert.equal(isolated.HOME, join(testRoot, "isolated home"));
    // The original fixture does not create HOME before launch; preserve that initial state.
    await save(join(output, "original-fixture-function.json"), {
      path: "e2e/fixtures/electron-app.ts",
      sourceSha256: sha(fixture),
      functionSha256: sha(originalFunction),
      storageRoot,
      arguments: {
        fakeAgentBinRoot: null,
        fakeRemoteItRoot: null,
        windowMode: "normal",
        sessionPerformanceTrace: false,
      },
    });
    const contexts = [
      ["original-gha", { ...process.env }],
      ["env-i-original-home", { ...envI, HOME: process.env.HOME }],
      ["env-i-runner-home", envI],
      ["original-launchEnvironment-isolated-home", isolated],
    ];
    const observations = [];
    for (const [name, env] of contexts) {
      const record = {
        name,
        environment: safeEnvironment(env),
        pathSha256: sha(env.PATH ?? ""),
        homePathExistsAtProbeStart: env.HOME
          ? await lstat(env.HOME).then(
              () => true,
              (error) => {
                if (error.code === "ENOENT") return false;
                throw error;
              },
            )
          : null,
        commands: [],
      };
      const search = spawnSync(
        "/usr/bin/security",
        ["list-keychains", "-d", "user"],
        {
          env,
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 65536,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      record.commands.push({
        operation: "search-list-read-only",
        ...statusOf(search),
        stdout: search.stdout ?? "",
        stderr: search.stderr ?? "",
      });
      for (const identity of identities) {
        const metadata = spawnSync(
          "/usr/bin/security",
          [
            "find-generic-password",
            "-a",
            `${identity} Key`,
            "-s",
            `${identity} Safe Storage`,
          ],
          {
            env,
            encoding: "utf8",
            timeout: 10_000,
            maxBuffer: 65536,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        record.commands.push({
          operation: "security-metadata-only",
          identity,
          ...statusOf(metadata),
          stdout: metadata.stdout ?? "",
          stderr: metadata.stderr ?? "",
        });
        const native = spawnSync(probe, [identity], {
          env,
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 4096,
          stdio: ["ignore", "pipe", "ignore"],
        });
        const result = parseNativeMetadata(native, identity);
        record.commands.push({
          operation: "original-packaged-native-metadata-probe",
          identity,
          ...statusOf(native),
          result,
        });
      }
      await save(join(output, `${name}.json`), {
        diagnosticOnly: true,
        ...record,
      });
      observations.push(record);
    }
    const bindingControls = await observeBindingControls(
      {
        root,
        runnerTemp: await realpath(process.env.RUNNER_TEMP),
        probe,
        outerEnvironment: process.env,
        envI,
        launchEnvironment,
        saveResult: (name, value) => save(join(output, name), value),
      },
      {
        lstat,
        realpath,
        mkdir,
        mkdtemp,
        run: (file, args, env, maxBuffer = 65536) =>
          spawnSync(file, args, {
            env,
            encoding: "utf8",
            timeout: 10_000,
            maxBuffer,
            stdio: ["ignore", "pipe", "pipe"],
          }),
      },
    );
    await save(join(output, "diagnostic-summary.json"), {
      diagnosticOnly: true,
      status: "observations-recorded",
      applicationLaunched: false,
      scientificTestExecuted: false,
      noAcceptanceResult: true,
      bindingControls,
      contexts: observations.map(({ name, commands }) => ({ name, commands })),
    });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
