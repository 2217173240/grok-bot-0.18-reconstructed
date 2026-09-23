import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { jsonSchema } from "ai";
import { z } from "zod";

const root = path.resolve(import.meta.dirname, "..");

test("provider 参数保留真实 AI SDK Schema、Zod 与 JSON 的内容", async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/provider-contract-"));
  try {
    const output = path.join(directory, "provider.mjs");
    await build({ entryPoints: [path.join(root, "source/host/extensions/inference/provider-session.ts")], outfile: output, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    const { routedToolSchema, codexInput, claudePrompt } = await import(pathToFileURL(output).href);
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
    const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRssAAAAASUVORK5CYII=";
    const image = Buffer.from(imageBase64, "base64");
    const imageDataUrl = `data:image/png;base64,${imageBase64}`;
    assert.deepEqual(codexInput([
      { role: "user", content: [{ type: "text", text: "Inspect " }, { type: "image", image, mimeType: "image/png" }, { type: "text", text: "this image" }] },
      { role: "user", content: [{ type: "image", image: new URL("https://example.com/photo.png"), mimeType: "image/png" }] },
      { role: "user", content: [{ type: "image", image: imageDataUrl, mimeType: "image/png" }] },
    ]), [
      { role: "user", content: [{ type: "input_text", text: "Inspect " }, { type: "input_image", image_url: imageDataUrl }, { type: "input_text", text: "this image" }] },
      { role: "user", content: [{ type: "input_image", image_url: "https://example.com/photo.png" }] },
      { role: "user", content: [{ type: "input_image", image_url: imageDataUrl }] },
    ]);
    const multimodalPrompt = claudePrompt([{ role: "user", content: [{ type: "text", text: "Inspect " }, { type: "image", image, mimeType: "image/png" }, { type: "text", text: "this image" }] }]);
    assert.equal(typeof multimodalPrompt, "object");
    const prompts = [];
    for await (const prompt of multimodalPrompt) prompts.push(prompt);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].type, "user");
    assert.deepEqual(prompts[0].message.content.slice(-4), [
      { type: "text", text: "Inspect " },
      { type: "image", source: { type: "base64", media_type: "image/png", data: imageBase64 } },
      { type: "text", text: "this image" },
      { type: "text", text: "\n\n" },
    ]);
    const remotePrompt = claudePrompt([{ role: "user", content: [{ type: "image", image: new URL("https://example.com/photo.png"), mimeType: "image/png" }] }]);
    const remoteMessages = [];
    for await (const prompt of remotePrompt) remoteMessages.push(prompt);
    assert.deepEqual(remoteMessages[0].message.content.at(-2), { type: "image", source: { type: "url", url: "https://example.com/photo.png" } });
    assert.throws(() => codexInput([{ role: "user", content: [{ type: "image", image: new URL("file:///tmp/secret.png"), mimeType: "image/png" }] }]), /HTTP\(S\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
