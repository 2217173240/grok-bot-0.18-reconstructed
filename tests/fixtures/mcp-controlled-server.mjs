import { appendFile, readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const [mode, controlPath, eventsPath, identity, notifications] = process.argv.slice(2);
let state = JSON.parse(await readFile(controlPath, "utf8"));
const servers = new Set();
const pending = new Set();
const record = (event, data = {}) => appendFile(eventsPath, JSON.stringify({ event, identity, pid: process.pid, ...data }) + "\n");
function gate(ready, signal) {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const check = () => { if (ready()) { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(signal.reason ?? new Error("request canceled")); };
    const cleanup = () => { pending.delete(check); signal.removeEventListener("abort", abort); };
    pending.add(check);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
}
function createServer() {
  const server = new McpServer({ name: identity, version: "1" }, { capabilities: { tools: { listChanged: notifications === "true" } } });
  servers.add(server);
  const definition = name => ({ name, description: name, inputSchema: { type: "object", properties: { marker: { type: "string" }, text: { type: "string" } } } });
  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const page = request.params?.cursor == null ? 1 : 2;
    const revision = state.revision;
    await record("list-start", { page, revision });
    if (page === 2) await gate(() => !state.gatePage2, extra.signal);
    if (state.failList) throw new Error("controlled catalog failure");
    await record("list-end", { page, revision });
    return page === 1
      ? { tools: [definition("identity")], nextCursor: "page-2" }
      : { tools: [definition(`echo_${revision}`), definition("wait"), definition("fail")] };
  });
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    await record("call-start", { name, marker: args.marker ?? null });
    if (name === "wait") {
      try { await gate(() => state.released?.includes(args.marker), extra.signal); }
      catch (error) {
        if (extra.signal.aborted) await record("call-aborted", { marker: args.marker });
        throw error;
      }
    }
    if (name === "fail") throw new Error("controlled call failure");
    if (!["wait", "identity", `echo_${state.revision}`].includes(name)) throw new Error("tool no longer available");
    await record("effect", { name, marker: args.marker ?? null });
    return { content: [{ type: "text", text: JSON.stringify({ identity, pid: process.pid, revision: state.revision, text: args.text ?? null, arguments: args }) }] };
  });
  return server;
}
let updates = Promise.resolve();
watch(path.dirname(controlPath), (_event, file) => {
  if (file !== path.basename(controlPath)) return;
  updates = updates.then(async () => {
    const next = JSON.parse(await readFile(controlPath, "utf8"));
    if (next.sequence === state.sequence) return;
    const changed = next.revision !== state.revision || next.notify !== state.notify;
    state = next;
    if (changed && notifications === "true") {
      const results = await Promise.allSettled([...servers].map(async server => {
        await server.server.notification({ method: "notifications/tools/list_changed" });
        await server.server.ping();
      }));
      await record("notification", { rejected: results.filter(result => result.status === "rejected").length });
    }
    for (const resume of [...pending]) resume();
    await record("control", { sequence: state.sequence });
  });
  updates.catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
});
await record("started");
if (state.holdStdout) {
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", process.stdout, "ignore"] });
  holder.unref();
  await record("pipe-owner", { holderPid: holder.pid });
}
if (mode === "stdio") {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  const receive = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if (message.method === "tools/call") {
      record("wire-call", { arguments: message.params.arguments }).then(() => receive(message, extra));
    } else receive(message, extra);
  };
}
else {
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  const sessions = new Map();
  app.all("/mcp", async (request, response) => {
    if (request.body?.method === "notifications/cancelled" && state.cancelDelivery) {
      await record("cancellation-refused", { mode: state.cancelDelivery });
      if (state.cancelDelivery === "reject") response.status(503).end();
      return;
    }
    let transport = sessions.get(request.headers["mcp-session-id"]);
    if (transport == null && isInitializeRequest(request.body)) {
      const server = createServer();
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: id => sessions.set(id, transport) });
      transport.onclose = () => { sessions.delete(transport.sessionId); servers.delete(server); };
      await server.connect(transport);
    }
    if (transport == null) { response.status(404).end(); return; }
    await transport.handleRequest(request, response, request.body);
  });
  const listener = app.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: listener.address().port }) + "\n"));
}
