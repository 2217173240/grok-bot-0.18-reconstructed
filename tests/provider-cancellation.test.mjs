import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { transform } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadCodexTransport() {
  const source = await readFile(path.join(repoRoot, "source/host/extensions/inference/codex-direct-responses.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("pre-cancelled Codex transport performs no HTTP request", async () => {
  const { streamCodexDirectResponses } = await loadCodexTransport();
  const server = createServer(() => { throw new Error("pre-cancelled request reached the server"); });
  const port = await listen(server);
  const controller = new AbortController();
  controller.abort(new Error("cancel before dispatch"));
  try {
    await assert.rejects(
      (async () => { for await (const _event of streamCodexDirectResponses({ fetch, endpoint: `http://127.0.0.1:${port}`, model: "test", instructions: "test", input: [], signal: controller.signal })) {} })(),
      (error) => error?.name === "Error" || error?.name === "AbortError",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Codex transport aborts a real local HTTP stream and closes its reader", async () => {
  const { streamCodexDirectResponses } = await loadCodexTransport();
  let request;
  let requestClosed;
  const server = createServer((_req, res) => {
    request = res;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    requestClosed = new Promise((resolve) => res.once("close", resolve));
  });
  const port = await listen(server);
  const controller = new AbortController();
  const iterator = streamCodexDirectResponses({ fetch, endpoint: `http://127.0.0.1:${port}`, model: "test", instructions: "test", input: [], signal: controller.signal });
  try {
    const first = await iterator.next();
    assert.deepEqual(first.value, { type: "text-delta", delta: "partial" });
    controller.abort(new Error("cancel during stream"));
    await assert.rejects(iterator.next(), (error) => error?.name === "AbortError" || error?.message === "cancel during stream");
    await Promise.race([requestClosed, new Promise((_, reject) => setTimeout(() => reject(new Error("HTTP response stayed open")), 2_000))]);
    assert.equal(request.destroyed, true);
  } finally {
    await iterator.return();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("提前结束 Codex iterator 关闭真实 HTTP 流", { timeout: 5_000 }, async () => {
  const { streamCodexDirectResponses } = await loadCodexTransport();
  let connectionClosed;
  const server = createServer((_request, response) => {
    connectionClosed = new Promise(resolve => response.once("close", resolve));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
  });
  const port = await listen(server);
  const iterator = streamCodexDirectResponses({ fetch, endpoint: `http://127.0.0.1:${port}`, model: "test", instructions: "test", input: [] });
  try {
    await iterator.next();
    await iterator.return();
    await connectionClosed;
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
