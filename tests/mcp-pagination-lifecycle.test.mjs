import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Value } from "@bufbuild/protobuf";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "tests/fixtures/mcp-paged-server.mjs");

async function loadHost(dir) {
  const output = path.join(dir, "mcp-host.mjs");
  await build({ entryPoints: [path.join(root, "source/box-exec-daemon/mcp-host.ts")], bundle: true, format: "esm", platform: "node", packages: "external", outfile: output, logLevel: "silent" });
  return import(pathToFileURL(output).href);
}

test("BoxMcpHost handles real MCP pagination and process lifecycle", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(root, ".tmp-mcp-pagination-"));
  const { BoxMcpHost } = await loadHost(dir);
  const host = new BoxMcpHost({ workspaceRoot: dir, connectTimeoutMs: 2_000, callTimeoutMs: 3_000 });
  const config = { mcpServers: { paged: { command: process.execPath, args: [fixture] } } };
  const repeatConfig = { mcpServers: { paged: { command: process.execPath, args: [fixture, "--repeat-cursor"] } } };
  try {
    await host.load(JSON.stringify(config));
    const listed = await host.listState({ serverIdentifiers: [], kickOnly: false });
    assert.equal(listed.result.case, "success");
    assert.deepEqual(listed.result.value.servers[0].tools.map((tool) => tool.name).sort(), ["paged__echo", "paged__identity"]);
    const mixed = await host.listState({ serverIdentifiers: ["paged", "missing"], kickOnly: false });
    assert.equal(mixed.result.case, "success");
    assert.equal(mixed.result.value.servers.find(server => server.serverIdentifier === "paged").status, "connected");
    assert.equal(mixed.result.value.servers.find(server => server.serverIdentifier === "missing").status, "error");
    const identity = await host.callTool({ name: "identity", toolName: "paged__identity", providerIdentifier: "paged", toolCallId: "identity-1", args: {} });
    assert.equal(identity.result.case, "success");
    const pid = Number(identity.result.value.content[0].content.value.text);
    assert.ok(Number.isInteger(pid) && pid > 0);
    const echo = await host.callTool({ name: "echo", toolName: "paged__echo", providerIdentifier: "paged", toolCallId: "echo-1", args: { text: Value.fromJson("second-page") } });
    assert.equal(echo.result.case, "success");
    assert.equal(echo.result.value.content[0].content.value.text, "echo:second-page");

    await host.load(JSON.stringify({ mcpServers: { paged: { args: [fixture], command: process.execPath } } }));
    const sameConfigIdentity = await host.callTool({ name: "identity", toolName: "paged__identity", providerIdentifier: "paged", toolCallId: "identity-2", args: {} });
    assert.equal(Number(sameConfigIdentity.result.value.content[0].content.value.text), pid);

    process.kill(pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const dead = await host.listState({ serverIdentifiers: ["paged"], kickOnly: true });
    assert.equal(dead.result.case, "success");
    assert.equal(dead.result.value.servers[0].status, "error");

    await host.load(JSON.stringify(config));
    const restored = await host.listState({ serverIdentifiers: ["paged"], kickOnly: false });
    assert.equal(restored.result.case, "success");
    assert.equal(restored.result.value.servers[0].status, "connected");
    const newIdentity = await host.callTool({ name: "identity", toolName: "paged__identity", providerIdentifier: "paged", toolCallId: "identity-3", args: {} });
    assert.notEqual(Number(newIdentity.result.value.content[0].content.value.text), pid);

    await host.load(JSON.stringify(repeatConfig));
    const repeated = await host.listState({ serverIdentifiers: ["paged"], kickOnly: false });
    assert.equal(repeated.result.case, "success");
    assert.equal(repeated.result.value.servers[0].status, "error");
    assert.match(repeated.result.value.servers[0].errorMessage, /repeated pagination cursor/);
  } finally {
    await host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
