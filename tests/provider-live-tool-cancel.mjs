import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

if (process.platform !== "linux" || !existsSync("/.dockerenv")) throw new Error("Provider tool cancellation requires a Linux container");
const root = path.resolve(import.meta.dirname, "..");
const workspace = process.env.SAND_AGENT_WORKSPACE;
if (workspace == null || workspace.length === 0) throw new Error("SAND_AGENT_WORKSPACE is required");
await mkdir(workspace, { recursive: true });
const outfile = path.join(workspace, ".provider-live-tool-cancel.mjs");
await build({ entryPoints: [path.join(root, "source/host/extensions/inference/provider-session.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
const { createProviderPromptSession } = await import(outfile);
const abort = new AbortController();
const events = [];
const deadline = setTimeout(() => abort.abort(new Error("Provider cancellation test timed out")), 120_000);
try {
  const session = createProviderPromptSession("claude-code", { onToolEvent: event => {
    events.push(event);
    if (event.status === "pending") setTimeout(() => abort.abort(new Error("Cancel real Bash call")), 500);
  } });
  const executor = session.getExecutor([{ role: "user", content: "Use Bash to run sleep 30, then reply done. Do not skip the Bash tool." }]);
  const result = executor.stream({ signal: abort.signal }, "provider-live-tool-cancel", []);
  const responseRejection = result.response.catch(error => error);
  await assert.rejects(async () => { for await (const _event of result.fullStream) {} }, /aborted|Abort|Cancel real Bash call/i);
  assert.ok(await responseRejection instanceof Error);
  assert.deepEqual(events.map(event => event.status), ["pending", "failed"]);
  assert.equal(events[0].id, events[1].id);
  process.stdout.write(JSON.stringify({ ok: true, eventStatuses: events.map(event => event.status) }) + "\n");
} finally {
  clearTimeout(deadline);
}
