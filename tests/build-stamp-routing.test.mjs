import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const bundleDirectory = path.join(root, ".cache");
await mkdir(bundleDirectory, { recursive: true });
const bundle = path.join(bundleDirectory, "build-stamp-routing.mjs");
await build({ stdin: { contents: `export { readMacRouting, readExpectedDepsPinFrom } from "./source/electron-main/box/local-docker-host-connector.ts";`, resolveDir: root, loader: "ts" }, outfile: bundle, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
const { readMacRouting, readExpectedDepsPinFrom } = await import(pathToFileURL(bundle).href);

test("routing defaults only for a missing settings file and rejects malformed values", async () => {
  const directory = await mkdtemp(path.join(root, ".cache/routing-"));
  try {
    assert.deepEqual(await readMacRouting(path.join(directory, "missing.json")), { provider: "claude-code", commandCodeModel: undefined });
    const settings = path.join(directory, "settings.json");
    await writeFile(settings, JSON.stringify({ inferenceProvider: "unknown" }));
    await assert.rejects(readMacRouting(settings), /Invalid inference provider/);
    await writeFile(settings, JSON.stringify([]));
    await assert.rejects(readMacRouting(settings), /Invalid routing settings/);
    await writeFile(settings, JSON.stringify({ commandCodeModel: 7 }));
    await assert.rejects(readMacRouting(settings), /Invalid commandCodeModel/);
    await writeFile(settings, "{");
    await assert.rejects(readMacRouting(settings), SyntaxError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("build stamp is optional for source bundles and strict when resources are packaged", async () => {
  const directory = await mkdtemp(path.join(root, ".cache/stamp-"));
  try {
    assert.equal(await readExpectedDepsPinFrom(directory, undefined), undefined);
    const ancestor = path.join(directory, "ancestor");
    await mkdir(ancestor);
    await writeFile(path.join(ancestor, "build-stamp.json"), JSON.stringify({ depsPin: "a".repeat(64) }));
    const resources = path.join(ancestor, "Resources");
    await mkdir(resources);
    await assert.rejects(readExpectedDepsPinFrom(resources, resources), /Missing build stamp/);
    await writeFile(path.join(directory, "build-stamp.json"), JSON.stringify({ depsPin: "bad" }));
    await assert.rejects(readExpectedDepsPinFrom(directory, undefined), /Invalid build stamp/);
    const pin = "a".repeat(64);
    await writeFile(path.join(directory, "build-stamp.json"), JSON.stringify({ depsPin: pin }));
    assert.equal(await readExpectedDepsPinFrom(directory, undefined), pin);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
