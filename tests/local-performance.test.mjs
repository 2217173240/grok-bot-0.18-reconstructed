import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".cache/local-performance-"));
const bundle = path.join(directory, "helper.mjs");
await build({ entryPoints: [path.join(root, "source/shared/node/local-performance.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
const { appendLocalPerformance, localPerformanceCorrelationHash } = await import(pathToFileURL(bundle).href);
const execute = promisify(execFile);
const script = path.join(root, "scripts/summarize-local-performance.mjs");
const record = { phase: "provider", provider: "claude-code", mode: "hosted", outcome: "success", durationMs: 12, correlationHash: localPerformanceCorrelationHash("test-request") };
const localEnv = dir => ({ SAND_DATA_ROOT: dir, SAND_LOCAL_ADMIN: "1", SAND_DISABLE_TELEMETRY: "1" });
test.after(() => rm(directory, { recursive: true, force: true }));

test("本地性能白名单保留零与缺失值，真实文件权限为 0600", async () => {
  const dir = await mkdtemp(path.join(directory, "ledger-"));
  const sentinel = randomUUID();
  const env = localEnv(dir);
  appendLocalPerformance({ ...record, usageBasis: "exclusive-input", firstTextMs: 4, inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 3, prompt: sentinel, args: { token: sentinel }, result: sentinel, extra: sentinel }, env);
  appendLocalPerformance({ ...record, durationMs: 24, firstTextMs: 0, usageBasis: "exclusive-input", inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, env);
  appendLocalPerformance({ ...record, durationMs: 8, outcome: "cancelled" }, env);
  const ledger = path.join(dir, "local-intercept.jsonl");
  const raw = await readFile(ledger, "utf8");
  assert.equal(raw.includes(sentinel), false);
  assert.equal((await stat(ledger)).mode & 0o777, 0o600);
  const rows = raw.trim().split("\n").map(JSON.parse);
  assert.equal(rows[1].firstTextMs, 0);
  assert.equal("firstTextMs" in rows[2], false);
  assert.equal("inputTokens" in rows[2], false);
  const { stdout } = await execute(process.execPath, [script, ledger]);
  const summary = JSON.parse(stdout);
  const success = summary.groups.find(group => group.outcome === "success");
  assert.equal(summary.records, 3);
  assert.deepEqual(success.timings.durationMs, { count: 2, p50Ms: 12, p95Ms: 24 });
  assert.deepEqual(success.timings.firstTextMs, { count: 2, p50Ms: 0, p95Ms: 4 });
  assert.equal(success.usage.totalInput.total, 33);
  assert.equal(success.usage.cacheRead.numerator, 20);
  assert.equal(success.usage.cacheRead.denominator, 33);
  assert.equal(success.usage.cacheRead.ratio, 20 / 33);
  const cancelled = summary.groups.find(group => group.outcome === "cancelled");
  assert.deepEqual(cancelled.timings.firstTextMs, { count: 0, p50Ms: null, p95Ms: null });
  assert.equal(cancelled.usage.rows, 0);
  assert.equal(cancelled.counts.inputTokens.total, null);
  assert.equal(cancelled.usage.totalInput.total, null);
});

test("性能记录仅在 local admin 且远传关闭时写入，非法分类与数字被拒绝", async () => {
  const dir = await mkdtemp(path.join(directory, "gate-"));
  appendLocalPerformance(record, { ...localEnv(dir), SAND_LOCAL_ADMIN: "0" });
  appendLocalPerformance(record, { ...localEnv(dir), SAND_DISABLE_TELEMETRY: "0" });
  await assert.rejects(readFile(path.join(dir, "local-intercept.jsonl")), { code: "ENOENT" });
  for (const patch of [{ provider: "private-provider-value" }, { durationMs: -1 }, { firstTextMs: NaN }, { inputTokens: 1.5 }, { mode: "invalid" }, { correlationHash: "invalid" }]) {
    assert.throws(() => appendLocalPerformance({ ...record, ...patch }, localEnv(dir)), { message: "Invalid local performance record." });
  }
});

test("汇总分别处理 inclusive 与 exclusive token，并对不完整 usage 保持未知", async () => {
  const dir = await mkdtemp(path.join(directory, "usage-"));
  appendLocalPerformance({ ...record, provider: "codex", usageBasis: "inclusive-input", inputTokens: 100, cacheReadTokens: 25 }, localEnv(dir));
  appendLocalPerformance({ ...record, usageBasis: "exclusive-input", inputTokens: 10, cacheReadTokens: 20 }, localEnv(dir));
  appendLocalPerformance({ phase: "queue", outcome: "observed", durationMs: 3 }, localEnv(dir));
  const { stdout } = await execute(process.execPath, [script, path.join(dir, "local-intercept.jsonl")]);
  const groups = JSON.parse(stdout).groups;
  const codex = groups.find(group => group.provider === "codex");
  assert.equal(codex.usage.totalInput.total, 100);
  assert.equal(codex.usage.cacheRead.ratio, 0.25);
  assert.equal(codex.counts.cacheWriteTokens.total, null);
  const partial = groups.find(group => group.provider === "claude-code");
  assert.equal(partial.usage.rows, 1);
  assert.equal(partial.usage.totalInput.total, null);
  assert.equal(partial.usage.cacheRead.ratio, null);
  assert.equal(groups.find(group => group.phase === "queue").provider, null);
});

test("汇总拒绝损坏的已知记录且不输出敏感原文", async () => {
  const dir = await mkdtemp(path.join(directory, "invalid-"));
  appendLocalPerformance(record, localEnv(dir));
  const valid = JSON.parse((await readFile(path.join(dir, "local-intercept.jsonl"), "utf8")).trim());
  const sentinel = randomUUID();
  const input = path.join(dir, "input.jsonl");
  for (const value of [{ ...valid, provider: sentinel }, { ...valid, durationMs: -1 }, { ...valid, schemaVersion: 2 }, { ...valid, secret: sentinel }, { ...valid, inputTokens: 1.5 }]) {
    await writeFile(input, JSON.stringify(value) + "\n");
    await assert.rejects(execute(process.execPath, [script, input]), error => {
      assert.equal(error.stdout.includes(sentinel), false);
      assert.equal(error.stderr.includes(sentinel), false);
      assert.match(error.stderr, /Invalid local-performance record/);
      return true;
    });
  }
  await writeFile(input, `{"secret":"${sentinel}`);
  await assert.rejects(execute(process.execPath, [script, input]), error => {
    assert.equal(error.stderr.includes(sentinel), false);
    assert.match(error.stderr, /Invalid JSON in input 1, line 1/);
    return true;
  });
  await writeFile(input, JSON.stringify({ kind: "unrelated", secret: sentinel }) + "\n");
  const { stdout } = await execute(process.execPath, [script, input]);
  assert.equal(stdout.includes(sentinel), false);
  assert.deepEqual(JSON.parse(stdout).groups, []);
});
