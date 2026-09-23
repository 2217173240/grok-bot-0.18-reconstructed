import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Value } from "@bufbuild/protobuf";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
test("真实 stdio 插件经 BoxMcpHost 和 HTTP bridge 往返并释放资源", { timeout: 15_000 }, async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "mcp-protocol-"));
  await build({ entryPoints: [path.join(root, "source/shared/node/mcp/routed-mcp-bridge.ts"), path.join(root, "source/box-exec-daemon/mcp-host.ts")], bundle: true, format: "esm", packages: "external", platform: "node", outdir: directory, outExtension: { ".js": ".mjs" }, logLevel: "silent" });
  const { createRoutedMcpBridge } = await import(pathToFileURL(path.join(directory, "shared/node/mcp/routed-mcp-bridge.mjs")).href);
  const { BoxMcpHost } = await import(pathToFileURL(path.join(directory, "box-exec-daemon/mcp-host.mjs")).href);
  const host = new BoxMcpHost({ workspaceRoot: directory });
  const client = new Client({ name: "protocol-test", version: "1" }, { capabilities: {} });
  let bridge;
  try {
    await host.load(JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [path.join(root, "tests/fixtures/mcp-echo-server.mjs"), "--image"] } } }));
    bridge = await createRoutedMcpBridge({
      listTools: async () => {
        const state = await host.listState({ serverIdentifiers: ["fixture"], kickOnly: false });
        assert.equal(state.result.case, "success");
        return state.result.value.servers.flatMap(server => server.tools).map(tool => ({ name: tool.name, providerIdentifier: tool.providerIdentifier, toolName: tool.toolName, inputSchema: tool.inputSchema.toJson() }));
      },
      callTool: args => host.callTool({ name: args.toolName, toolName: args.name, providerIdentifier: args.providerIdentifier, toolCallId: args.toolCallId, args: Object.fromEntries(Object.entries(args.args).map(([key, value]) => [key, Value.fromJson(value)])) }),
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
    const listing = await client.listTools();
    assert.ok(listing.tools.some(tool => tool.name === "fixture__image"));
    const result = await client.callTool({ name: "fixture__image", arguments: {} });
    assert.equal(result.content[0].mimeType, "image/png");
    assert.deepEqual(Buffer.from(result.content[0].data, "base64").subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const malformed = await fetch(bridge.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{" });
    assert.equal(malformed.status, 400);
    assert.equal((await client.callTool({ name: "fixture__echo", arguments: { text: "after-malformed" } })).content[0].text, "echo:after-malformed");
    await client.close();
    const closing = bridge.close();
    assert.equal(bridge.close(), closing);
    await closing;
    await assert.rejects(fetch(bridge.url));
  } finally {
    await client.close();
    await bridge?.close();
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
