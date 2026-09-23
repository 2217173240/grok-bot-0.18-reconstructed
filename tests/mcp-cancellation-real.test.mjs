import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Value } from "@bufbuild/protobuf";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

const root = path.resolve(import.meta.dirname, "..");

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`MCP tool did not start: ${file}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("real stdio MCP cancellation stops a delayed side effect and releases the bridge", { timeout: 15_000 }, async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/mcp-cancel-"));
  const startedPath = path.join(directory, "started.txt");
  const completedPath = path.join(directory, "completed.txt");
  await build({ entryPoints: [path.join(root, "source/shared/node/mcp/routed-mcp-bridge.ts"), path.join(root, "source/box-exec-daemon/mcp-host.ts")], bundle: true, format: "esm", packages: "external", platform: "node", outdir: directory, outExtension: { ".js": ".mjs" }, logLevel: "silent" });
  const { createRoutedMcpBridge } = await import(pathToFileURL(path.join(directory, "shared/node/mcp/routed-mcp-bridge.mjs")).href);
  const { BoxMcpHost } = await import(pathToFileURL(path.join(directory, "box-exec-daemon/mcp-host.mjs")).href);
  const host = new BoxMcpHost({ workspaceRoot: directory });
  const client = new Client({ name: "cancel-test", version: "1" }, { capabilities: {} });
  let bridge;
  let listingSignal;
  try {
    await host.load(JSON.stringify({ mcpServers: { delayed: { command: process.execPath, args: [path.join(root, "tests/fixtures/mcp-delayed-server.mjs")], cwd: directory } } }));
    bridge = await createRoutedMcpBridge({
      listTools: async signal => {
        listingSignal = signal;
        const state = await host.listState({ serverIdentifiers: ["delayed"] }, signal);
        assert.equal(state.result.case, "success");
        return state.result.value.servers.flatMap(server => server.tools).map(tool => ({ name: tool.name, providerIdentifier: tool.providerIdentifier, toolName: tool.toolName, inputSchema: tool.inputSchema.toJson() }));
      },
      callTool: args => host.callTool({ name: args.toolName, toolName: args.name, providerIdentifier: args.providerIdentifier, toolCallId: args.toolCallId, args: Object.fromEntries(Object.entries(args.args).map(([key, value]) => [key, Value.fromJson(value)])) }, args.signal),
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
    assert.ok((await client.listTools()).tools.some(tool => tool.name === "delayed__delayedWrite"));
    const controller = new AbortController();
    const request = client.callTool({ name: "delayed__delayedWrite", arguments: { startedPath, completedPath, delayMs: 700 } }, undefined, { signal: controller.signal });
    void request.catch(() => undefined);
    await waitForFile(startedPath, 5_000);
    listingSignal = undefined;
    const listingController = new AbortController();
    const queuedListing = client.listTools(undefined, { signal: listingController.signal });
    void queuedListing.catch(() => undefined);
    const listingDeadline = Date.now() + 5_000;
    while (listingSignal == null) {
      if (Date.now() >= listingDeadline) throw new Error("MCP listing did not reach the bridge");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    listingController.abort(new Error("cancel delayed MCP listing"));
    await assert.rejects(queuedListing, /cancel|abort/i);
    const abortDeadline = Date.now() + 1_000;
    while (!listingSignal.aborted && Date.now() < abortDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(listingSignal.aborted, true);
    controller.abort(new Error("cancel delayed MCP call"));
    await assert.rejects(request, /cancel|abort/i);
    await new Promise(resolve => setTimeout(resolve, 850));
    assert.equal(existsSync(completedPath), false, "canceled MCP server still wrote the completion marker");
  } finally {
    await client.close();
    await bridge?.close();
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real daemon RPC cancellation reaches the stdio MCP server", { timeout: 15_000 }, async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/mcp-daemon-cancel-"));
  const startedPath = path.join(directory, "started.txt");
  const completedPath = path.join(directory, "completed.txt");
  await build({ entryPoints: [path.join(root, "source/box-exec-daemon/server.ts"), path.join(root, "source/packages/proto/generated/agent/v1/control_service_connect.ts"), path.join(root, "source/packages/proto/generated/agent/v1/control_service_pb.ts"), path.join(root, "source/packages/proto/generated/agent/v1/exec_service_connect.ts"), path.join(root, "source/packages/proto/generated/agent/v1/exec_pb.ts"), path.join(root, "source/packages/proto/generated/agent/v1/mcp_exec_pb.ts")], bundle: true, format: "esm", packages: "external", platform: "node", outdir: directory, outExtension: { ".js": ".mjs" }, logLevel: "silent" });
  const load = async filename => await import(pathToFileURL(path.join(directory, filename)).href);
  const daemonModule = await load("box-exec-daemon/server.mjs");
  const control = await load("packages/proto/generated/agent/v1/control_service_connect.mjs");
  const controlPb = await load("packages/proto/generated/agent/v1/control_service_pb.mjs");
  const exec = await load("packages/proto/generated/agent/v1/exec_service_connect.mjs");
  const execPb = await load("packages/proto/generated/agent/v1/exec_pb.mjs");
  const mcpPb = await load("packages/proto/generated/agent/v1/mcp_exec_pb.mjs");
  const authToken = "isolated-mcp-cancel-test";
  const daemon = await daemonModule.startBoxExecDaemon({ port: 0, authToken, workspaceRoot: directory });
  try {
    const transport = createConnectTransport({ httpVersion: "1.1", baseUrl: daemon.url, useBinaryFormat: true, interceptors: [next => async request => { request.header.set("Authorization", `Bearer ${authToken}`); return await next(request); }] });
    const controlClient = createClient(control.ControlService, transport);
    const execClient = createClient(exec.ExecService, transport);
    await controlClient.loadMcpServers(new controlPb.LoadMcpServersRequest({ mcpConfigJson: JSON.stringify({ mcpServers: { delayed: { command: process.execPath, args: [path.join(root, "tests/fixtures/mcp-delayed-server.mjs")], cwd: directory } } }) }));
    const args = { startedPath, completedPath, delayMs: 700 };
    const encoded = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, Value.fromJson(value)]));
    const request = new execPb.ExecServerMessage({ id: 1, message: { case: "mcpArgs", value: new mcpPb.McpArgs({ name: "delayedWrite", providerIdentifier: "delayed", toolName: "delayed__delayedWrite", toolCallId: "daemon-cancel-call", args: encoded }) } });
    const controller = new AbortController();
    const executing = (async () => { for await (const _part of execClient.exec(request, { signal: controller.signal })) {} })();
    void executing.catch(() => undefined);
    await waitForFile(startedPath, 5_000);
    controller.abort(new Error("cancel daemon MCP call"));
    await assert.rejects(executing, /cancel|abort/i);
    await new Promise(resolve => setTimeout(resolve, 850));
    assert.equal(existsSync(completedPath), false, "canceled daemon MCP call still wrote the completion marker");
  } finally {
    await daemon.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
