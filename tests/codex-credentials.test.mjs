// Regression guard for the Codex credential failure in the box.
//
// The in-box turn resolves auth.json under the box home, while the deployment
// mounts the operator's ~/.codex at /root/.codex, which no box process can read.
// The failure surfaced as a bare ENOENT from lstatSync, which named neither the
// path searched nor the plane that needed it. It now names both.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

// Package imports stay external, so the bundle is written inside the repository
// where Node resolves them from the repository's node_modules.
async function loadModule() {
  const buildRoot = await mkdtemp(path.join(repositoryRoot, ".tmp-codex-credentials-"));
  const outfile = path.join(buildRoot, "provider-session.mjs");
  await build({
    entryPoints: [path.join(repositoryRoot, "source/host/extensions/inference/provider-session.ts")],
    bundle: true,
    format: "esm",
    packages: "external",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  return { module: await import(pathToFileURL(outfile).href), buildRoot };
}

test("a missing Codex credential names the path and the plane", async () => {
  const { module, buildRoot } = await loadModule();
  const previousHome = process.env.CODEX_HOME;
  const previousInBox = process.env.SAND_HOST_IN_BOX;
  const emptyHome = await mkdtemp(path.join(tmpdir(), "grok-codex-absent-"));
  try {
    process.env.CODEX_HOME = emptyHome;
    process.env.SAND_HOST_IN_BOX = "1";
    const executor = module.createProviderPromptSession("codex").getExecutor([]);
    assert.throws(
      () => executor.stream({}),
      (error) => {
        assert.match(error.message, /no credentials at/);
        assert.ok(error.message.includes(path.join(emptyHome, "auth.json")), "the resolved path must appear in the message");
        assert.match(error.message, /inside the local computer/, "the in-box plane must be named");
        assert.match(error.message, /CODEX_HOME/);
        return true;
      },
    );

    // Outside the box the same resolution reports without claiming the box.
    delete process.env.SAND_HOST_IN_BOX;
    const outside = module.createProviderPromptSession("codex").getExecutor([]);
    assert.throws(() => outside.stream({}), (error) => !/inside the local computer/.test(error.message));
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousInBox === undefined) delete process.env.SAND_HOST_IN_BOX;
    else process.env.SAND_HOST_IN_BOX = previousInBox;
    await rm(emptyHome, { recursive: true, force: true });
    await rm(buildRoot, { recursive: true, force: true });
  }
});
