import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Value } from "@bufbuild/protobuf";
import { build } from "esbuild";

if (process.platform !== "linux" || !existsSync("/.dockerenv")) throw new Error("Provider MCP transcript requires a Linux container");
const root = path.resolve(import.meta.dirname, "..");
const workspace = process.env.SAND_AGENT_WORKSPACE;
if (workspace == null || workspace.length === 0) throw new Error("SAND_AGENT_WORKSPACE is required");
await mkdir(workspace, { recursive: true });
await build({ entryPoints: [path.join(root, "source/host/extensions/inference/provider-session.ts"), path.join(root, "source/box-exec-daemon/mcp-host.ts"), path.join(root, "source/packages/agent/actions/user-message-action/abstract-user-message-action-handler.ts"), path.join(root, "source/host/runner/conversation-outline.ts")], outdir: workspace, entryNames: ".provider-live-mcp-[name]", outExtension: { ".js": ".mjs" }, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
const { createProviderPromptSession } = await import(path.join(workspace, ".provider-live-mcp-provider-session.mjs"));
const { BoxMcpHost } = await import(path.join(workspace, ".provider-live-mcp-mcp-host.mjs"));
const { containsPendingToolCall, projectClaudeExecutedToolSteps } = await import(path.join(workspace, ".provider-live-mcp-abstract-user-message-action-handler.mjs"));
const { getOutlineToolCallName, getOutlineToolCallStatus } = await import(path.join(workspace, ".provider-live-mcp-conversation-outline.mjs"));
const host = new BoxMcpHost({ workspaceRoot: workspace, log: () => {} });
const abort = new AbortController();
const deadline = setTimeout(() => abort.abort(new Error("Provider MCP transcript timed out")), 120_000);
const events = [];
const invocations = [];
try {
  await host.load(JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [path.join(root, "tests/fixtures/mcp-echo-server.mjs")], cwd: workspace } } }));
  const state = await host.listState({ serverIdentifiers: ["echo"] });
  const tools = state.result.value.servers.flatMap(server => server.tools).map(tool => ({ name: tool.name, providerIdentifier: tool.providerIdentifier, toolName: tool.toolName, description: tool.description, inputSchema: tool.inputSchema?.toJson() }));
  const mcp = { listTools: async () => tools, callTool: async args => {
    invocations.push(args.toolCallId);
    const encoded = Object.fromEntries(Object.entries(args.args).map(([key, value]) => [key, Value.fromJson(value)]));
    return host.callTool({ name: args.toolName, providerIdentifier: args.providerIdentifier, toolName: args.name, toolCallId: args.toolCallId, args: encoded });
  } };
  const nonce = randomUUID();
  const executor = createProviderPromptSession("claude-code", { mcp, onToolEvent: event => events.push(event) }).getExecutor([{ role: "user", content: `Call the echo__echo MCP tool exactly once with text ${nonce}. Report its exact result.` }]);
  const result = executor.stream({ signal: abort.signal }, "provider-live-mcp-transcript", []);
  let executableChunks = 0;
  for await (const event of result.fullStream) if (event.type === "tool-call" || event.type === "tool-call-streaming-start") executableChunks += 1;
  const response = await result.response;
  const content = response.messages.flatMap(message => message.content);
  const calls = content.filter(part => part.type === "tool-call" && part.toolName.includes("echo"));
  const results = content.filter(part => part.type === "tool-result" && part.toolName.includes("echo"));
  assert.equal(executableChunks, 0);
  assert.equal(invocations.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].toolCallId, calls[0].toolCallId);
  assert.ok(JSON.stringify(results[0].result).includes(nonce));
  assert.deepEqual(events.map(event => event.status), ["pending", "done"]);
  assert.equal(containsPendingToolCall(response.messages), false);
  const steps = projectClaudeExecutedToolSteps(response.messages);
  assert.equal(steps.length, 1);
  assert.equal(getOutlineToolCallName(steps[0].toolCall), calls[0].toolName);
  assert.equal(getOutlineToolCallStatus("toolCallCompleted", steps[0].toolCall), "done");
  process.stdout.write(JSON.stringify({ ok: true, mcpInvocations: invocations.length, calls: calls.length, results: results.length, pendingContinuation: false }) + "\n");
} finally {
  clearTimeout(deadline);
  await host.dispose();
}
