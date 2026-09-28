import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const directory = process.argv[2];
if (!directory) throw new Error("An isolated test directory is required");
const controller = new AbortController();
let listCalls = 0;
let requests = 0;
const endpoint = createServer((_request, response) => { requests++; response.writeHead(401); response.end(); });
await new Promise(resolve => endpoint.listen(0, "127.0.0.1", resolve));
const deadline = setTimeout(() => controller.abort(new Error("SDK control cancellation timed out")), 15_000);
const mcp = new McpServer({ name: "control-cancel", version: "1" }, { capabilities: { tools: {} } });
mcp.server.setRequestHandler(ListToolsRequestSchema, async () => {
  listCalls++;
  controller.abort(new Error("Cancel while replying to SDK control request"));
  return { tools: [] };
});
try {
  const stream = query({ prompt: "Reply with one word.", options: {
    cwd: directory,
    tools: [],
    mcpServers: { control_cancel: { type: "sdk", name: "control_cancel", instance: mcp } },
    strictMcpConfig: true,
    settingSources: [],
    maxTurns: 1,
    persistSession: false,
    abortController: controller,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: path.join(directory, "claude-config"),
      ANTHROPIC_API_KEY: "local-protocol-test",
      ANTHROPIC_AUTH_TOKEN: "local-protocol-test",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${endpoint.address().port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
    },
  } });
  await assert.rejects(async () => { for await (const _message of stream) {} }, /abort|cancel/i);
  assert.ok(listCalls >= 1);
  assert.equal(controller.signal.reason?.message, "Cancel while replying to SDK control request");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(requests, 0);
  process.stdout.write(JSON.stringify({ canceled: true, listCalls, modelRequests: requests }) + "\n");
} finally {
  clearTimeout(deadline);
  controller.abort();
  await mcp.close();
  endpoint.closeAllConnections();
  await new Promise(resolve => endpoint.close(resolve));
}
