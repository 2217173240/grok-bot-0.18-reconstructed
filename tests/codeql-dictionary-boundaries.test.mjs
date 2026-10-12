import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

async function productionModule(t, entry) {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "dictionary-boundary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, "production.mjs");
  await build({ entryPoints: [path.join(root, entry)], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
  return { api: await import(pathToFileURL(outfile).href), directory };
}

test("workflow 特殊键保持为数据，不继承名称、来源或调度", async t => {
  const { api } = await productionModule(t, "source/shared/workflow-model.ts");
  const raw = [
    "---", "__proto__:", "  name: injected-name", "  trigger:", "    schedule: '* * * * *'", "    enabled: true",
    "constructor:", "  label: retained", "metadata:", "  __proto__:", "    source: https://example.test/skill",
    "trigger:", "  __proto__:", "    schedule: '* * * * *'", "    enabled: true", "---", "Workflow body",
  ].join("\n");
  const parsed = api.parseWorkflowFile(raw);
  assert.equal(parsed.name, "");
  assert.equal(parsed.trigger, null);
  assert.equal(parsed.sourceRef, null);
  assert.equal(Object.getPrototypeOf(parsed.data), null);
  assert.equal(Object.getPrototypeOf(parsed.data.trigger), null);
  assert.equal(Object.hasOwn(parsed.data, "__proto__"), true);
  assert.equal(parsed.data.__proto__.name, "injected-name");
  assert.equal(parsed.data.constructor.label, "retained");
  const encoded = api.serializeWorkflowFile({ name: "Real workflow", description: "", body: parsed.body, trigger: { schedule: "0 9 * * *", isEnabled: false } }, parsed.data);
  const restored = api.parseWorkflowFile(encoded);
  assert.equal(restored.name, "Real workflow");
  assert.deepEqual(restored.trigger, { schedule: "0 9 * * *", isEnabled: false });
  assert.equal(restored.sourceRef, null);
  assert.deepEqual(restored.data.__proto__, parsed.data.__proto__);
  assert.deepEqual(restored.data.constructor, parsed.data.constructor);
  assert.deepEqual(restored.data.metadata, parsed.data.metadata);
});

test("workflow 无 frontmatter 的结果仍可安全添加特殊键", async t => {
  const { api } = await productionModule(t, "source/shared/workflow-model.ts");
  for (const raw of ["Plain body", "---incomplete", "---\nincomplete"]) {
    const parsed = api.parseWorkflowFile(raw);
    assert.equal(Object.getPrototypeOf(parsed.data), null);
    parsed.data.__proto__ = { name: "metadata-only" };
    parsed.data.constructor = "retained";
    assert.equal(parsed.data.name, undefined);
    const restored = api.parseWorkflowFile(api.serializeWorkflowFile({ name: "Ordinary", description: "", body: "body", trigger: null }, parsed.data));
    assert.equal(restored.data.__proto__.name, "metadata-only");
    assert.equal(restored.data.constructor, "retained");
    assert.equal(restored.name, "Ordinary");
  }
});

test("MCP 特殊服务器名称经过生产解析、文件写入和重新读取保持完整", async t => {
  const { api, directory } = await productionModule(t, "source/shared/node/mcp/local-mcp-servers.ts");
  const original = JSON.parse('{"mcpServers":{"__proto__":{"command":"node","args":["server.js"]},"constructor":{"url":"https://example.test/mcp","type":"http"}}}');
  const config = api.parseLocalMcpServersConfig(JSON.stringify(original));
  assert.equal(Object.getPrototypeOf(config.mcpServers), null);
  assert.deepEqual(Object.keys(config.mcpServers), ["__proto__", "constructor"]);
  assert.equal(config.mcpServers.command, undefined);
  const writer = api.createLocalMcpServersFileWriter(directory);
  await writer.setConfig(config);
  const restored = await api.readLocalMcpServersConfig(directory);
  assert.deepEqual(restored, config);
  assert.deepEqual(JSON.parse(await readFile(api.localMcpServersPath(directory), "utf8")), original);
  assert.equal(Object.getPrototypeOf(restored.mcpServers), null);
});

test("MCP 空配置的编辑字典允许新增和再次更新特殊名称", async t => {
  const { api, directory } = await productionModule(t, "source/shared/node/mcp/local-mcp-servers.ts");
  const writer = api.createLocalMcpServersFileWriter(directory);
  const { config } = await writer.getConfigForEdit();
  assert.equal(Object.getPrototypeOf(config.mcpServers), null);
  config.mcpServers.__proto__ = { command: "node", args: ["first.js"] };
  config.mcpServers.constructor = { command: "node", args: ["second.js"] };
  await writer.setConfig(config);
  const next = (await writer.getConfigForEdit()).config;
  next.mcpServers.__proto__ = { command: "node", args: ["updated.js"] };
  await writer.setConfig(next);
  const restored = await api.readLocalMcpServersConfig(directory);
  assert.equal(Object.getPrototypeOf(restored.mcpServers), null);
  assert.deepEqual(restored.mcpServers.__proto__.args, ["updated.js"]);
  assert.deepEqual(restored.mcpServers.constructor.args, ["second.js"]);
  assert.equal(restored.mcpServers.command, undefined);
});

test("MCP 持久化配置经过运行定义查询后仍保留特殊名称", async t => {
  const { api, directory } = await productionModule(t, "source/shared/node/mcp/local-mcp-servers.ts");
  const { api: { SandMcpDefinitionSource } } = await productionModule(t, "source/shared/node/mcp/mcp-definition-source.ts");
  const writer = api.createLocalMcpServersFileWriter(directory);
  await writer.setConfig(JSON.parse('{"mcpServers":{"__proto__":{"command":"node","args":["server.js"]},"constructor":{"url":"https://example.test/mcp","type":"http"}}}'));
  for (const includeBuiltins of [false, true]) {
    const definitions = new SandMcpDefinitionSource(includeBuiltins, () => api.readLocalMcpServersConfig(directory));
    const stdio = await definitions.getStdioServerConfigs();
    assert.equal(Object.getPrototypeOf(stdio), null);
    assert.deepEqual(Object.keys(stdio), ["__proto__"]);
    assert.equal(stdio.__proto__.command, "node");
    assert.deepEqual(definitions.peekStdioServerNames(), ["__proto__"]);
    assert.deepEqual(definitions.peekHttpServerNames(), ["constructor"]);
    assert.equal(await definitions.getServerUrlForIdentifier("constructor"), "https://example.test/mcp");
    assert.equal(await definitions.getServerUrlForIdentifier("toString"), undefined);
    assert.deepEqual((await definitions.getDefinitions()).filter(entry => entry.source === "account").map(entry => entry.identifier), ["constructor"]);
    const config = (await writer.getConfigForEdit()).config;
    config.mcpServers.__proto__ = { url: "https://example.test/updated", type: "http" };
    await writer.setConfig(config);
    await definitions.ensureConfigLoaded();
    assert.equal(await definitions.getServerUrlForIdentifier("__proto__"), "https://example.test/updated");
    assert.deepEqual((await definitions.getDefinitions()).filter(entry => entry.source === "account").map(entry => entry.identifier), ["__proto__", "constructor"]);
    config.mcpServers.__proto__ = { command: "node", args: ["server.js"] };
    await writer.setConfig(config);
  }
});

test("source map 从缺失、损坏和无效文件恢复后为特殊 ID 创建独立持久记录", async t => {
  const { api, directory } = await productionModule(t, "source/host/extensions/source-map/source-map-service.ts");
  for (const [index, contents] of [undefined, "{broken", "[]"].entries()) {
    const filename = path.join(directory, `source-map-${index}.json`);
    if (contents !== undefined) await writeFile(filename, contents);
    const sourceMap = new api.SandSourceMap(filename);
    const protoEntry = await sourceMap.getOrCreate("__proto__");
    const constructorEntry = await sourceMap.getOrCreate("constructor");
    assert.match(protoEntry.sourceId, /^[0-9a-f-]{36}$/);
    assert.match(constructorEntry.sourceId, /^[0-9a-f-]{36}$/);
    assert.notEqual(protoEntry.sourceId, constructorEntry.sourceId);
    await sourceMap.setMode("__proto__", "agent-store");
    const restored = new api.SandSourceMap(filename);
    assert.deepEqual(await restored.getOrCreate("__proto__"), { ...protoEntry, mode: "agent-store" });
    assert.deepEqual(await restored.getOrCreate("constructor"), constructorEntry);
    const stored = JSON.parse(await readFile(filename, "utf8"));
    assert.deepEqual(Object.keys(stored), ["__proto__", "constructor"]);
  }
});

test("source map 解析已有特殊键后，普通 agent 不读取继承的 sourceId", async t => {
  const { api, directory } = await productionModule(t, "source/host/extensions/source-map/source-map-service.ts");
  const filename = path.join(directory, "source-map.json");
  await writeFile(filename, '{"__proto__":{"sourceId":"stored-proto","mode":"local"},"constructor":{"sourceId":"stored-constructor","mode":"agent-store"}}');
  const sourceMap = new api.SandSourceMap(filename);
  assert.deepEqual(await sourceMap.getOrCreate("__proto__"), { sourceId: "stored-proto", mode: "local" });
  assert.deepEqual(await sourceMap.getOrCreate("constructor"), { sourceId: "stored-constructor", mode: "agent-store" });
  const ordinary = await sourceMap.getOrCreate("sourceId");
  assert.match(ordinary.sourceId, /^[0-9a-f-]{36}$/);
  assert.equal(ordinary.mode, "local");
  const restored = new api.SandSourceMap(filename);
  assert.deepEqual(await restored.getOrCreate("sourceId"), ordinary);
});
