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
    assert.match(inBox, /host tools/i);
    assert.doesNotMatch(inBox, /launch the browser with|input via|screenshot with|osascript|display notification|You have real local tools \(Bash/);

    // 人工接管和本地身份在两种启动环境中保持一致。
    for (const prompt of [inBox, fromMac]) {
      assert.ok(prompt.includes("request_box_help"), "人工接管使用当前 host 工具");
      assert.ok(prompt.includes("you are the sandbox"), "the local self-image must survive the split");
    }

    // Without local admin there is no identity block at all.
    const plain = claudeLocalToolsPrompt({});
    assert.ok(!plain.includes("you are the sandbox"), "the local block must not leak outside local admin");
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
});

test("host 工具执行遵守 Never 和人工接管状态，原生工具始终拒绝", async () => {
  const { claudeToolPermission, buildRoot } = await loadPrimitiveLines();
  const previousAdmin = process.env.SAND_LOCAL_ADMIN;
  const previousWorkspace = process.env.SAND_WORKSPACE_ROOT;
  const previousDataRoot = process.env.SAND_DATA_ROOT;
  await mkdir(path.join(repositoryRoot, ".cache"), { recursive: true });
  const workspace = await mkdtemp(path.join(repositoryRoot, ".cache", "grok-permission-workspace-"));
  try {
    process.env.SAND_LOCAL_ADMIN = "1";
    process.env.SAND_WORKSPACE_ROOT = workspace;
    process.env.SAND_DATA_ROOT = workspace;

    for (const tool of ["Shell", "Write", "Edit", "Computer", "Browser", "Task", "CallMcpTool"]) {
      const decision = claudeToolPermission(`mcp__grok_bot_host_tools__${tool}`, { command: "touch x" }, "never");
      assert.equal(decision.behavior, "deny", `${tool} must be denied while the setting is Never`);
      assert.match(decision.message, /Never/);
    }
    for (const tool of ["Read", "ExternalRead", "Screenshot", "GetMcpTools"]) {
      assert.equal(claudeToolPermission(`mcp__grok_bot_host_tools__${tool}`, {}, "never").behavior, "allow", `${tool} must stay available`);
    }
    for (const permission of ["ask", "always", undefined]) {
      assert.equal(claudeToolPermission("mcp__grok_bot_host_tools__Shell", {}, permission).behavior, "allow");
    }
    const toolInput = Object.freeze({ text: "host-input", nested: Object.freeze({ keep: true }) });
    for (const permission of ["never", "ask", "always", undefined]) {
      assert.equal(claudeToolPermission("mcp__grok_bot_host_tools__Read", toolInput, permission).updatedInput, toolInput);
      for (const tool of ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "TodoWrite", "mcp__grok_bot_plugins__Read", "mcp__other__Read"]) {
        assert.equal(claudeToolPermission(tool, toolInput, permission).behavior, "deny", tool);
      }
    }
    for (const permission of ["ask", "always", undefined]) {
      assert.equal(claudeToolPermission("mcp__grok_bot_host_tools__Shell", toolInput, permission).updatedInput, toolInput);
    }

    // A human handoff still wins: the box is paused for the human at the screen.
    const askDirectory = path.join(workspace, ".grokbot");
    await mkdir(askDirectory, { recursive: true });
    await writeFile(path.join(askDirectory, "ask-human.json"), "{}\n");
    const handBack = { command: "rm .grokbot/ask-human.json" };
    const duringHandoff = claudeToolPermission("mcp__grok_bot_host_tools__Shell", handBack, "always");
    assert.equal(duringHandoff.behavior, "deny");
    const blocked = claudeToolPermission("mcp__grok_bot_host_tools__Shell", toolInput, "always");
    assert.equal(blocked.behavior, "deny");
    assert.match(blocked.message, /awaiting a human handoff/);
  } finally {
    if (previousAdmin === undefined) delete process.env.SAND_LOCAL_ADMIN;
    else process.env.SAND_LOCAL_ADMIN = previousAdmin;
    if (previousWorkspace === undefined) delete process.env.SAND_WORKSPACE_ROOT;
    else process.env.SAND_WORKSPACE_ROOT = previousWorkspace;
    if (previousDataRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousDataRoot;
    await rm(workspace, { recursive: true, force: true });
    await rm(buildRoot, { recursive: true, force: true });
  }
});
