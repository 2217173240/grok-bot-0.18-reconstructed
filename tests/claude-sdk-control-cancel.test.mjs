import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
for (const controlDelayMs of [0, 300]) test(`真实 Claude SDK 在 control request 延迟 ${controlDelayMs}ms 回复期间取消并释放进程与连接`, { timeout: 25_000 }, async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/sdk-control-cancel-"));
  try {
    const result = await promisify(execFile)(process.execPath, [path.join(root, "tests/fixtures/claude-sdk-control-cancel.mjs"), directory, String(controlDelayMs)], {
      cwd: root, timeout: 20_000, env: { ...process.env, TMPDIR: directory },
    });
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.canceled, true);
    assert.ok(Number.isInteger(report.listCalls) && report.listCalls >= 1);
    assert.equal(report.controlDelayMs, controlDelayMs);
    assert.ok(report.child.pid > 0);
    assert.ok(report.child.code !== null || report.child.signal !== null);
    assert.equal(report.openSockets, 0);
    assert.equal(report.activeResponses, 0);
    assert.deepEqual(report.unhandled, []);
    assert.equal(report.childUnhandled, false);
    for (const request of report.requests) {
      assert.ok(request.atMs <= request.closedAtMs);
    }
    assert.equal(result.stderr.includes("UnhandledPromiseRejection"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
