import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const [directory, scenario] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, "../..");
const output = path.join(directory, "provider.mjs");
await build({ entryPoints: [path.join(root, "source/host/extensions/inference/provider-session.ts")], outfile: output, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
const { createProviderPromptSession } = await import(output);
const controller = new AbortController();
let toolCalls = 0;
let requests = 0;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!req.url.includes("/messages")) { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
  requests++;
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (scenario === "cancel") { controller.abort(); return; }
  if (scenario === "failed") { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "private-error-sentinel" } })); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const sawResult = body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "tool_result"));
  const tool = scenario === "tool" && !sawResult;
  send({ type: "message_start", message: { id: `message-${requests}`, type: "message", role: "assistant", content: [], model: "local-performance", stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } });
  if (tool) {
    send({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "read-file", name: "mcp__grok_bot_host_tools__Read", input: {} } });
    send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
  } else {
    send({ type: "content_block_start", index: 0, content_block: { type: "text", text: scenario === "final-only" ? "private-final-sentinel" : "" } });
    if (!["empty", "final-only"].includes(scenario)) send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "private-output-sentinel" } });
  }
  if (scenario === "return") return;
  send({ type: "content_block_stop", index: 0 });
  send({ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
  send({ type: "message_stop" });
  res.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  ANTHROPIC_AUTH_TOKEN: "local-http-test", ANTHROPIC_API_KEY: "local-http-test",
  SAND_LOCAL_ADMIN: "1", SAND_DISABLE_TELEMETRY: "1", SAND_DATA_ROOT: directory,
  SAND_AGENT_WORKSPACE: directory, CLAUDE_CONFIG_DIR: path.join(directory, "claude"),
  CLAUDE_CODE_PATH: path.join(root, "node_modules/@anthropic-ai/claude-agent-sdk/cli.js"),
  SAND_CLAUDE_MODEL: "local-performance", ANTHROPIC_MODEL: "local-performance",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "local-performance", ANTHROPIC_DEFAULT_SONNET_MODEL: "local-performance", ANTHROPIC_DEFAULT_OPUS_MODEL: "local-performance",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
});
const file = path.join(directory, "tool-result.txt");
await writeFile(file, "private-tool-result-sentinel");
const deadline = setTimeout(() => controller.abort(new Error("Local SDK request exceeded its deadline")), 18000);
try {
  if (scenario === "pre-cancel") controller.abort();
  const session = createProviderPromptSession("claude-code", scenario === "tool" ? {} : { textOnlyInstructions: "Read this local protocol response." });
  const executor = session.getExecutor([{ role: "user", content: "private-prompt-sentinel" }]);
  const result = executor.stream({ signal: controller.signal }, `claude-${scenario}`, scenario === "tool" ? [{ name: "Read", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] : undefined,
    scenario === "tool" ? { hostToolExecution: { execute: async () => { toolCalls++; return { content: [{ type: "text", text: await readFile(file, "utf8") }], isError: false }; } } } : undefined);
  const consume = async () => { for await (const _event of result.fullStream) {} };
  if (["cancel", "pre-cancel", "failed"].includes(scenario)) await assert.rejects(consume());
  else if (scenario === "return") { await result.fullStream.next(); await result.fullStream.return(); }
  else await consume();
  const rows = (await readFile(path.join(directory, "local-intercept.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const metrics = rows.filter(row => row.kind === "local-performance");
  const provider = metrics.filter(row => row.phase === "provider");
  assert.equal(provider.length, 1);
  process.stdout.write(JSON.stringify({ provider: provider[0], tools: metrics.filter(row => row.phase === "tool-bridge"), requests, toolCalls, processStarted: rows.some(row => row.kind === "provider-process" && row.phase === "started"), processClosed: rows.some(row => row.kind === "provider-process" && row.phase === "closed") }));
} finally { clearTimeout(deadline); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
