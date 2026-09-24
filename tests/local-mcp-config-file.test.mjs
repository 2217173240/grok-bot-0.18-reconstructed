import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("真实 MCP 配置文件保留 HTTP headers，损坏内容禁止作为空配置读取", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "mcp-config-"));
  try {
    const output = path.join(directory, "config.mjs");
    await build({ entryPoints: [path.join(root, "source/shared/node/mcp/local-mcp-servers.ts")], outfile: output, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    const api = await import(pathToFileURL(output).href);
    assert.equal(await api.readLocalMcpServersConfig(directory), null);
    const configuration = { mcpServers: { endpoint: { url: "http://127.0.0.1:1234/mcp", headers: { "X-Workspace": "test" }, type: "http" } } };
    const writer = api.createLocalMcpServersFileWriter(directory);
    await writer.setConfig(configuration);
    assert.deepEqual(await api.readLocalMcpServersConfig(directory), configuration);
    assert.deepEqual((await writer.getConfigForEdit()).config, configuration);
    const target = path.join(directory, "plugins", "mcp-servers.json");
    await writeFile(target, "{broken");
    await assert.rejects(api.readLocalMcpServersConfig(directory), /not valid JSON/);
    await assert.rejects(writer.getConfigForEdit(), /not valid JSON/);
    assert.equal(await readFile(target, "utf8"), "{broken");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
