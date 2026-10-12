import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("dev box manifest resolution confines store IDs and symbolic links", async t => {
  const root = path.resolve(import.meta.dirname, "..");
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "dev-store-boundary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, "runtime.mjs");
  await build({ entryPoints: [path.join(root, "source/electron-main/dev/dev-controls-window.ts")], outfile, bundle: true, packages: "external", platform: "node", format: "esm", logLevel: "silent" });
  const { resolveDevBoxStoreManifestPath } = await import(pathToFileURL(outfile).href);
  const storeRoot = path.join(directory, "box-store");
  const valid = path.join(storeRoot, "store-valid");
  const outside = path.join(directory, "outside");
  await mkdir(valid, { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(valid, "manifest.json"), "{}");
  await writeFile(path.join(outside, "manifest.json"), '{"private":true}');
  assert.equal(await resolveDevBoxStoreManifestPath(directory, "store-valid"), path.join(valid, "manifest.json"));
  for (const id of ["", ".", "..", "../outside", "..\\outside", "/absolute", "store-valid/../../outside"]) {
    assert.equal(await resolveDevBoxStoreManifestPath(directory, id), null, id);
  }
  if (process.platform !== "win32") {
    await symlink(outside, path.join(storeRoot, "store-link"));
    assert.equal(await resolveDevBoxStoreManifestPath(directory, "store-link"), null);
  }
});
