import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "tests/fixtures/mcp-http-runtime-server.mjs");

async function loadHost(dir) {
  const output = path.join(dir, "mcp-host.mjs");
  await build({ entryPoints: [path.join(root, "source/box-exec-daemon/mcp-host.ts")], bundle: true, format: "esm", platform: "node", packages: "external", outfile: output, logLevel: "silent" });
  return import(pathToFileURL(output).href);
}
function startHttpServer() {
  const child = spawn(process.execPath, [fixture], { stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise((resolve, reject) => {
    child.stdout.once("data", data => resolve(JSON.parse(String(data))));
    child.once("error", reject);
    child.once("exit", code => { if (code !== null && code !== 0) reject(new Error(`fixture exited ${code}`)); });
  });
  return { child, ready };
}

test("BoxMcpHost owns HTTP and stdio MCP servers with retry and canonical idempotency", async () => {
  const dir = await mkdtemp(path.join(root, ".tmp-mcp-local-runtime-"));
  const { child, ready } = startHttpServer();
  const { BoxMcpHost } = await loadHost(dir);
  const { Value } = await import("@bufbuild/protobuf");
  const http = await ready;
  const host = new BoxMcpHost({ workspaceRoot: dir, connectTimeoutMs: 2_000, callTimeoutMs: 5_000 });
  try {
    const config = { mcpServers: { http: { url: `http://127.0.0.1:${http.port}/mcp`, headers: { "X-Test-Workspace": "local-runtime" } }, broken: { command: path.join(dir, "missing-server") } } };
    assert.deepEqual((await host.load(JSON.stringify(config))).sort(), ["broken", "http"]);
    const state = await host.listState({ serverIdentifiers: [], kickOnly: false });
    assert.equal(state.result.case, "success");
    assert.equal(state.result.value.servers.find(row => row.serverIdentifier === "http").status, "connected");
    assert.equal(state.result.value.servers.find(row => row.serverIdentifier === "broken").status, "error");

    const reordered = { mcpServers: { broken: { command: config.mcpServers.broken.command }, http: { headers: config.mcpServers.http.headers, url: config.mcpServers.http.url } } };
    await host.load(JSON.stringify(reordered));
    const retried = await host.listState({ serverIdentifiers: ["broken"], kickOnly: true });
    assert.equal(retried.result.value.servers[0].status, "error");

    const call = await host.callTool({ name: "echo", toolName: "http__echo", providerIdentifier: "http", toolCallId: "test", args: { text: Value.fromJson("ok") } });
    assert.equal(call.result.case, "success");
    assert.equal(call.result.value.content[0].content.value.text, "http:ok");
  } finally {
    await host.dispose();
    child.kill("SIGTERM");
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispose closes an in-flight failed connection without reviving the host", async () => {
  const dir = await mkdtemp(path.join(root, ".tmp-mcp-dispose-"));
  const { BoxMcpHost } = await loadHost(dir);
  const host = new BoxMcpHost({ workspaceRoot: dir, connectTimeoutMs: 300, callTimeoutMs: 500 });
  const loading = host.load(JSON.stringify({ mcpServers: { unavailable: { url: "http://127.0.0.1:1/mcp" } } }));
  await host.dispose();
  await assert.rejects(loading, /disposed/);
  const state = await host.listState({ serverIdentifiers: [], kickOnly: true });
  assert.equal(state.result.case, "error");
  await rm(dir, { recursive: true, force: true });
});

test("关闭正在初始化的真实 MCP 子进程", { timeout: 8_000 }, async () => {
  const dir = await mkdtemp(path.join(root, ".tmp-mcp-dispose-active-"));
  const { BoxMcpHost } = await loadHost(dir);
  const host = new BoxMcpHost({ workspaceRoot: dir, connectTimeoutMs: 5_000 });
  const marker = path.join(dir, "started");
  const loading = host.load(JSON.stringify({ mcpServers: { slow: { command: process.execPath, args: [path.join(root, "tests/fixtures/mcp-paged-server.mjs"), "--startup-marker", marker] } } }));
  const rejected = assert.rejects(loading, /disposed/);
  try {
    const deadline = Date.now() + 3_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    const pid = Number(await readFile(marker, "utf8"));
    const closing = host.dispose();
    assert.equal(host.dispose(), closing);
    await closing;
    await rejected;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
