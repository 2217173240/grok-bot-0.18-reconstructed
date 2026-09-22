// Regression guard for the staging completeness check.
//
// The host resolves agent-isolation and extension workers relative to argv[1] at
// runtime, and the staged directory is named from host-main.cjs and the daemon
// alone, so a runtime tree that lost a subtree is indistinguishable from a good
// one once staged. That already happened once: a single-file mount left an
// in-box turn to die on a missing agent-store-worker.cjs at runtime with nothing
// reported at staging time. Staging must therefore refuse a short tree.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

// The connector resolves the runtime as ../host and ../../host relative to its
// own module directory, so the bundle must sit beside the seeded tree exactly as
// it does inside the packaged app.
async function seedBundle(workRoot, options) {
  const bundleDir = path.join(workRoot, "bundle", "dist", "electron-main");
  const hostDir = path.join(workRoot, "bundle", "dist", "host");
  const daemonDir = path.join(workRoot, "bundle", "dist", "box-exec-daemon");
  await mkdir(bundleDir, { recursive: true });
  await mkdir(hostDir, { recursive: true });
  await mkdir(daemonDir, { recursive: true });
  await writeFile(path.join(hostDir, "host-main.cjs"), "// host entry\n");
  await writeFile(path.join(daemonDir, "main.cjs"), "// daemon entry\n");
  if (options.withAgentIsolation) {
    const dir = path.join(hostDir, "agent-isolation");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "agent-store-worker.cjs"), "// worker\n");
  }
  if (options.withExtensions) {
    const dir = path.join(hostDir, "extensions", "box-store-sync");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "box-store-vacuum-worker.cjs"), "// worker\n");
  }
  const outfile = path.join(bundleDir, "connector.mjs");
  await build({
    entryPoints: [path.join(repositoryRoot, "source/electron-main/box/local-docker-host-connector.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  return { outfile, outputRoot: path.join(workRoot, "out") };
}

test("staging refuses a runtime tree that is missing a worker directory", async () => {
  const workRoot = await mkdtemp(path.join(tmpdir(), "grok-staging-completeness-"));
  try {
    // Complete tree: staged, and the whole tree (not just the entry file) lands.
    const complete = await seedBundle(path.join(workRoot, "complete"), { withAgentIsolation: true, withExtensions: true });
    await mkdir(complete.outputRoot, { recursive: true });
    const completeModule = await import(pathToFileURL(complete.outfile).href);
    const staged = await completeModule.stageCurrentHostBundle(path.join(complete.outputRoot, "settings.json"));
    assert.ok(staged.path.endsWith(path.join("sand-host")), "the mount unit is the sand-host directory");

    // Missing a directory the host resolves at runtime: refused at staging time.
    for (const [label, options] of [
      ["agent-isolation", { withAgentIsolation: false, withExtensions: true }],
      ["extensions", { withAgentIsolation: true, withExtensions: false }],
    ]) {
      const broken = await seedBundle(path.join(workRoot, label), options);
      await mkdir(broken.outputRoot, { recursive: true });
      const brokenModule = await import(pathToFileURL(broken.outfile).href);
      await assert.rejects(
        () => brokenModule.stageCurrentHostBundle(path.join(broken.outputRoot, "settings.json")),
        new RegExp(`missing ${label}`),
        `a tree without ${label} must be refused`,
      );
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});
