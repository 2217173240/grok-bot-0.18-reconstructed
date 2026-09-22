// Regression guard for the local-admin desktop instructions.
//
// The block is appended on both execution planes, but the primitives are only
// reachable one way on each: the box has the wrappers at /usr/local/bin and no
// docker CLI at all, while the Mac-side plane reaches the same wrappers through
// `docker exec`. A single shared paragraph therefore told in-box models to run
// `docker exec`, which produced `docker: command not found` and a twenty-minute
// probe loop (observed live in the box ledger).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function loadPrimitiveLines() {
  const buildRoot = await mkdtemp(path.join(tmpdir(), "grok-identity-lines-"));
  const outfile = path.join(buildRoot, "provider-session.mjs");
  await build({
    entryPoints: [path.join(repositoryRoot, "source/host/extensions/inference/provider-session.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  const module = await import(pathToFileURL(outfile).href);
  return { claudeLocalToolsPrompt: module.claudeLocalToolsPrompt, buildRoot };
}

test("the desktop instructions name only primitives the invoking plane can execute", async () => {
  const { claudeLocalToolsPrompt, buildRoot } = await loadPrimitiveLines();
  try {
    const inBox = claudeLocalToolsPrompt({ SAND_LOCAL_ADMIN: "1", SAND_HOST_IN_BOX: "1" });
    const fromMac = claudeLocalToolsPrompt({ SAND_LOCAL_ADMIN: "1" });

    // The in-box plane must use the wrappers directly and never mention docker.
    assert.ok(inBox.includes("/usr/local/bin/box-chrome"), "in-box must name the local launcher");
    assert.ok(inBox.includes("/usr/local/bin/box-navigate"), "in-box must name the local navigator");
    assert.ok(!inBox.includes("docker"), "the box has no docker CLI, so the prompt must not tell it to use docker");

    // The Mac plane reaches the same wrappers through docker.
    assert.ok(fromMac.includes("docker exec"), "the Mac plane must reach the box through docker");
    assert.ok(fromMac.includes("/usr/local/bin/box-chrome"), "both planes drive the same launcher");
    assert.ok(fromMac.includes("/usr/local/bin/box-navigate"), "both planes drive the same navigator");

    // Both planes must pass DISPLAY explicitly, since tool children start without
    // the host's exported environment and the wrappers derive ports from it.
    assert.ok(inBox.includes("env DISPLAY=:1"), "in-box must pass DISPLAY explicitly");
    assert.ok(fromMac.includes("env DISPLAY=:1"), "Mac plane must pass DISPLAY explicitly");

    // Neither plane may suggest typing a URL into the address bar.
    assert.ok(inBox.includes("forbidden"), "the egress-gate warning must survive the split");
    assert.ok(fromMac.includes("forbidden"), "the egress-gate warning must survive the split");

    // The shared identity lines stay on both planes.
    for (const prompt of [inBox, fromMac]) {
      assert.ok(prompt.includes(".grokbot/ask-human.json"), "the handoff contract must survive the split");
      assert.ok(prompt.includes("you are the sandbox"), "the local self-image must survive the split");
    }

    // Without local admin there is no identity block at all.
    const plain = claudeLocalToolsPrompt({});
    assert.ok(!plain.includes("you are the sandbox"), "the local block must not leak outside local admin");
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
});
