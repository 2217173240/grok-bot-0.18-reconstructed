import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createOpenAI } from "@ai-sdk/openai";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

test("真实 AI SDK HTTP 流保留缓存元数据并计算 provider 用量", { timeout: 20_000 }, async t => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/provider-cache-"));
  try {
    const outfile = path.join(directory, "provider.mjs");
    await build({ entryPoints: [path.join(root, "source/host/extensions/inference/provider-session.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    const { chatCompletionsExecutor } = await import(pathToFileURL(outfile).href);
    for (const provider of ["openrouter", "command-code"]) {
      for (const [name, cached, expectedCache] of [
        ["包含缓存", 60, 60],
        ["缺少缓存", undefined, 0],
        ["空值缓存", null, 0],
        ["零值缓存", 0, 0],
        ["负值缓存", -5, 0],
        ["全部缓存", 100, 100],
        ["超过输入数量", 150, 100],
        ["无效字符串", "60", null],
      ]) {
        await t.test(`${provider} ${name}`, async () => {
          const requests = [];
          const server = createServer(async (request, response) => {
            const body = [];
            for await (const chunk of request) body.push(chunk);
            requests.push({ method: request.method, url: request.url, body: JSON.parse(Buffer.concat(body).toString()) });
            response.writeHead(200, { "content-type": "text/event-stream" });
            const base = { id: "cache-request", object: "chat.completion.chunk", created: 1, model: "local-cache-model" };
            response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "完成" }, finish_reason: null }] })}\n\n`);
            response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
            response.end(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }) } })}\n\ndata: [DONE]\n\n`);
          });
          await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          });
          try {
            const model = createOpenAI({ apiKey: "local-test", baseURL: `http://127.0.0.1:${server.address().port}/v1`, compatibility: "compatible", name: provider }).chat("local-cache-model");
            const recorded = [];
            const result = chatCompletionsExecutor(provider, model, [{ role: "user", content: "计算用量" }], "cache-test", undefined, usage => recorded.push(usage));
            const consume = async () => {
              let text = "";
              for await (const chunk of result.fullStream) if (chunk.type === "text-delta") text += chunk.textDelta;
              return text;
            };
            if (expectedCache === null) {
              await assert.rejects(consume());
              await assert.rejects(result.extendedUsage);
              assert.deepEqual(recorded, []);
            } else {
              assert.equal(await consume(), "完成");
              assert.deepEqual(await result.usage, { promptTokens: 100, completionTokens: 7, totalTokens: 107 });
              const metadata = await result.providerMetadata;
              assert.equal(metadata?.openai?.cachedPromptTokens, cached == null ? undefined : cached);
              const expected = { inputTokens: 100 - expectedCache, outputTokens: 7, cacheReadTokens: expectedCache, cacheWriteTokens: 0, maxTokens: 0 };
              assert.deepEqual(await result.extendedUsage, expected);
              assert.deepEqual(recorded, [expected]);
              assert.equal(expected.inputTokens + expected.cacheReadTokens, 100);
              assert.equal((await result.response).messages[0].content[0].text, "完成");
            }
            assert.equal(requests.length, 1);
            assert.equal(requests[0].method, "POST");
            assert.equal(requests[0].url, "/v1/chat/completions");
            assert.equal(requests[0].body.stream, true);
            assert.equal(requests[0].body.model, "local-cache-model");
          } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
          }
        });
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
