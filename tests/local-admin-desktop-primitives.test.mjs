// Regression guard for the local-admin desktop instructions.
//
// The block is appended on both execution planes, but the primitives are only
// reachable one way on each: the box has the wrappers at /usr/local/bin and no
// docker CLI at all, while the Mac-side plane reaches the same wrappers through
// `docker exec`. A single shared paragraph therefore told in-box models to run
// `docker exec`, which produced `docker: command not found` and a twenty-minute
// probe loop (observed live in the box ledger).

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  return { claudeLocalToolsPrompt: module.claudeLocalToolsPrompt, claudeToolPermission: module.claudeToolPermission, buildRoot };
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

// The box workspace is bind-mounted from the user's machine, so a command or a
// write inside the box acts on the user's computer. The "Never" setting used to
// govern only the Mac-side tools, leaving the in-box CLI child free to run
// anything while the interface said local tool access was off.
test("local tool access set to Never stops the in-box CLI child, not only the Mac tools", async () => {
  const { claudeToolPermission, buildRoot } = await loadPrimitiveLines();
  const previousAdmin = process.env.SAND_LOCAL_ADMIN;
  const previousWorkspace = process.env.SAND_WORKSPACE_ROOT;
  const workspace = await mkdtemp(path.join(tmpdir(), "grok-permission-workspace-"));
  try {
    process.env.SAND_LOCAL_ADMIN = "1";
    process.env.SAND_WORKSPACE_ROOT = workspace;

    for (const tool of ["Bash", "Write", "Edit", "MultiEdit"]) {
      const decision = claudeToolPermission(tool, { command: "touch x" }, "never");
      assert.equal(decision.behavior, "deny", `${tool} must be denied while the setting is Never`);
      assert.match(decision.message, /Never/);
    }
    // Reading changes nothing the user owns, so it stays available.
    for (const tool of ["Read", "Glob", "Grep", "LS", "TodoWrite"]) {
      assert.equal(claudeToolPermission(tool, {}, "never").behavior, "allow", `${tool} must stay available`);
    }

    // The box boundary governs the other two values: a per-command prompt for a
    // disposable sandbox would add noise without adding a decision.
    for (const permission of ["ask", "always", undefined]) {
      assert.equal(claudeToolPermission("Bash", {}, permission).behavior, "allow", `permission ${permission} keeps the box boundary`);
    }

    // A human handoff still wins: the box is paused for the human at the screen.
    const askDirectory = path.join(workspace, ".grokbot");
    await mkdir(askDirectory, { recursive: true });
    await writeFile(path.join(askDirectory, "ask-human.json"), "{}\n");
    const duringHandoff = claudeToolPermission("Bash", {}, "never");
    assert.equal(duringHandoff.behavior, "deny");
    assert.match(duringHandoff.message, /awaiting a human handoff/);
  } finally {
    if (previousAdmin === undefined) delete process.env.SAND_LOCAL_ADMIN;
    else process.env.SAND_LOCAL_ADMIN = previousAdmin;
    if (previousWorkspace === undefined) delete process.env.SAND_WORKSPACE_ROOT;
    else process.env.SAND_WORKSPACE_ROOT = previousWorkspace;
    await rm(workspace, { recursive: true, force: true });
    await rm(buildRoot, { recursive: true, force: true });
  }
});
