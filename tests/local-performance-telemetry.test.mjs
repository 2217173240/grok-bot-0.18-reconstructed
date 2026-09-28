import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
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
  } finally {
    for (const [key, value] of Object.entries({ SAND_DATA_ROOT: previous.root, SAND_LOCAL_ADMIN: previous.admin, SAND_DISABLE_TELEMETRY: previous.disabled })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
