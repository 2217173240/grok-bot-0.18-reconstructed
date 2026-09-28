import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
for (const scenario of ["success", "final-only", "failed", "cancel", "pre-cancel", "return", "tool"]) {
  test(`真实 Claude SDK ${scenario} 测量与进程清理`, { timeout: 30000 }, async () => {
    await mkdir(path.join(root, ".cache"), { recursive: true });
    const directory = await mkdtemp(path.join(root, ".cache/claude-performance-"));
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "tests/fixtures/claude-provider-performance.mjs"), directory, scenario], { cwd: root, timeout: 25000, env: { ...process.env, TMPDIR: directory } });
      const result = JSON.parse(stdout);
      const row = result.provider;
      assert.equal(row.outcome, ["return", "cancel", "pre-cancel"].includes(scenario) ? "cancelled" : scenario === "failed" ? "failed" : "success");
      if (scenario === "pre-cancel") { assert.equal(result.processStarted, false); assert.equal(row.spawnMs, undefined); assert.equal(result.requests, 0); }
      else { assert.ok(result.processStarted && result.processClosed); assert.ok(row.spawnMs >= row.dispatchMs); }
      assert.ok(row.cleanupMs >= row.processCloseMs);
      assert.ok(row.durationMs >= row.cleanupMs);
      if (["cancel", "pre-cancel", "failed"].includes(scenario)) { assert.equal(row.firstTextMs, undefined); assert.equal(row.firstOutputMs, undefined); assert.equal(row.inputTokens, undefined); }
      if (["success", "final-only", "tool"].includes(scenario)) { assert.ok(row.firstTextMs >= row.firstOutputMs); assert.equal(row.usageBasis, "exclusive-input"); }
      if (["cancel", "return", "pre-cancel"].includes(scenario)) assert.ok(row.cancelCleanupMs >= row.cleanupMs);
      if (scenario === "tool") { assert.equal(result.toolCalls, 1); assert.equal(result.tools.length, 1); assert.equal(result.tools[0].outcome, "success"); assert.ok(row.bridgeCloseMs >= 0); }
      assert.ok(!JSON.stringify(row).includes("private-"));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
