import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

test("structured telemetry mapper writes only measured local phases", async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const dataRoot = await mkdtemp(path.join(root, ".cache/local-performance-telemetry-"));
  const bundle = path.join(dataRoot, "telemetry.mjs");
  await build({ stdin: { contents: 'export { SandStructuredLogTelemetry } from "./source/host/extensions/telemetry/structured-log-telemetry.ts";', resolveDir: root, loader: "ts" }, outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
  const previous = { root: process.env.SAND_DATA_ROOT, admin: process.env.SAND_LOCAL_ADMIN, disabled: process.env.SAND_DISABLE_TELEMETRY };
  process.env.SAND_DATA_ROOT = dataRoot;
  process.env.SAND_LOCAL_ADMIN = "1";
  process.env.SAND_DISABLE_TELEMETRY = "1";
  try {
    const { SandStructuredLogTelemetry } = await import(bundle);
    const telemetry = new SandStructuredLogTelemetry({});
    telemetry.reportQueueDequeued({ conversationId: "conversation-secret", queueWaitMs: 12, acceptedToRunMs: 22 });
    telemetry.reportSendDispatch({ conversationId: "conversation-secret", dispatchMs: 8 });
    telemetry.reportTtft({ conversationId: "conversation-secret", ttftMs: 15, skew: "none" });
    telemetry.reportAckObligation({ conversationId: "conversation-secret", outcome: "delivered", timeToFirstVisibleAckMs: 20 });
    telemetry.reportAutoReviewApproval({ eventType: "approved", conversationId: "conversation-secret", approvalId: "approval-secret", surface: "computer", status: "approved", ageMs: 31 });
    const ledger = await readFile(path.join(dataRoot, "local-intercept.jsonl"), "utf8");
    assert.match(ledger, /"phase":"queue"/);
    assert.match(ledger, /"phase":"dispatch"/);
    assert.match(ledger, /"phase":"ttft"/);
    assert.match(ledger, /"phase":"delivery"/);
    assert.match(ledger, /"phase":"approval"/);
    assert.doesNotMatch(ledger, /conversation-secret|approval-secret|computer/);
    await telemetry.dispose();
  } finally {
    for (const [key, value] of Object.entries({ SAND_DATA_ROOT: previous.root, SAND_LOCAL_ADMIN: previous.admin, SAND_DISABLE_TELEMETRY: previous.disabled })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("missing or invalid mapper durations and disabled local mode do not write records", async () => {
  const dataRoot = await mkdtemp(path.join(root, ".cache/local-performance-invalid-"));
  const previous = { root: process.env.SAND_DATA_ROOT, admin: process.env.SAND_LOCAL_ADMIN, disabled: process.env.SAND_DISABLE_TELEMETRY };
  process.env.SAND_DATA_ROOT = dataRoot; process.env.SAND_LOCAL_ADMIN = "1"; process.env.SAND_DISABLE_TELEMETRY = "1";
  try {
    const bundle = path.join(dataRoot, "telemetry.mjs");
    await build({ stdin: { contents: 'export { SandStructuredLogTelemetry } from "./source/host/extensions/telemetry/structured-log-telemetry.ts";', resolveDir: root, loader: "ts" }, outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
    const { SandStructuredLogTelemetry } = await import(bundle);
    const telemetry = new SandStructuredLogTelemetry({});
    telemetry.reportTtft({ conversationId: "invalid", ttftMs: Number.NaN, skew: "none" });
    telemetry.reportTtft({ conversationId: "invalid", ttftMs: -1, skew: "none" });
    telemetry.reportQueueDequeued({ conversationId: "invalid", queueWaitMs: null });
    for (const duration of [undefined, NaN, -1, null]) {
      telemetry.reportAutoReviewApproval({ status: "pending", ageMs: duration });
      telemetry.reportSendDispatch({ dispatchMs: duration });
      telemetry.reportAckObligation({ timeToFirstVisibleAckMs: duration });
    }
    await assert.rejects(readFile(path.join(dataRoot, "local-intercept.jsonl")), { code: "ENOENT" });
    process.env.SAND_DISABLE_TELEMETRY = "0";
    telemetry.reportTtft({ conversationId: "disabled", ttftMs: 4, skew: "none" });
    await assert.rejects(readFile(path.join(dataRoot, "local-intercept.jsonl")), { code: "ENOENT" });
    const notDir = path.join(dataRoot, "not-a-directory");
    await writeFile(notDir, "x");
    process.env.SAND_DATA_ROOT = notDir;
    process.env.SAND_DISABLE_TELEMETRY = "1";
    assert.doesNotThrow(() => telemetry.reportTtft({ conversationId: "enotdir", ttftMs: 4, skew: "none" }));
    await telemetry.dispose();
  } finally {
    for (const [key, value] of Object.entries({ SAND_DATA_ROOT: previous.root, SAND_LOCAL_ADMIN: previous.admin, SAND_DISABLE_TELEMETRY: previous.disabled })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("ForwardingInteractionListener records only paired completed tools", async () => {
  const dataRoot = await mkdtemp(path.join(root, ".cache/local-performance-listener-"));
  const bundle = path.join(dataRoot, "agent-adapters.mjs");
  await build({ entryPoints: [path.join(root, "source/host/runner/agent-adapters.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
  const previous = { root: process.env.SAND_DATA_ROOT, admin: process.env.SAND_LOCAL_ADMIN, disabled: process.env.SAND_DISABLE_TELEMETRY };
  process.env.SAND_DATA_ROOT = dataRoot; process.env.SAND_LOCAL_ADMIN = "1"; process.env.SAND_DISABLE_TELEMETRY = "1";
  try {
    const { ForwardingInteractionListener } = await import(bundle);
    const listener = new ForwardingInteractionListener(() => {});
    const toolCall = { tool: { case: "mcpToolCall", value: { args: { providerIdentifier: "test" } } } };
    await listener.sendUpdate({}, { message: { case: "toolCallStarted", value: { callId: "call-1", toolCall } } });
    await listener.sendUpdate({}, { message: { case: "partialToolCall", value: { callId: "call-1", toolCall } } });
    await listener.sendUpdate({}, { message: { case: "toolCallCompleted", value: { callId: "call-1", toolCall } } });
    await listener.sendUpdate({}, { message: { case: "toolCallCompleted", value: { callId: "unpaired", toolCall } } });
    await listener.sendUpdate({}, { message: { case: "toolCallStarted", value: { callId: "unfinished", toolCall } } });
    await listener.sendUpdate({}, { message: { case: "turnEnded", value: {} } });
    await listener.sendUpdate({}, { message: { case: "toolCallCompleted", value: { callId: "unfinished", toolCall } } });
    const failed = { tool: { case: "mcpToolCall", value: { args: { providerIdentifier: "claude-code" }, result: { result: { case: "error", value: { error: "secret-error" } } } } } };
    await listener.sendUpdate({}, { message: { case: "toolCallStarted", value: { callId: "failed", toolCall: failed } } });
    await listener.sendUpdate({}, { message: { case: "toolCallCompleted", value: { callId: "failed", toolCall: failed } } });
    const ledger = await readFile(path.join(dataRoot, "local-intercept.jsonl"), "utf8");
    const rows = ledger.trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.map(row => row.outcome), ["success", "failed"]);
    assert.doesNotMatch(ledger, /call-1|providerIdentifier|test|secret-error/);
  } finally {
    for (const [key, value] of Object.entries({ SAND_DATA_ROOT: previous.root, SAND_LOCAL_ADMIN: previous.admin, SAND_DISABLE_TELEMETRY: previous.disabled })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("SandTurnTelemetryImpl finalization records one local turn duration", async () => {
  const dataRoot = await mkdtemp(path.join(root, ".cache/local-performance-turn-"));
  const bundle = path.join(dataRoot, "telemetry.mjs");
  await build({ stdin: { contents: 'export { SandStructuredLogTelemetry } from "./source/host/extensions/telemetry/structured-log-telemetry.ts";', resolveDir: root, loader: "ts" }, outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
  const previous = { root: process.env.SAND_DATA_ROOT, admin: process.env.SAND_LOCAL_ADMIN, disabled: process.env.SAND_DISABLE_TELEMETRY };
  process.env.SAND_DATA_ROOT = dataRoot; process.env.SAND_LOCAL_ADMIN = "1"; process.env.SAND_DISABLE_TELEMETRY = "1";
  try {
    const { SandStructuredLogTelemetry } = await import(bundle);
    const telemetry = new SandStructuredLogTelemetry({});
    const turn = telemetry.startTurn({ conversationId: "turn-secret", turnType: "user" });
    turn.finalize("success"); turn.finalize("error", undefined, { message: "secret-error-detail" });
    const cancelled = telemetry.startTurn({ conversationId: "cancel-secret", turnType: "user" });
    cancelled.finalize("cancelled");
    const failed = telemetry.startTurn({ conversationId: "failed-secret", turnType: "user" });
    failed.finalize("error", undefined, { message: "secret-error-detail" });
    const ledger = await readFile(path.join(dataRoot, "local-intercept.jsonl"), "utf8");
    assert.deepEqual(ledger.trim().split("\n").map(JSON.parse).map(row => row.outcome), ["success", "cancelled", "failed"]);
    assert.doesNotMatch(ledger, /turn-secret|cancel-secret|failed-secret|secret-error-detail/);
    await telemetry.dispose();
  } finally {
    for (const [key, value] of Object.entries({ SAND_DATA_ROOT: previous.root, SAND_LOCAL_ADMIN: previous.admin, SAND_DISABLE_TELEMETRY: previous.disabled })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dataRoot, { recursive: true, force: true });
  }
});
