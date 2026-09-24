import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

test("真实文件错误经过 SDK bridge 后完整保留在首个文本块，成功图片保持原顺序", async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/host-mcp-errors-"));
  await build({
    entryPoints: [
      path.join(root, "source/host/extensions/inference/host-tools-mcp-bridge.ts"),
      path.join(root, "source/shared/sand-spotlight.ts"),
    ],
    outdir: directory, entryNames: "[name]", bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent",
  });
  const { createHostToolsMcpBridge } = await import(pathToFileURL(path.join(directory, "host-tools-mcp-bridge.js")).href);
  const { spotlightToolResultContent, spotlightOpen, spotlightClose } = await import(pathToFileURL(path.join(directory, "sand-spotlight.js")).href);
  const missingPath = path.join(directory, "missing.png");
  const imagePath = path.join(root, "frontend/assets/snowflake-B53K53W6.png");
  let filesystemError;
  const bridge = createHostToolsMcpBridge([
    { name: "read_image", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  ], {
    async execute(call) {
      try {
        const data = await readFile(call.args.path, { signal: call.signal });
        return { content: spotlightToolResultContent("read_image", [
          { type: "text", text: "Image read successfully" },
          { type: "image", data, mimeType: "image/png" },
        ]), isError: false };
      } catch (error) {
        filesystemError = error;
        return { content: spotlightToolResultContent("read_image", [{ type: "text", text: error.message }]), isError: true };
      }
    },
  }, new AbortController().signal);
  const client = new Client({ name: "host-mcp-error-content", version: "1" }, { capabilities: {} });
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await bridge.config.instance.connect(serverTransport);
    await client.connect(clientTransport);
    const failure = await client.callTool({ name: "read_image", arguments: { path: missingPath } });
    assert.equal(filesystemError.code, "ENOENT");
    assert.equal(failure.isError, true);
    assert.deepEqual(failure.content, [{ type: "text", text: [spotlightOpen("read_image"), filesystemError.message, spotlightClose()].join("\n") }]);
    // SDK CLI 在 isError 时消费 content[0].text；这里检查模型实际能收到的正文。
    assert.ok(failure.content[0].text.includes(missingPath));
    const success = await client.callTool({ name: "read_image", arguments: { path: imagePath } });
    assert.equal(success.isError, false);
    assert.deepEqual(success.content, [
      { type: "text", text: spotlightOpen("read_image") },
      { type: "text", text: "Image read successfully" },
      { type: "image", data: (await readFile(imagePath)).toString("base64"), mimeType: "image/png" },
      { type: "text", text: spotlightClose() },
    ]);
  } finally {
    await client.close();
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});
