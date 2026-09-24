import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

if (process.platform !== "linux" || !existsSync("/.dockerenv")) throw new Error("Provider tool transcript requires a Linux container");
const root = path.resolve(import.meta.dirname, "..");
const workspace = process.env.SAND_AGENT_WORKSPACE;
if (workspace == null || workspace.length === 0) throw new Error("SAND_AGENT_WORKSPACE is required");
await mkdir(workspace, { recursive: true });
await build({ entryPoints: [path.join(root, "source/host/extensions/inference/provider-session.ts"), path.join(root, "source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts"), path.join(root, "source/host/runner/conversation-outline.ts")], outdir: workspace, entryNames: ".provider-live-tool-[name]", outExtension: { ".js": ".mjs" }, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
const providerFile = path.join(workspace, ".provider-live-tool-provider-session.mjs");
const actualHandlerFile = path.join(workspace, ".provider-live-tool-abstract-user-message-action-handler.mjs");
const { createProviderPromptSession } = await import(providerFile);
const { containsPendingToolCall, projectClaudeExecutedToolSteps } = await import(actualHandlerFile);
const { getOutlineToolCallName, getOutlineToolCallStatus } = await import(path.join(workspace, ".provider-live-tool-conversation-outline.mjs"));
const events = [];
const abort = new AbortController();
const deadline = setTimeout(() => abort.abort(new Error("Provider tool transcript timed out")), 120_000);
try {
  const session = createProviderPromptSession("claude-code", { onToolEvent: event => events.push(event) });
  const executor = session.getExecutor([{ role: "user", content: "Use the grok_bot_host_tools Shell tool to run uname -s exactly once. Then answer with the exact operating system name it returns." }]);
  const result = executor.stream({ signal: abort.signal }, "provider-live-tool-transcript", [{ name: "Shell", description: "Run uname -s", inputSchema: { type: "object", properties: { command: { type: "string", enum: ["uname -s"] } }, required: ["command"] } }], {
    hostToolExecution: { execute: async call => {
      assert.equal(call.name, "Shell");
      assert.equal(call.args.command, "uname -s");
      const result = await promisify(execFile)("uname", ["-s"], { signal: call.signal });
      return { content: [{ type: "text", text: result.stdout }] };
    } },
  });
  let executableChunks = 0;
  for await (const event of result.fullStream) {
    if (event.type === "tool-call" || event.type === "tool-call-streaming-start") executableChunks += 1;
  }
  const response = await result.response;
  const content = response.messages.flatMap(message => message.content);
  const calls = content.filter(part => part.type === "tool-call" && part.toolName === "mcp__grok_bot_host_tools__Shell");
  const results = content.filter(part => part.type === "tool-result" && part.toolName === "mcp__grok_bot_host_tools__Shell");
  assert.equal(executableChunks, 0, "Claude tools must not enter the host execution stream");
  assert.equal(calls.length, 1, "Host Shell call is missing from the transcript");
  assert.equal(results.length, 1, "Host Shell result is missing from the transcript");
  assert.equal(results[0].toolCallId, calls[0].toolCallId);
  assert.ok(JSON.stringify(results[0].result).includes("Linux"));
  assert.deepEqual(events.map(event => event.status), ["pending", "done"]);
  assert.equal(events[0].id, calls[0].toolCallId);
  assert.equal(containsPendingToolCall(response.messages), false, "Completed Claude tools must not trigger another Agent model step");
  assert.equal(containsPendingToolCall(response.messages.map(({ providerOptions: _executed, ...message }) => message)), true, "Unmarked host tools must still trigger the Agent tool loop");
  const steps = projectClaudeExecutedToolSteps(response.messages);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].toolCallId, calls[0].toolCallId);
  assert.equal(getOutlineToolCallName(steps[0].toolCall), "mcp__grok_bot_host_tools__Shell");
  assert.equal(getOutlineToolCallStatus("toolCallCompleted", steps[0].toolCall), "done");
  process.stdout.write(JSON.stringify({ ok: true, calls: calls.length, results: results.length, eventStatuses: events.map(event => event.status) }) + "\n");
} finally {
  clearTimeout(deadline);
}
