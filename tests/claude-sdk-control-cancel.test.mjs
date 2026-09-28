import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
test("真实 Claude SDK 与 CLI 在 control request 回复期间取消，错误传播且进程正常退出", { timeout: 25_000 }, async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/sdk-control-cancel-"));
  try {
    const result = await promisify(execFile)(process.execPath, [path.join(root, "tests/fixtures/claude-sdk-control-cancel.mjs"), directory], {
      cwd: root, timeout: 20_000, env: { ...process.env, TMPDIR: directory },
    });
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.canceled, true);
    assert.ok(Number.isInteger(report.listCalls) && report.listCalls >= 1);
    assert.equal(report.modelRequests, 0);
    assert.equal(result.stderr.includes("UnhandledPromiseRejection"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
