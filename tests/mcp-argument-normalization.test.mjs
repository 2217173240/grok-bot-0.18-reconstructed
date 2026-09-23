import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Value } from "@bufbuild/protobuf";
import { build } from "esbuild";

test("MCP 参数保留 JSON 与预编码 Value 的相同含义", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "mcp-args-"));
  try {
    const output = path.join(directory, "args.mjs");
    await build({ entryPoints: [path.join(root, "source/host/extensions/mcp/box-mcp-exec.ts")], outfile: output, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    const { toMcpArgs } = await import(pathToFileURL(output).href);
    const payload = { text: "hello", nested: { list: [1, false, null] } };
    const plain = toMcpArgs({ name: "echo", args: payload });
    const encoded = toMcpArgs({ name: "echo", args: Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, Value.fromJson(value)])) });
    assert.deepEqual(encoded.toJson(), plain.toJson());
    assert.equal(toMcpArgs(plain), plain);
    assert.deepEqual(Object.fromEntries(Object.entries(encoded.args).map(([key, value]) => [key, value.toJson()])), payload);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
