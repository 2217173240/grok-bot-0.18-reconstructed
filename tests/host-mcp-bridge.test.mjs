// Regression guard for the loopback MCP bridge.
//
// The bridge is how a CLI child that talks MCP over HTTP reaches this
// computer's plugin tools. It lives in shared code because both planes use it:
// the Mac coordinator around its routed provider, and the in-box host around the
// CLI child it runs itself. The client here is the real SDK client over the real
// HTTP transport, so the whole path — initialize, tools/list, tools/call — is
// exercised rather than a hand-written approximation of it.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function loadBridge() {
  const buildRoot = await mkdtemp(path.join(repositoryRoot, ".tmp-mcp-bridge-"));
  const outfile = path.join(buildRoot, "routed-mcp-bridge.mjs");
  await build({
    entryPoints: [path.join(repositoryRoot, "source/shared/node/mcp/routed-mcp-bridge.ts")],
    bundle: true,
    format: "esm",
    packages: "external",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  return { module: await import(pathToFileURL(outfile).href), buildRoot };
}

const TOOLS = [
  { name: "weather__forecast", providerIdentifier: "weather", toolName: "forecast", description: "Read the forecast", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  { name: "mail__send", providerIdentifier: "mail", toolName: "send", description: "Send a message", inputSchema: { type: "object", properties: { to: { type: "string" } } } },
];

test("the loopback bridge serves this computer's plugin tools to an MCP client", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { module, buildRoot } = await loadBridge();
  const calls = [];
  const bridge = await module.createRoutedMcpBridge({
    listTools: async () => TOOLS,
    callTool: async (tool) => {
      calls.push(tool);
      return { result: { case: "success", value: { isError: false, content: [{ content: { case: "text", value: { text: `${tool.providerIdentifier}:${tool.toolName}:${JSON.stringify(tool.args)}` } } }] } } };
    },
  });
  const client = new Client({ name: "bridge-test", version: "1" }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));

    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["mail__send", "weather__forecast"]);
    const forecast = listed.tools.find((tool) => tool.name === "weather__forecast");
    assert.equal(forecast.description, "Read the forecast");
    assert.deepEqual(forecast.inputSchema.required, ["city"]);
    // 描述文本不能证明工具权限或幂等性。
    assert.equal(forecast.annotations, undefined);
    assert.equal(listed.tools.find((tool) => tool.name === "mail__send").annotations, undefined);

    const called = await client.callTool({ name: "weather__forecast", arguments: { city: "Berlin" } });
    assert.equal(called.isError, false);
    assert.equal(called.content[0].text, 'weather:forecast:{"city":"Berlin"}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].providerIdentifier, "weather");
    assert.equal(calls[0].toolName, "forecast");
    assert.ok(calls[0].toolCallId.length > 0, "the bridge stamps each call so the host can audit it");

    // A name the bridge never listed is refused without reaching the host.
    await assert.rejects(
      client.callTool({ name: "absent__tool", arguments: {} }),
      (error) => error?.code === -32602 && /Unknown Grok Bot plugin tool/.test(error.message),
    );
    assert.equal(calls.length, 1);

    // A host-side failure comes back as a failed call, never as a silent success.
    const failing = await module.createRoutedMcpBridge({
      listTools: async () => TOOLS,
      callTool: async () => { throw new Error("the computer refused the call"); },
    });
    const failingClient = new Client({ name: "bridge-test-failure", version: "1" }, { capabilities: {} });
    try {
      await failingClient.connect(new StreamableHTTPClientTransport(new URL(failing.url)));
      await failingClient.listTools();
      await assert.rejects(
        failingClient.callTool({ name: "mail__send", arguments: { to: "someone" } }),
        (error) => error?.code === -32603 && /refused the call/.test(error.message),
      );
    } finally {
      await failingClient.close();
      await failing.close();
    }
  } finally {
    await client.close();
    await bridge.close();
    await rm(buildRoot, { recursive: true, force: true });
  }
});
