import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const archiveRoot = path.join(repositoryRoot, "research-archives", "original", "0.18.0");

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function parseGitLfsPointer(text) {
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = /^size ([0-9]+)$/m.exec(text)?.[1];
  assert.ok(oid && size, "expected a Git LFS pointer with oid sha256: and size");
  return { oid, size: Number(size) };
}

test("preserved 0.18.0 installers match the exact public release inventory", async () => {
  const manifest = JSON.parse(await readFile(path.join(archiveRoot, "artifacts.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["artifacts", "product", "schemaVersion", "version"]);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.product, "Grok Bot");
  assert.equal(manifest.version, "0.18.0");
  assert.equal(manifest.artifacts.length, 2);

  for (const artifact of manifest.artifacts) {
    assert.deepEqual(
      Object.keys(artifact).sort(),
      ["architecture", "bytes", "path", "platform", "sha256", "sourceUrl"],
    );
    assert.match(artifact.path, /^(macos-arm64\/[^/]+\.dmg|windows-x64\/[^/]+\.exe)$/);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    // Live 0.18.0 installers are under sand/; historical grokbot/ URLs now 403.
    assert.match(artifact.sourceUrl, /^https:\/\/downloads\.cursor\.com\/sand\/stable\//);
    const file = path.join(archiveRoot, artifact.path);
    assert.ok(file.startsWith(`${archiveRoot}${path.sep}`));
    const metadata = await lstat(file);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.isSymbolicLink(), false);
    if (metadata.size < 1000) {
      const pointer = parseGitLfsPointer(await readFile(file, "utf8"));
      assert.equal(pointer.oid, artifact.sha256);
      assert.equal(pointer.size, artifact.bytes);
    } else {
      assert.equal(metadata.size, artifact.bytes);
      assert.equal(await sha256(file), artifact.sha256);
    }
  }
});

test("bootstrap prefers the hash-pinned local archive before the network", async () => {
  const [attributes, config, bootstrap] = await Promise.all([
    readFile(path.join(repositoryRoot, ".gitattributes"), "utf8"),
    readFile(path.join(repositoryRoot, "scripts", "lib", "config.mjs"), "utf8"),
    readFile(path.join(repositoryRoot, "scripts", "bootstrap-runtime.mjs"), "utf8"),
  ]);
  assert.match(attributes, /research-archives\/original\/\*\*\/\*\.dmg filter=lfs diff=lfs merge=lfs -text/);
  assert.match(attributes, /research-archives\/original\/\*\*\/\*\.exe filter=lfs diff=lfs merge=lfs -text/);
  assert.match(config, /export const archivedDmg = path\.join\(repoRoot, "research-archives", "original", "0\.18\.0", "macos-arm64", "Grok_Bot_0\.18\.0\.dmg"\)/);
  assert.match(bootstrap, /const archivedDigest = await sha256\(archivedDmg\)/);
  assert.match(bootstrap, /if \(archivedDigest !== dmgSha256\)/);
  assert.match(bootstrap, /await copyFile\(archivedDmg, cachedDmg\)/);
  assert.ok(bootstrap.indexOf("await copyFile(archivedDmg, cachedDmg)") < bootstrap.indexOf("await fetch(dmgUrl"));
  assert.match(bootstrap, /is an LFS pointer/);
  assert.match(bootstrap, /archivedInfo\.size >= 1000/);
});
