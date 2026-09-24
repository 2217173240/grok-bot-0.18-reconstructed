import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
    if (event.status === "pending") setTimeout(() => abort.abort(new Error("Cancel host Shell call")), 500);
  } });
  const executor = session.getExecutor([{ role: "user", content: "Use grok_bot_host_tools Shell to run sleep 30, then reply done. The tool call is required." }]);
  const result = executor.stream({ signal: abort.signal }, "provider-live-tool-cancel", [{ name: "Shell", description: "Run sleep 30", inputSchema: { type: "object", properties: { command: { type: "string", enum: ["sleep 30"] } }, required: ["command"] } }], {
    hostToolExecution: { execute: async call => {
      assert.equal(call.name, "Shell");
      assert.equal(call.args.command, "sleep 30");
      const output = await promisify(execFile)("sleep", ["30"], { signal: call.signal });
      return { content: [{ type: "text", text: output.stdout }] };
    } },
  });
  const responseRejection = result.response.catch(error => error);
  await assert.rejects(async () => { for await (const _event of result.fullStream) {} }, /aborted|Abort|Cancel host Shell call/i);
  assert.ok(await responseRejection instanceof Error);
  assert.deepEqual(events.map(event => event.status), ["pending", "failed"]);
  assert.equal(events[0].id, events[1].id);
  process.stdout.write(JSON.stringify({ ok: true, eventStatuses: events.map(event => event.status) }) + "\n");
} finally {
  clearTimeout(deadline);
}
