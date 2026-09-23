import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

async function loadModule(directory, entry, name) {
  const outfile = path.join(directory, name);
  await build({ entryPoints: [path.join(root, entry)], bundle: true, format: "esm", packages: "external", platform: "node", outfile, logLevel: "silent" });
  return await import(pathToFileURL(outfile).href);
}

function pdfFixture(text) {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 16 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output);
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output);
}

async function readOverDaemon(client, execPb, readPb, filePath, offset, limit) {
  const request = new execPb.ExecServerMessage({
    id: 1,
    message: { case: "readArgs", value: new readPb.ReadArgs({ path: filePath, toolCallId: "pdf-test", ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) }) },
  });
  for await (const element of client.exec(request, { timeoutMs: 5_000 })) {
    const message = element.element;
    if (message.case !== "execClientMessage") continue;
    if (message.value.message.case === "throw") throw new Error(message.value.message.value.error);
    if (message.value.message.case === "readResult") return message.value.message.value;
  }
  throw new Error("Read response is missing");
}

test("PDF Read returns real bytes and extracts text while text Read keeps its range", async () => {
  const directory = await mkdtemp(path.join(root, ".tmp-pdf-read-"));
  const workspace = await mkdtemp(path.join(root, ".tmp-pdf-workspace-"));
  let daemon;
  try {
    const server = await loadModule(directory, "source/box-exec-daemon/server.ts", "server.mjs");
    const extractor = await loadModule(directory, "source/host/runner/pdf-text-extractor.ts", "extractor.mjs");
    const readToolModule = await loadModule(directory, "source/packages/agent/tools/core/read/read.ts", "read-tool.mjs");
    const contextModule = await loadModule(directory, "source/packages/context/core.ts", "context.mjs");
    const service = await loadModule(directory, "source/packages/proto/generated/agent/v1/exec_service_connect.ts", "service.mjs");
    const execPb = await loadModule(directory, "source/packages/proto/generated/agent/v1/exec_pb.ts", "exec-pb.mjs");
    const readPb = await loadModule(directory, "source/packages/proto/generated/agent/v1/read_exec_pb.ts", "read-pb.mjs");
    const pdfPath = path.join(workspace, "sample.pdf");
    const textPath = path.join(workspace, "sample.txt");
    const pdf = pdfFixture("Readable PDF text");
    await writeFile(pdfPath, pdf);
    await writeFile(textPath, "alpha\nbeta\ngamma");
    daemon = await server.startBoxExecDaemon({ port: 0, authToken: "pdf-read-token", workspaceRoot: workspace });
    const client = createClient(service.ExecService, createConnectTransport({
      httpVersion: "1.1",
      baseUrl: daemon.url,
      useBinaryFormat: true,
      interceptors: [next => async request => {
        request.header.set("Authorization", "Bearer pdf-read-token");
        return await next(request);
      }],
    }));

    const result = await readOverDaemon(client, execPb, readPb, pdfPath, 1, 1);
    assert.equal(result.result.case, "success");
    assert.equal(result.result.value.output.case, "data");
    assert.deepEqual(Buffer.from(result.result.value.output.value), pdf);
    assert.equal(result.result.value.fileSize, BigInt(pdf.length));
    assert.equal(result.result.value.rangeApplied, false);
    assert.match(await extractor.extractPdfText(result.result.value.output.value), /Readable PDF text/);

    const resourceAccessor = {
      get: () => ({ execute: async (_context, args) => await readOverDaemon(client, execPb, readPb, args.path, args.offset, args.limit) }),
    };
    const readTool = readToolModule.createReadTool(resourceAccessor, {}, "latest", { pdfTextExtractor: extractor.extractPdfText });
    const context = contextModule.createContext();
    const interactionHandler = {
      emitPartialToolCall() {},
      executeToolCall: async (ctx, _call, _id, execute) => await execute(ctx),
    };
    const runReadTool = async () => await readTool.execute(context, interactionHandler, (async function* () { yield JSON.stringify({ path: pdfPath }); })(), { toolCallId: "pdf-test" });
    const firstToolRead = await runReadTool();
    assert.equal(firstToolRead.result.case, "success");
    assert.match(firstToolRead.result.value.output.value, /Readable PDF text/);

    const text = await readOverDaemon(client, execPb, readPb, textPath, 1, 1);
    assert.equal(text.result.case, "success");
    assert.deepEqual(text.result.value.output, { case: "content", value: "beta" });
    assert.equal(text.result.value.totalLines, 3);
    assert.equal(text.result.value.rangeApplied, true);

    const changed = pdfFixture("Updated PDF text");
    await writeFile(pdfPath, changed);
    const updated = await readOverDaemon(client, execPb, readPb, pdfPath);
    assert.equal(updated.result.case, "success");
    assert.match(await extractor.extractPdfText(updated.result.value.output.value), /Updated PDF text/);
    const secondToolRead = await runReadTool();
    assert.equal(secondToolRead.result.case, "success");
    assert.match(secondToolRead.result.value.output.value, /Updated PDF text/);
  } finally {
    await daemon?.stop();
    await rm(directory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
