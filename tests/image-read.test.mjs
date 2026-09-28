import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import png from "@jimp/js-png";
import jpeg from "@jimp/js-jpeg";
import gif from "@jimp/js-gif";
import bmp from "@jimp/js-bmp";
import tiff from "@jimp/js-tiff";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

test("图片经过 daemon、Read、tool-stream 和 MCP 后返回有效且符合大小限制的 PNG", async () => {
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
          'export { InMemoryBlobStore, getBlobId } from "./source/packages/agent-kv/blob-store.ts";',
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
      { name: "animation.gif", bytes: await gif().encode({ ...bitmap, data: Buffer.from(bitmap.data) }), mimeType: "image/gif" },
      { name: "bitmap.bmp", bytes: bmp().encode({ ...bitmap, data: Buffer.from(bitmap.data) }), mimeType: "image/bmp" },
      { name: "scan.tiff", bytes: tiff().encode(bitmap), mimeType: "image/tiff" },
      { name: "picture.webp", bytes: await sharp(fixture16).webp().toBuffer(), mimeType: "image/webp" },
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
    const [ctx, cancel] = pipeline.createContext().withTimeoutAndCancel(30_000);
    ctxCancels.push(cancel);
    const toolResults = [];
    const blobStore = new pipeline.InMemoryBlobStore();
    bridge = pipeline.createHostToolsMcpBridge([
      { name: "Read", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] } },
    ], {
      execute: async call => {
        const result = await pipeline.executeDeferredToolCall(ctx, { toolName: call.name, toolCallId: call.toolCallId, args: call.args }, { Read: readTool }, interaction, { stateHandler: { getBlobStore: () => blobStore } }, undefined, {}, undefined, Promise.resolve(call.args));
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
        assert.equal(images[0].mimeType, "image/png");
        const imageBytes = Buffer.from(images[0].data, "base64");
        assert.deepEqual(Buffer.from(await blobStore.getBlob(ctx, await pipeline.getBlobId(imageBytes))), imageBytes);
        const decoded = await sharp(imageBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.equal(decoded.info.width, bitmap.width);
        assert.equal(decoded.info.height, bitmap.height);
        assert.ok(imageBytes.length <= 1024 * 1024);
        const expectedInput = fixture.mimeType === "image/bmp" ? png().encode(bmp().decode(fixture.bytes)) : fixture.bytes;
        const expectedPixels = await sharp(expectedInput).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer();
        assert.deepEqual(decoded.data, expectedPixels);
        assert.equal((await sharp(imageBytes).metadata()).depth, "uchar");
        assert.deepEqual(await readFile(filePath), fixture.bytes);
        const texts = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        assert.match(texts, /Read image file:/);
        assert.doesNotMatch(texts, /IHDR|IDAT|JFIF|\ufffd/);
        assert.equal(toolResults.at(-1).experimental_content.filter(part => part.type === "image").length, 1);
      }
    }
    assert.equal(recorded.size, fixtures.length * 2);
    assert.ok(events.length >= fixtures.length * 4);
    const largeBytes = await sharp(randomBytes(1600 * 900 * 3), { raw: { width: 1600, height: 900, channels: 3 } }).png().toBuffer();
    assert.ok(largeBytes.length > 1024 * 1024);
    const largePath = path.join(directory, "large.png");
    await writeFile(largePath, largeBytes);
    const largeResult = await client.callTool({ name: "Read", arguments: { path: largePath } });
    assert.equal(largeResult.isError, false);
    const largeImage = largeResult.content.find(part => part.type === "image");
    assert.equal(largeImage.mimeType, "image/png");
    const resizedBytes = Buffer.from(largeImage.data, "base64");
    assert.ok(resizedBytes.length <= 1024 * 1024);
    const resizedMetadata = await sharp(resizedBytes).metadata();
    assert.ok(resizedMetadata.width <= 1024 && resizedMetadata.height <= 1024);
    assert.deepEqual(await readFile(largePath), largeBytes);
    for (const [name, bytes] of [
      ["damaged.png", fixture16.subarray(0, 100)],
      ["damaged-extensionless", fixture16.subarray(0, 100)],
      ["damaged.webp", fixtures.at(-1).bytes.subarray(0, 40)],
      ["invalid.heic", Buffer.from("invalid image")],
    ]) {
      const filePath = path.join(directory, name);
      await writeFile(filePath, bytes);
      const result = await client.callTool({ name: "Read", arguments: { path: filePath } });
      assert.equal(result.isError, true);
      assert.equal(result.content.some(part => part.type === "image"), false);
      assert.match(result.content.map(part => part.text).join("\n"), /Cannot read image file/);
    }
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
