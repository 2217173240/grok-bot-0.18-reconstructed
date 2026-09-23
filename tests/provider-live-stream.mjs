import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

if (process.platform !== "linux" || !existsSync("/.dockerenv")) throw new Error("Provider live stream requires a Linux container");
const root = path.resolve(import.meta.dirname, "..");
const workspace = process.env.SAND_AGENT_WORKSPACE;
if (workspace == null || workspace.length === 0) throw new Error("SAND_AGENT_WORKSPACE is required");
await mkdir(workspace, { recursive: true });
const outfile = path.join(workspace, ".provider-live-stream.mjs");
await build({ entryPoints: [path.join(root, "source/host/extensions/inference/provider-session.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
const { createProviderPromptSession } = await import(outfile);
const abort = new AbortController();
const deadline = setTimeout(() => abort.abort(new Error("Provider live stream timed out")), 120_000);
try {
  const executor = createProviderPromptSession("claude-code").getExecutor([{ role: "user", content: "Reply with one short sentence about Linux. Do not use tools." }]);
  const result = executor.stream({ signal: abort.signal }, "provider-live-stream", []);
  let chunks = 0;
  let streamed = "";
  for await (const event of result.fullStream) {
    if (event.type === "text-delta") {
      chunks += 1;
      streamed += event.textDelta;
    }
  }
  const response = await result.response;
  assert.ok(chunks > 0, "Claude emitted no text delta");
  assert.equal(response.messages[0].content[0].text, streamed);
  process.stdout.write(JSON.stringify({ ok: true, chunks, characters: streamed.length }) + "\n");
} finally {
  clearTimeout(deadline);
}
