import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import png from "@jimp/js-png";
import jpeg from "@jimp/js-jpeg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

test("图片经过 daemon、Read、tool-stream 和 MCP 后保留图像字节与类型", async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/image-read-"));
  let daemon;
  let bridge;
  let client;
  const ctxCancels = [];
  try {
    const outfile = path.join(directory, "pipeline.mjs");
    await build({
      stdin: {
        contents: [
          'export { startBoxExecDaemon } from "./source/box-exec-daemon/server.ts";',
          'export { productionBoxGeneratedPorts } from "./source/host/box/generated-production.ts";',
          'export { createBoxRemoteResourceAccessor } from "./source/host/box/box-remote-accessor.ts";',
          'export { readExecutorResource } from "./source/packages/agent-exec/read.ts";',
          'export { ReadArgs } from "./source/packages/proto/generated/agent/v1/read_exec_pb.ts";',
          'export { createReadTool } from "./source/packages/agent/tools/core/read/read.ts";',
          'export { createContext } from "./source/packages/context/core.ts";',
          'export { InteractionHandler } from "./source/packages/agent/interaction-handler.ts";',
          'export { executeDeferredToolCall } from "./source/packages/agent/tool-stream-executor.ts";',
          'export { createHostToolsMcpBridge } from "./source/host/extensions/inference/host-tools-mcp-bridge.ts";',
        ].join("\n"),
        resolveDir: root,
        loader: "ts",
      },
      outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent",
    });
    const pipeline = await import(pathToFileURL(outfile).href);
    const fixture16 = await readFile(path.join(root, "tests/fixtures/host-tools-vision.png"));
    const bitmap = png().decode(fixture16);
    assert.equal(bitmap.width, 640);
    assert.equal(bitmap.height, 260);
    const fixtures = [
      { name: "rgba16.png", bytes: fixture16, mimeType: "image/png" },
      { name: "rgba8.png", bytes: png().encode(bitmap), mimeType: "image/png" },
      { name: "photo.jpg", bytes: jpeg().encode(bitmap), mimeType: "image/jpeg" },
    ];
    daemon = await pipeline.startBoxExecDaemon({ port: 0, authToken: "image-read-test", workspaceRoot: directory });
    const url = new URL(daemon.url);
    const accessor = pipeline.createBoxRemoteResourceAccessor({ host: url.hostname, port: Number(url.port), authToken: "image-read-test" }, pipeline.productionBoxGeneratedPorts);
    const readExecutor = accessor.get(pipeline.readExecutorResource);
    const readTool = pipeline.createReadTool(accessor, {}, "latest");
    const events = [];
    const recorded = new Map();
    const interaction = new pipeline.InteractionHandler(
      { sendUpdate: async (_ctx, update) => { events.push(update); } },
      { recordToolCall: (call, id) => { recorded.set(id, call); } },
      "image-read-test",
    );
    const [ctx, cancel] = pipeline.createContext().withTimeoutAndCancel(15_000);
    ctxCancels.push(cancel);
    const toolResults = [];
    bridge = pipeline.createHostToolsMcpBridge([
      { name: "Read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] } },
    ], {
      execute: async call => {
        const result = await pipeline.executeDeferredToolCall(ctx, { toolName: call.name, toolCallId: call.toolCallId, args: call.args }, { Read: readTool }, interaction, {}, undefined, {}, undefined, Promise.resolve(call.args));
        const part = result.content[0];
        toolResults.push(part);
        return { content: part.experimental_content, isError: result.providerOptions?.cursor?.highLevelToolCallResult?.isError === true };
      },
    }, ctx.signal);
    client = new Client({ name: "image-read-test", version: "1" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await bridge.config.instance.connect(serverTransport);
    await client.connect(clientTransport);
    for (const fixture of fixtures) {
      for (const name of [fixture.name, `extensionless-${fixture.name.split(".")[0]}`]) {
        const filePath = path.join(directory, name);
        await writeFile(filePath, fixture.bytes);
        const raw = await readExecutor.execute(ctx, new pipeline.ReadArgs({ path: filePath, offset: 1, limit: 1, toolCallId: name }));
        assert.equal(raw.result.case, "success");
        assert.equal(raw.result.value.output.case, "data");
        assert.deepEqual(Buffer.from(raw.result.value.output.value), fixture.bytes);
        assert.equal(raw.result.value.rangeApplied, false);
        const result = await client.callTool({ name: "Read", arguments: { path: filePath, offset: 1, limit: 1 } });
        assert.equal(result.isError, false);
        const images = result.content.filter(part => part.type === "image");
        assert.equal(images.length, 1);
        assert.equal(images[0].mimeType, fixture.mimeType);
        assert.deepEqual(Buffer.from(images[0].data, "base64"), fixture.bytes);
        const texts = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        assert.match(texts, /Read image file:/);
        assert.doesNotMatch(texts, /IHDR|IDAT|JFIF|\ufffd/);
        assert.equal(toolResults.at(-1).experimental_content.filter(part => part.type === "image").length, 1);
      }
    }
    assert.equal(recorded.size, 6);
    assert.ok(events.length >= 12);
    const textPath = path.join(directory, "sample.txt");
    await writeFile(textPath, "alpha\nbeta\ngamma");
    const text = await readExecutor.execute(ctx, new pipeline.ReadArgs({ path: textPath, offset: 1, limit: 1, toolCallId: "text" }));
    assert.deepEqual(text.result.value.output, { case: "content", value: "beta" });
    assert.equal(text.result.value.rangeApplied, true);
  } finally {
    await client?.close();
    await bridge?.close();
    for (const cancel of ctxCancels) cancel();
    await daemon?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
