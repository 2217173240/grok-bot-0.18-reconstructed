import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".cache/approval-outcome-"));
const outfile = path.join(directory, "controller.mjs");
await build({ entryPoints: [path.join(root, "source/host/runner/sand-auto-review.ts")], outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
const { SandAutoReviewController } = await import(pathToFileURL(outfile).href);
test.after(() => rm(directory, { recursive: true, force: true }));

for (const outcome of ["approved", "denied", "ttl", "cancelled", "user_redirect", "settings_change", "session_end", "quiesce"]) {
  test(`审批 controller 明确返回 ${outcome} 的事件和最终结果`, async () => {
    const controller = new SandAutoReviewController({ agentId: "outcome-agent", hostGeneration: "outcome-host", approvalTtlMs: 20 });
    const abort = new AbortController();
    const events = [];
    const unsubscribe = controller.subscribe(event => events.push(event));
    const pending = controller.requestApproval({ surface: "box_shell", fingerprint: "reviewed-command", reason: "Ask before writing the report", summary: "Write report", signal: abort.signal, expiryPolicy: outcome === "ttl" ? "ttl" : "park" });
    const card = controller.getPendingApprovals()[0];
    assert.equal(events[0].type, "created");
    assert.equal(events[0].approval.id, card.id);
    assert.equal(getEventListeners(abort.signal, "abort").length, 1);
    let deadline;
    try {
      if (outcome === "approved" || outcome === "denied") controller.resolveApproval(card.id, outcome);
      else if (outcome === "cancelled") abort.abort();
      else if (outcome === "user_redirect") controller.beginUserMessageEpoch();
      else if (outcome === "settings_change") controller.expireSurfaces(new Set(["box_shell"]));
      else if (outcome === "quiesce") controller.expireForQuiesce();
      else if (outcome === "session_end") controller.expire("session_end");
      const result = await Promise.race([pending, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Approval did not settle")), 1000); })]);
      assert.equal(result.approved, outcome === "approved");
      if (outcome === "denied") {
        assert.match(result.reason, /^The user denied approval for this action\./);
        assert.match(result.reason, /do not retry automatically or change permissions/);
      } else if (outcome !== "approved") {
        const expected = { ttl: /expired before a decision/, cancelled: /was cancelled/, user_redirect: /new user message invalidated/, settings_change: /settings invalidated/, session_end: /session ended/, quiesce: /host update interrupted/ };
        assert.match(result.reason, expected[outcome]);
        assert.doesNotMatch(result.reason, /user denied|Auto-review blocked|retry the action/);
      }
      if (outcome !== "approved") {
        assert.match(result.reason, /wait for new user direction/);
        assert.match(result.reason, /Ask before writing the report/);
        assert.doesNotMatch(result.reason, /anonymous|pastebin|courier/);
      }
      assert.equal(events.length, 2);
      assert.equal(events[1].type, outcome === "approved" || outcome === "denied" ? "resolved" : "expired");
      assert.equal(events[1].approval.status, outcome === "approved" || outcome === "denied" ? outcome : "expired");
      if (events[1].type === "expired") assert.equal(events[1].cause, outcome);
      assert.equal(controller.getPendingApprovals().length, 0);
      assert.equal(getEventListeners(abort.signal, "abort").length, 0);
      assert.equal(controller.resolveApproval(card.id, "approved"), undefined);
    } finally {
      clearTimeout(deadline);
      unsubscribe();
      controller.expire("session_end");
    }
  });
}

test("已取消的审批请求不创建卡片", async () => {
  const controller = new SandAutoReviewController({ agentId: "outcome-agent", hostGeneration: "outcome-host" });
  const abort = new AbortController();
  abort.abort();
  const events = [];
  controller.subscribe(event => events.push(event));
  const result = await controller.requestApproval({ surface: "box_shell", fingerprint: "cancelled-command", reason: "Ask first", summary: "Write report", signal: abort.signal });
  assert.equal(result.approved, false);
  assert.match(result.reason, /request was cancelled/);
  assert.doesNotMatch(result.reason, /user denied/);
  assert.deepEqual(events, []);
  assert.deepEqual(controller.getPendingApprovals(), []);
});
