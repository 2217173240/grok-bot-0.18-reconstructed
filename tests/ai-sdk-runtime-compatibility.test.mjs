import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createOpenAI } from "@ai-sdk/openai";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".cache/ai-sdk-compat-"));
const outfile = path.join(directory, "provider.mjs");
await build({ entryPoints: [path.join(root, "source/host/extensions/inference/provider-session.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
const { chatCompletionsExecutor } = await import(outfile);
test.after(() => rm(directory, { recursive: true, force: true }));

test("AI SDK HTTP 工具输入、流式参数和返回消息保持内部协议", { timeout: 20_000 }, async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "tools-response", object: "chat.completion.chunk", created: 1, model: "local" };
    for (const delta of [
      { role: "assistant", tool_calls: [{ index: 0, id: "next-call", type: "function", function: { name: "lookup", arguments: '{"query":' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '"next"}' } }] },
    ]) response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 } } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const model = createOpenAI({ apiKey: "local-test", baseURL: `http://127.0.0.1:${server.address().port}/v1` }).chat("local");
    const messages = [
      { role: "user", content: [{ type: "text", text: "查看图片" }, { type: "image", image: new Uint8Array([1, 2, 3]), mimeType: "image/png" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "previous-call", toolName: "lookup", args: { query: "previous" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "previous-call", toolName: "lookup", result: { found: true } }] },
    ];
    const result = chatCompletionsExecutor("openrouter", model, messages, "tools", [{ name: "lookup", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }]);
    const events = [];
    for await (const event of result.fullStream) events.push(event);
    assert.equal(requests.length, 1);
    const body = requests[0];
    assert.equal(body.tools[0].function.parameters.properties.query.type, "string");
    assert.equal(body.messages[1].content[1].image_url.url, "data:image/png;base64,AQID");
    assert.equal(body.messages[2].tool_calls[0].function.arguments, '{"query":"previous"}');
    assert.equal(body.messages[3].content, '{"found":true}');
    assert.deepEqual(events.filter(event => event.type === "tool-call-streaming-start"), [{ type: "tool-call-streaming-start", toolCallId: "next-call", toolName: "lookup" }]);
    assert.equal(events.filter(event => event.type === "tool-call-delta").map(event => event.argsTextDelta).join(""), '{"query":"next"}');
    assert.deepEqual(events.find(event => event.type === "tool-call").args, { query: "next" });
    assert.deepEqual((await result.response).messages[0].content.find(part => part.type === "tool-call").args, { query: "next" });
    assert.deepEqual(await result.usage, { promptTokens: 12, completionTokens: 4, totalTokens: 16 });
    assert.deepEqual(events.find(event => event.type === "finish").usage, await result.usage);
    assert.deepEqual(await result.extendedUsage, { inputTokens: 7, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2, maxTokens: 0 });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("AI SDK HTTP 消费者提前结束会终止连接并拒绝未完成结果", { timeout: 20_000 }, async () => {
  const closed = Promise.withResolvers();
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.once("close", closed.resolve);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "cancel", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta: { role: "assistant", content: "开始" }, finish_reason: null }] })}\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const model = createOpenAI({ apiKey: "local-test", baseURL: `http://127.0.0.1:${server.address().port}/v1` }).chat("local");
    const result = chatCompletionsExecutor("command-code", model, [{ role: "user", content: "继续" }], "cancel");
    for await (const event of result.fullStream) if (event.type === "text-delta") break;
    await closed.promise;
    await assert.rejects(result.response);
    await assert.rejects(result.usage);
    await assert.rejects(result.extendedUsage);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
