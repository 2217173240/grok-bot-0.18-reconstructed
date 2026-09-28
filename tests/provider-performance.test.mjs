import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { createOpenAI } from "@ai-sdk/openai";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".cache/provider-performance-"));
const output = path.join(directory, "runtime.mjs");
await build({ entryPoints: [path.join(root, "tests/fixtures/provider-performance-runtime.ts")], outfile: output, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
const api = await import(output);
const saved = { ...process.env };
Object.assign(process.env, { SAND_DATA_ROOT: directory, SAND_LOCAL_ADMIN: "1", SAND_DISABLE_TELEMETRY: "1" });
test.after(async () => {
  for (const key of ["SAND_DATA_ROOT", "SAND_LOCAL_ADMIN", "SAND_DISABLE_TELEMETRY"]) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  await rm(directory, { recursive: true, force: true });
});
const hash = id => createHash("sha256").update(id).digest("hex").slice(0, 16);
const records = async id => (await readFile(path.join(directory, "local-intercept.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).filter(row => row.kind === "local-performance" && row.correlationHash === hash(id));
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const consume = async stream => { for await (const _chunk of stream) {} };

test("未消费的测量流不订阅取消信号", () => {
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, "abort").length;
  api.createProviderPerformance("codex", "unconsumed", "unhosted", controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, before);
});

test("真实 chat-completions HTTP 流按请求记录成功、失败、取消和缺失值", { timeout: 20000 }, async () => {
  for (const provider of ["openrouter", "command-code"]) for (const scenario of ["success", "missing-usage", "empty", "tool-only", "failed", "cancel", "return"]) {
    const id = `${provider}-${scenario}`;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {}
      if (scenario === "failed") { res.writeHead(400); res.end(JSON.stringify({ error: { message: "private-error-sentinel", type: "invalid_request_error" } })); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id, object: "chat.completion.chunk", created: 1, model: "local" };
      if (scenario === "tool-only") res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "tool-1", type: "function", function: { name: "Read", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`);
      else if (scenario !== "empty") res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "private-output-sentinel" }, finish_reason: null }] })}\n\n`);
      if (["cancel", "return"].includes(scenario)) return;
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      if (scenario === "success") res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14, prompt_tokens_details: { cached_tokens: 4 } } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    const url = await listen(server);
    const controller = new AbortController();
    try {
      const model = createOpenAI({ apiKey: "local", baseURL: `${url}/v1`, name: provider, compatibility: "compatible" }).chat("local");
      const definitions = scenario === "tool-only" ? [{ name: "Read", inputSchema: { type: "object", properties: {} } }] : undefined;
      const result = api.chatCompletionsExecutor(provider, model, [{ role: "user", content: "private-prompt-sentinel" }], id, definitions, undefined, controller.signal);
      if (["cancel", "return"].includes(scenario)) {
        const iterator = result.fullStream[Symbol.asyncIterator]();
        while ((await iterator.next()).value?.type !== "text-delta") {}
        if (scenario === "cancel") { controller.abort(); await assert.rejects(consume(iterator)); }
        else await iterator.return();
      } else if (scenario === "failed") await assert.rejects(consume(result.fullStream));
      else await consume(result.fullStream);
      const rows = await records(id);
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.equal(row.outcome, ["cancel", "return"].includes(scenario) ? "cancelled" : scenario === "failed" ? "failed" : "success");
      assert.equal(row.provider, provider);
      assert.ok(row.durationMs >= row.dispatchMs);
      if (["empty", "failed"].includes(scenario)) { assert.equal(row.firstTextMs, undefined); assert.equal(row.firstOutputMs, undefined); }
      else if (scenario === "tool-only") { assert.equal(row.firstTextMs, undefined); assert.ok(row.firstOutputMs >= row.dispatchMs); }
      else assert.ok(row.firstTextMs >= row.dispatchMs);
      if (scenario === "success") { assert.equal(row.inputTokens, 11); assert.equal(row.cacheReadTokens, 4); assert.equal(row.usageBasis, "inclusive-input"); }
      else assert.equal(row.inputTokens, undefined);
      assert.equal(row.cacheWriteTokens, undefined);
      assert.ok(!JSON.stringify(row).includes("private-"));
      if (["cancel", "return"].includes(scenario)) assert.ok(row.cancelCleanupMs >= 0);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});

test("consumer.return 的真实文件清理错误记录 failed，日志错误保留原始错误", async () => {
  const file = path.join(directory, "stream.txt");
  await writeFile(file, "content");
  const missing = path.join(directory, "missing-cleanup-target");
  const source = async function* () {
    try { for await (const chunk of createReadStream(file)) yield { type: "text-delta", textDelta: chunk.toString() }; }
    finally { await unlink(missing); }
  };
  const measured = api.createProviderPerformance("openrouter", "cleanup-error", "unhosted");
  const iterator = measured.wrap(source());
  await iterator.next();
  await assert.rejects(iterator.return(), error => error.code === "ENOENT" && error.path === missing);
  const [row] = await records("cleanup-error");
  assert.equal(row.outcome, "failed");
  assert.ok(row.cancelCleanupMs >= 0);
  const failingLog = api.createProviderPerformance("openrouter", "log-error", "unhosted").wrap(source());
  await failingLog.next();
  process.env.SAND_DATA_ROOT = file;
  try {
    await assert.rejects(failingLog.return(), error => error.code === "ENOENT" && error.path === missing);
    await consume(api.createProviderPerformance("openrouter", "successful-log-error", "unhosted").wrap(createReadStream(file)));
  }
  finally { process.env.SAND_DATA_ROOT = directory; }
  const missingRead = path.join(directory, "missing-read-target");
  const twiceFailed = {
    [Symbol.asyncIterator]() { return this; },
    async next() { return { done: false, value: await readFile(missingRead) }; },
    async return() { await unlink(missing); return { done: true }; },
  };
  await assert.rejects(api.createProviderPerformance("openrouter", "double-error", "unhosted").wrap(twiceFailed).next(), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause.code, "ENOENT");
    assert.equal(error.cause.path, missingRead);
    assert.equal(error.errors[1].path, missing);
    return true;
  });
  assert.equal((await records("double-error"))[0].outcome, "failed");
});

test("真实 Codex HTTP transport 的稀疏 usage 与请求测量", { timeout: 10000 }, async () => {
  for (const scenario of ["success", "missing", "failed", "cancel", "return"]) {
    const id = `codex-${scenario}`;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {}
      if (scenario === "failed") { res.writeHead(400); res.end("private-error-sentinel"); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.output_text.delta","delta":"private-output-sentinel"}\n\n');
      if (["return", "cancel"].includes(scenario)) return;
      res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id, output: [], ...(scenario === "success" ? { usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } : {}) } })}\n\n`);
    });
    const url = await listen(server);
    const controller = new AbortController();
    const measured = api.createProviderPerformance("codex", id, "unhosted", controller.signal);
    try {
      measured.mark("dispatchMs");
      const stream = api.streamCodexDirectResponses({ fetch, endpoint: url, model: "local", instructions: "local", input: [], signal: controller.signal, onReportedUsage: usage => measured.usage(usage, "inclusive-input") });
      const mapped = (async function* () { for await (const event of stream) yield event.type === "text-delta" ? { type: "text-delta", textDelta: event.delta } : event; })();
      const iterator = measured.wrap(mapped);
      if (scenario === "return") { await iterator.next(); await iterator.return(); }
      else if (scenario === "cancel") { await iterator.next(); controller.abort(); await assert.rejects(consume(iterator)); }
      else if (scenario === "failed") await assert.rejects(consume(iterator));
      else await consume(iterator);
      const [row] = await records(id);
      assert.equal(row.outcome, ["return", "cancel"].includes(scenario) ? "cancelled" : scenario === "failed" ? "failed" : "success");
      assert.equal(row.inputTokens, scenario === "success" ? 10 : undefined);
      assert.equal(row.cacheReadTokens, scenario === "success" ? 0 : undefined);
      assert.equal(row.cacheWriteTokens, undefined);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});
