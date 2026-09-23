import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

test("Claude host bridge lists and executes a real host action and returns MCP errors", { timeout: 15_000 }, async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/host-bridge-"));
  const output = path.join(directory, "bridge.mjs");
  const file = path.join(directory, "output.txt");
  await build({ entryPoints: [path.join(root, "source/host/extensions/inference/host-tools-mcp-bridge.ts")], outfile: output, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
  const { createHostToolsMcpBridge } = await import(pathToFileURL(output).href);
  const turn = new AbortController();
  const calls = [];
  const bridge = createHostToolsMcpBridge([{ name: "write_output", description: "Write test output", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }], {
    execute: async call => {
      calls.push(call);
      if (call.args.text === "fail") return { content: [{ type: "text", text: "Denied by host tool" }], isError: true };
      await writeFile(file, call.args.text, { signal: call.signal });
      return { content: [{ type: "text", text: `wrote ${call.args.text}` }], isError: false };
    },
  }, turn.signal);
  const client = new Client({ name: "host-tool-test", version: "1" }, { capabilities: {} });
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await bridge.config.instance.connect(serverTransport);
    await client.connect(clientTransport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["write_output"]);
    const success = await client.callTool({ name: "write_output", arguments: { text: "real action" } });
    assert.equal(success.isError, false);
    assert.equal(success.content[0].text, "wrote real action");
    assert.equal(await readFile(file, "utf8"), "real action");
    assert.match(calls[0].toolCallId, /^[0-9a-f-]{36}$/);
    const failure = await client.callTool({ name: "write_output", arguments: { text: "fail" } });
    assert.equal(failure.isError, true);
    assert.equal(failure.content[0].text, "Denied by host tool");
    assert.equal(await readFile(file, "utf8"), "real action");
    turn.abort(new Error("turn ended"));
    const canceled = await client.callTool({ name: "write_output", arguments: { text: "after turn" } });
    assert.equal(canceled.isError, true);
    assert.equal(await readFile(file, "utf8"), "real action");
  } finally {
    await client.close();
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});
