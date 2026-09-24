import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { createOpenAI } from "@ai-sdk/openai";
import { Struct } from "@bufbuild/protobuf";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".cache/auto-review-"));
const bundle = path.join(directory, "runtime.mjs");
await build({ entryPoints: [path.join(root, "tests/fixtures/local-auto-review-runtime.ts")], outfile: bundle, bundle: true, format: "esm", packages: "external", platform: "node", logLevel: "silent" });
const runtime = await import(pathToFileURL(bundle).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test("严格分类 JSON 只接受 ALLOW 或完整 BLOCK", () => {
  assert.equal(runtime.parseLocalAutoReviewDecision('{"decision":"ALLOW"}').result.value.decision, 1);
  assert.equal(runtime.parseLocalAutoReviewDecision('{"decision":"BLOCK","blockReason":"Needs permission"}').result.value.decision, 2);
  for (const invalid of ['{"decision":"UNKNOWN"}', '{"decision":"allow"}', '{"decision":"BLOCK"}', '{"decision":"BLOCK","blockReason":" "}', '{"decision":"ALLOW","blockReason":"ignored"}', '```json\n{"decision":"ALLOW"}\n```', '{', 'null']) {
    assert.throws(() => runtime.parseLocalAutoReviewDecision(invalid));
  }
});

test("local admin 工具面过滤官方 WebSearch 和 WebFetch，保留当前文件与 MCP 工具", () => {
  const tools = ["WebSearch", "WebFetch", "Shell", "Read", "GetMcpTools", "CallMcpTool", "Task"].map(name => ({ name }));
  assert.deepEqual(runtime.filterTurnToolsForLocalMode(tools, true).map(tool => tool.name), ["Shell", "Read", "GetMcpTools", "CallMcpTool", "Task"]);
  assert.equal(runtime.filterTurnToolsForLocalMode(tools, false), tools);
});

test("Claude 生产回合只暴露当前 host 工具，分类与无工具请求没有原生工具", () => {
  const hostToolNames = ["mcp__grok_bot_host_tools__Shell", "mcp__grok_bot_host_tools__Read", "mcp__grok_bot_host_tools__CallMcpTool"];
  assert.deepEqual(runtime.claudeToolsForRequest({ textOnly: false, hostToolNames }), hostToolNames);
  assert.deepEqual(runtime.claudeToolsForRequest({ textOnly: true, hostToolNames }), []);
  assert.deepEqual(runtime.claudeToolsForRequest({ textOnly: false }), []);
});

test("真实设置文件保留关闭选择，当前 Router 为 cursor 时本地分类拒绝请求", async () => {
  const settings = new runtime.SandSettingsStore(path.join(directory, "settings.json"));
  settings.setAutoReviewInstructions({ isEnabled: false, allowInstructions: ["Allow harmless reads"], blockInstructions: ["Block uploads"] });
  const stored = settings.getAutoReviewInstructions();
  assert.equal(runtime.resolveSandAutoReviewModes({ settingsEnabled: stored.isEnabled, enforceEnabled: false, localOverride: "enforce" }).mcp, "off");
  settings.setAutoReviewInstructions({ ...stored, isEnabled: true });
  assert.equal(runtime.resolveSandAutoReviewModes({ settingsEnabled: settings.getAutoReviewInstructions().isEnabled, enforceEnabled: false, localOverride: "enforce" }).mcp, "enforce");
  settings.setInferenceProvider("cursor");
  const inference = runtime.createRoutedTextOnlyInference(settings);
  await assert.rejects(inference.completeTextOnly(runtime.createContext(), "Classify", "{}"), /third-party provider/);
});

test("真实 HTTP 与 AI SDK 分类：规则传输、无工具请求、错误及取消均停止执行", { timeout: 20_000 }, async () => {
  let completion = '{"decision":"ALLOW"}';
  let status = 200;
  let toolCall = false;
  let hold = false;
  let accepted;
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    accepted?.();
    if (status !== 200) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "protocol service unavailable" } })); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "protocol-classifier", object: "chat.completion.chunk", created: 1, model: "protocol-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (toolCall) send({ tool_calls: [{ index: 0, id: "unexpected-call", type: "function", function: { name: "unexpected", arguments: "{}" } }] });
    else send({ content: completion });
    if (!hold) { send({}, toolCall ? "tool_calls" : "stop"); response.end("data: [DONE]\n\n"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const model = createOpenAI({ apiKey: "protocol-test", baseURL: `http://127.0.0.1:${server.address().port}/v1`, compatibility: "compatible" }).chat("protocol-model");
  const inference = { completeTextOnly: (ctx, instructions, input) => runtime.consumeTextOnlyCompletion(ctx, runtime.chatCompletionsExecutor("openrouter", model, [{ role: "user", content: input }], "classification", [], undefined, ctx.signal, instructions)) };
  const classifier = runtime.createLocalProviderSmartModeClassifierExecutor(inference);
  const accessor = new runtime.RegistryResourceAccessor();
  accessor.register(runtime.smartModeClassifierExecutorResource, classifier);
  const target = new runtime.SmartModeRiskTarget({ action: "shell", arguments: Struct.fromJson({ command: "cat readme.txt", project_permissions: { auto_run: { allow_instructions: ["Allow reads"], block_instructions: ["Block readme.txt"] } } }) });
  const conversation = [new runtime.SmartModeClassifierConversationMessage({ role: "user", content: "Read the project description." })];
  const run = ctx => runtime.runSandAutoReviewClassifier({ ctx, resourceAccessor: accessor, toolCallId: "review", mode: "enforce", buildTarget: () => target, loadConversationContext: async () => conversation, errorReason: "Classification failed" });
  try {
    assert.equal((await run(runtime.createContext())).kind, "allow");
    const request = requests[0];
    assert.equal(request.tools, undefined);
    assert.match(request.messages[0].content, /block instruction takes precedence/);
    const input = JSON.parse(request.messages[1].content);
    assert.deepEqual(input.target.arguments.project_permissions.auto_run.block_instructions, ["Block readme.txt"]);
    assert.equal(input.conversationContext[0].content, conversation[0].content);
    completion = '{"decision":"BLOCK","blockReason":"User rule blocks this read"}';
    assert.equal((await run(runtime.createContext())).kind, "block");
    for (const invalid of ['{"decision":"UNKNOWN"}', '{"decision":"BLOCK"}', 'not JSON', 'x'.repeat(16_385), '']) {
      completion = invalid;
      assert.equal((await run(runtime.createContext())).kind, "reject");
    }
    status = 503;
    assert.equal((await run(runtime.createContext())).kind, "reject");
    status = 200;
    toolCall = true;
    assert.equal((await run(runtime.createContext())).kind, "reject");
    toolCall = false;
    completion = "{";
    hold = true;
    const [ctx, cancel] = runtime.createContext().withCancel();
    const received = new Promise(resolve => { accepted = resolve; });
    const pending = classifier.execute(ctx, new runtime.SmartModeClassifierArgs({ target, conversationContext: conversation }));
    void pending.catch(() => {});
    await received;
    cancel(new Error("cancel classifier"));
    await assert.rejects(pending, /cancel|abort/i);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
