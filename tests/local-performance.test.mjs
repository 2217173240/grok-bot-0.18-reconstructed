import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "esbuild";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("local performance ledger and summary preserve absent metrics and cache components", async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const dataRoot = await mkdtemp(path.join(root, ".cache/local-performance-"));
  const bundle = path.join(dataRoot, "helper.mjs");
  await build({ entryPoints: [path.join(root, "source/shared/node/local-performance.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
  const helper = await import(bundle);
  const env = { SAND_DATA_ROOT: dataRoot, SAND_DISABLE_TELEMETRY: "1" };
  helper.appendLocalPerformance({ phase: "provider", provider: "claude-code", mode: "hosted", outcome: "success", durationMs: 12, firstTextMs: 4, inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 3, correlationHash: helper.localPerformanceCorrelationHash("one") }, env);
  helper.appendLocalPerformance({ phase: "provider", provider: "claude-code", mode: "hosted", outcome: "cancelled", durationMs: 8, correlationHash: helper.localPerformanceCorrelationHash("two") }, env);
  const ledger = path.join(dataRoot, "local-intercept.jsonl");
  const raw = await readFile(ledger, "utf8");
  assert.doesNotMatch(raw, /prompt|args|result|secret|key/i);
  const { stdout } = await exec(process.execPath, [path.join(root, "scripts/summarize-local-performance.mjs"), ledger]);
  const summary = JSON.parse(stdout);
  assert.equal(summary[0].totalInputTokens, 33);
  assert.equal(summary[1].usageRows, 0);
});

test("local performance helper rejects malformed records", async () => {
  const bundle = path.join(root, ".cache/local-performance-helper.mjs");
  await build({ entryPoints: [path.join(root, "source/shared/node/local-performance.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
  const helper = await import(bundle);
  assert.throws(() => helper.appendLocalPerformance({ phase: "provider", provider: "claude-code", mode: "hosted", outcome: "success", durationMs: -1, correlationHash: "bad" }, { SAND_DISABLE_TELEMETRY: "1", SAND_DATA_ROOT: path.join(root, ".cache") }));
});
