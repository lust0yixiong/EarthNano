import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

export async function hashFile(path) {
  assert((await lstat(path)).isFile(), `Expected regular file: ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function bundleInventory(root) {
  const result = [];
  async function visit(directory, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name),
        relative = prefix + name,
        info = await lstat(path);
      if (info.isSymbolicLink())
        result.push({ path: relative, link: await readlink(path) });
      else if (info.isDirectory()) await visit(path, relative + "/");
      else {
        assert(info.isFile(), `Unexpected bundle entry: ${relative}`);
        result.push({
          path: relative,
          size: info.size,
          sha256: await hashFile(path),
        });
      }
    }
  }
  await visit(root);
  return result;
}

export async function packagedEntrypointSha256() {
  const source = resolve(process.env.QA_SOURCE_ROOT),
    app = resolve(process.env.QA_APP_BUNDLE);
  assert.equal(await realpath(app), app, "Use the real extracted app path");
  const require = createRequire(join(source, "package.json"));
  const asar = require("@electron/asar");
  const archive = join(app, "Contents/Resources/app.asar");
  const result = {
    "Contents/MacOS/EarthNano": await hashFile(
      join(app, "Contents/MacOS/EarthNano"),
    ),
    "Contents/Info.plist": await hashFile(join(app, "Contents/Info.plist")),
    "Contents/Resources/app.asar": await hashFile(archive),
    "Contents/Resources/backend/index.cjs": await hashFile(
      join(app, "Contents/Resources/backend/index.cjs"),
    ),
  };
  for (const member of [
    "out/main/index.js",
    "out/preload/index.js",
    "out/renderer/index.html",
  ]) {
    const info = asar.statFile(archive, member, false);
    assert(
      !("link" in info) && !("files" in info) && !info.unpacked,
      `Expected archived member: ${member}`,
    );
    result[`Contents/Resources/app.asar!/${member}`] = createHash("sha256")
      .update(asar.extractFile(archive, member, false))
      .digest("hex");
  }
  await writeFile(
    join(process.env.QA_ROOT, "evidence/packaged-entrypoints.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}

export async function exportRuntimeIconAssets(source, app, output) {
  const asar = createRequire(join(source, "package.json"))("@electron/asar");
  const archive = join(app, "Contents/Resources/app.asar");
  const members = asar
    .listPackage(archive)
    .map((name) => name.replace(/^\//, ""));
  const evidence = [];
  for (const name of ["icon.png", "icon-dark.png"]) {
    const member = `resources/${name}`;
    assert.equal(
      members.filter((value) => value === member).length,
      1,
      `Missing actual ASAR icon member: ${member}`,
    );
    const info = asar.statFile(archive, member, false);
    assert(
      !("link" in info) && !("files" in info),
      `Not a regular ASAR icon: ${member}`,
    );
    if (info.unpacked)
      await hashFile(join(app, "Contents/Resources/app.asar.unpacked", member));
    const bytes = asar.extractFile(archive, member, false);
    assert.deepEqual(
      bytes,
      await readFile(join(source, member)),
      `Runtime PNG differs from fixed source: ${member}`,
    );
    await writeFile(join(output, name), bytes);
    evidence.push({
      member,
      unpacked: info.unpacked === true,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sourceBytesEqual: true,
    });
  }
  return evidence;
}
