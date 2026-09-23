// 本地管理员回合只能通过当前可用的 Task、Browser 或 Computer 工具操作桌面。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function loadPrimitiveLines() {
  await mkdir(path.join(repositoryRoot, ".cache"), { recursive: true });
  const buildRoot = await mkdtemp(path.join(repositoryRoot, ".cache", "grok-identity-lines-"));
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

test("local admin delegates GUI work to Task or the subagent's Computer and Browser tools", async () => {
  const { claudeLocalToolsPrompt, buildRoot } = await loadPrimitiveLines();
  try {
    const inBox = claudeLocalToolsPrompt({ SAND_LOCAL_ADMIN: "1", SAND_HOST_IN_BOX: "1" });
    const fromMac = claudeLocalToolsPrompt({ SAND_LOCAL_ADMIN: "1" });

    assert.equal(inBox, fromMac);
    assert.match(inBox, /Task.*browserUse.*computerUse/);
    assert.match(inBox, /Computer.*mouse.*keyboard.*screenshot/);
    assert.match(inBox, /Browser.*web pages/);
    assert.match(inBox, /Never drive the desktop or browser through Bash/);
    assert.doesNotMatch(inBox, /launch the browser with|input via|screenshot with/);

    // 人工接管和本地身份在两种启动环境中保持一致。
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
  await mkdir(path.join(repositoryRoot, ".cache"), { recursive: true });
  const workspace = await mkdtemp(path.join(repositoryRoot, ".cache", "grok-permission-workspace-"));
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

    // The permission result's updatedInput replaces the input the tool runs
    // with, so an allow must carry the input through unchanged: returning an
    // empty object erased every argument the model supplied, which is fatal for
    // a plugin tool and invisible for the built-in ones.
    const toolInput = { text: "plugin-ok", nested: { keep: true } };
    assert.deepEqual(claudeToolPermission("Read", toolInput, "never").updatedInput, toolInput);
    assert.deepEqual(claudeToolPermission("Bash", toolInput, "ask").updatedInput, toolInput);
    assert.deepEqual(claudeToolPermission("Bash", toolInput, undefined).updatedInput, toolInput);
    assert.deepEqual(claudeToolPermission("Bash", toolInput, "always").updatedInput, toolInput);
    // The value handed back is the same object, not a copy the tool would see as
    // a different input.
    assert.equal(claudeToolPermission("Bash", toolInput, "ask").updatedInput, toolInput);

    // A human handoff still wins: the box is paused for the human at the screen.
    const askDirectory = path.join(workspace, ".grokbot");
    await mkdir(askDirectory, { recursive: true });
    await writeFile(path.join(askDirectory, "ask-human.json"), "{}\n");
    const handBack = { command: "rm .grokbot/ask-human.json" };
    const duringHandoff = claudeToolPermission("Bash", handBack, "never");
    assert.equal(duringHandoff.behavior, "allow");
    assert.deepEqual(duringHandoff.updatedInput, handBack);
    const blocked = claudeToolPermission("Bash", toolInput, "never");
    assert.equal(blocked.behavior, "deny");
    assert.match(blocked.message, /awaiting a human handoff/);
  } finally {
    if (previousAdmin === undefined) delete process.env.SAND_LOCAL_ADMIN;
    else process.env.SAND_LOCAL_ADMIN = previousAdmin;
    if (previousWorkspace === undefined) delete process.env.SAND_WORKSPACE_ROOT;
    else process.env.SAND_WORKSPACE_ROOT = previousWorkspace;
    await rm(workspace, { recursive: true, force: true });
    await rm(buildRoot, { recursive: true, force: true });
  }
});
