import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { jsonSchema } from "ai";

if (process.platform !== "linux" || !existsSync("/.dockerenv")) throw new Error("Live host tool parity requires an isolated Linux container");
const root = path.resolve(import.meta.dirname, "..");
const workspace = process.env.SAND_AGENT_WORKSPACE;
if (workspace == null || !workspace.startsWith("/repo/.cache/provider-live/workspace-host-parity-")) throw new Error("SAND_AGENT_WORKSPACE must be an isolated provider-live workspace");
if (!existsSync(path.join(process.env.SAND_DATA_ROOT ?? "", "anthropic-token"))) throw new Error("Mounted provider token file is unavailable");
await mkdir(workspace, { recursive: true });
await build({ entryPoints: [
  path.join(root, "source/host/extensions/inference/provider-session.ts"),
  path.join(root, "source/packages/agent/tool-stream-executor.ts"),
  path.join(root, "source/packages/context/core.ts"),
  path.join(root, "source/packages/proto/generated/agent/v1/agent_pb.ts"),
], outdir: workspace, entryNames: ".host-parity-[name]", outExtension: { ".js": ".mjs" }, bundle: true, format: "esm", platform: "node", target: "node22", packages: "external", logLevel: "silent" });
const { createProviderPromptSession } = await import(path.join(workspace, ".host-parity-provider-session.mjs"));
const { SimplePromptToolExecutor } = await import(path.join(workspace, ".host-parity-tool-stream-executor.mjs"));
const { createContext } = await import(path.join(workspace, ".host-parity-core.mjs"));
const { ToolCall } = await import(path.join(workspace, ".host-parity-agent_pb.mjs"));
const nonce = randomUUID();
const marker = path.join(workspace, `host-tool-${nonce}.txt`);
const toolName = "write_host_marker";
const calls = [];
const events = [];
const tool = {
  name: toolName,
  toolIdentifier: "WRITE",
  description: "Write one marker line to the isolated workspace. Use this tool exactly once when asked.",
  parameters: jsonSchema({ type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false }),
  async execute(ctx, _interactionHandler, argsStream, meta) {
    let raw = "";
    for await (const chunk of argsStream) raw += chunk;
    const args = JSON.parse(raw);
    assert.equal(args.marker, nonce);
    assert.equal(ctx.signal.aborted, false);
    calls.push(meta.toolCallId);
    await appendFile(marker, `${args.marker}\n`, { signal: ctx.signal });
    return new ToolCall();
  },
  async render() { return { content: [{ type: "text", text: `host marker written: ${nonce}` }], isError: false }; },
  serializeError(error) { throw error; },
};
const [ctx, cancel] = createContext().withTimeoutAndCancel(120_000);
try {
  const session = createProviderPromptSession("claude-code", { localToolPermission: "always", onToolEvent: event => events.push(event) });
  const executor = new SimplePromptToolExecutor(session.getExecutor([{ role: "user", content: `Call the grok_bot_host_tools ${toolName} tool exactly once with marker ${nonce}. Use that host MCP tool, not Bash or Write. Then report the tool's exact result.` }]));
  const result = executor.executeToolStream(ctx, undefined, { invocationId: `host-parity-${nonce}` }, [tool], {}, () => {}, undefined, undefined);
  let outerToolChunks = 0;
  for await (const event of result.fullStream) if (event.type === "tool-call" || event.type === "tool-call-streaming-start") outerToolChunks++;
  const response = await result.response;
  const content = response.messages.flatMap(message => message.content);
  const transcriptCalls = content.filter(part => part.type === "tool-call" && part.toolName === `mcp__grok_bot_host_tools__${toolName}`);
  const transcriptResults = content.filter(part => part.type === "tool-result" && part.toolName === `mcp__grok_bot_host_tools__${toolName}`);
  assert.equal(outerToolChunks, 0, "SDK-executed host tool entered the outer executor again");
  assert.equal(calls.length, 1, "Host executor did not run exactly once");
  assert.deepEqual(await readFile(marker, "utf8"), `${nonce}\n`);
  assert.equal(transcriptCalls.length, 1);
  assert.equal(transcriptResults.length, 1);
  assert.equal(transcriptResults[0].toolCallId, transcriptCalls[0].toolCallId);
  assert.ok(JSON.stringify(transcriptResults[0].result).includes(nonce));
  assert.deepEqual(events.map(event => event.status), ["pending", "done"]);
  process.stdout.write(JSON.stringify({ ok: true, hostExecutions: calls.length, transcriptCalls: transcriptCalls.length, transcriptResults: transcriptResults.length, outerToolChunks, markerLines: 1 }) + "\n");
} finally {
  cancel();
}
