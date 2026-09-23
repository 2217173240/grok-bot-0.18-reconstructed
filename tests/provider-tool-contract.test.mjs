import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { jsonSchema } from "ai";
import { z } from "zod";

const root = path.resolve(import.meta.dirname, "..");

test("provider 参数保留真实 AI SDK Schema、Zod 与 JSON 的内容", async () => {
  const directory = await mkdtemp(path.join(root, ".cache/provider-contract-"));
  try {
    const output = path.join(directory, "provider.mjs");
    await build({ entryPoints: [path.join(root, "source/host/extensions/inference/provider-session.ts")], outfile: output, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    const { routedToolSchema, codexInput } = await import(pathToFileURL(output).href);
    const raw = { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false };
    assert.deepEqual(routedToolSchema({ parameters: jsonSchema(raw) }), raw);
    assert.deepEqual(routedToolSchema({ inputSchema: raw }), raw);
    assert.deepEqual(routedToolSchema({ parameters: z.object({ command: z.string() }) }).properties, raw.properties);
    assert.deepEqual(codexInput([
      { role: "user", content: [{ type: "text", text: "执行命令" }] },
      { role: "assistant", content: [{ type: "text", text: "开始执行" }, { type: "tool-call", toolCallId: "call-1", toolName: "Shell", args: { command: "uname -s" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "Shell", result: "Linux" }] },
    ]), [
      { role: "user", content: "执行命令" },
      { role: "assistant", content: "开始执行" },
      { type: "function_call", call_id: "call-1", name: "Shell", arguments: '{"command":"uname -s"}' },
      { type: "function_call_output", call_id: "call-1", output: "Linux" },
    ]);
    assert.throws(() => codexInput([{ role: "assistant", content: [{ type: "unknown" }] }]), /Unsupported Codex message content/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
