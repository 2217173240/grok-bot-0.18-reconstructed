import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const directory = process.argv[2];
if (!directory) throw new Error("An isolated test directory is required");
const controlDelayMs = Number(process.argv[3] ?? 0);
assert.ok(Number.isInteger(controlDelayMs) && controlDelayMs >= 0 && controlDelayMs <= 1000);
const controller = new AbortController();
let listCalls = 0;
const startedAt = performance.now();
const requests = [];
const sockets = new Set();
const socketClosures = [];
const activeResponses = new Set();
const unhandled = [];
const onUnhandled = reason => { unhandled.push(reason instanceof Error ? reason.name : typeof reason); };
process.on("unhandledRejection", onUnhandled);
let canceledAtMs;
let pendingAtCancel;
let child;
let childClosed;
let childUnhandled = false;
const endpoint = createServer((request, response) => {
  const record = { method: request.method, path: new URL(request.url, "http://localhost").pathname, model: null, atMs: performance.now() - startedAt, closedAtMs: null };
  requests.push(record);
  activeResponses.add(response);
  response.once("close", () => {
    record.closedAtMs = performance.now() - startedAt;
    activeResponses.delete(response);
  });
  let body = "";
  request.setEncoding("utf8");
  request.on("data", chunk => { if (body !== null) body = body.length + chunk.length <= 1024 * 1024 ? body + chunk : null; });
  request.on("end", () => {
    if (body?.length > 0) {
      try {
        const value = JSON.parse(body);
        record.model = typeof value.model === "string" ? value.model : null;
      } catch {
        record.model = null;
      }
    }
  });
  if (controlDelayMs === 0) {
    response.writeHead(401);
    response.end();
  }
});
endpoint.on("connection", socket => {
  sockets.add(socket);
  socketClosures.push(new Promise(resolve => socket.once("close", () => { sockets.delete(socket); resolve(); })));
});
await new Promise(resolve => endpoint.listen(0, "127.0.0.1", resolve));
const deadline = setTimeout(() => controller.abort(new Error("SDK control cancellation timed out")), 15_000);
const mcp = new McpServer({ name: "control-cancel", version: "1" }, { capabilities: { tools: {} } });
mcp.server.setRequestHandler(ListToolsRequestSchema, async () => {
  listCalls++;
  if (controlDelayMs > 0) await new Promise(resolve => setTimeout(resolve, controlDelayMs));
  canceledAtMs ??= performance.now() - startedAt;
  pendingAtCancel ??= activeResponses.size;
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
    model: "claude-sonnet-4-5-20250929",
    persistSession: false,
    abortController: controller,
    spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
      assert.equal(child, undefined);
      child = spawn(command, args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stderrTail = "";
      child.stderr.on("data", chunk => {
        const text = stderrTail + chunk.toString();
        childUnhandled ||= /UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION|triggerUncaughtException/.test(text);
        stderrTail = text.slice(-64);
      });
      childClosed = new Promise(resolve => child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal, atMs: performance.now() - startedAt })));
      return child;
    },
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
  assert.ok(child?.pid > 0);
  const exit = await childClosed;
  assert.ok(exit.code !== null || exit.signal !== null);
  assert.ok(exit.atMs >= canceledAtMs);
  await Promise.all(socketClosures);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sockets.size, 0);
  assert.equal(activeResponses.size, 0);
  assert.deepEqual(unhandled, []);
  assert.equal(childUnhandled, false);
  process.stdout.write(JSON.stringify({ canceled: true, listCalls, controlDelayMs, requests, canceledAtMs, pendingAtCancel, child: { pid: child.pid, ...exit }, openSockets: sockets.size, activeResponses: activeResponses.size, unhandled, childUnhandled }) + "\n");
} finally {
  clearTimeout(deadline);
  controller.abort();
  await mcp.close();
  endpoint.closeAllConnections();
  await new Promise(resolve => endpoint.close(resolve));
  process.off("unhandledRejection", onUnhandled);
}
