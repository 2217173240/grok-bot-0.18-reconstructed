import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { createOpenAI } from "@ai-sdk/openai";
import { MethodKind, Struct } from "@bufbuild/protobuf";
import { createPromiseClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".cache/auto-review-"));
const bundle = path.join(directory, "runtime.mjs");
await build({ entryPoints: [path.join(root, "tests/fixtures/local-auto-review-runtime.ts")], outfile: bundle, bundle: true, format: "esm", packages: "external", platform: "node", logLevel: "silent" });
const runtime = await import(pathToFileURL(bundle).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test("真实分类请求分别记录自动审查耗时，诊断文件错误保持原判定", { timeout: 10_000 }, async t => {
  const privateValue = randomUUID();
  const dataRoot = await mkdtemp(path.join(directory, "timing-"));
  const previous = Object.fromEntries(["SAND_DATA_ROOT", "SAND_LOCAL_ADMIN", "SAND_DISABLE_TELEMETRY"].map(key => [key, process.env[key]]));
  Object.assign(process.env, { SAND_DATA_ROOT: dataRoot, SAND_LOCAL_ADMIN: "1", SAND_DISABLE_TELEMETRY: "1" });
  let scenario = "ALLOW";
  let accepted;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    if (scenario === "cancel") { accepted(); return; }
    if (scenario === "failure") { res.writeHead(400); res.end(JSON.stringify({ error: { message: privateValue } })); return; }
    const content = scenario === "invalid" ? privateValue : JSON.stringify({ decision: scenario, ...(scenario === "BLOCK" ? { blockReason: privateValue } : {}) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "classification", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const model = createOpenAI({ apiKey: "local-protocol", baseURL: `http://127.0.0.1:${server.address().port}/v1`, compatibility: "compatible" }).chat("local");
  const inference = { completeTextOnly: (ctx, instructions, input) => runtime.consumeTextOnlyCompletion(ctx, runtime.chatCompletionsExecutor("openrouter", model, [{ role: "user", content: input }], randomUUID(), [], undefined, ctx.signal, instructions)) };
  const accessor = new runtime.RegistryResourceAccessor();
  accessor.register(runtime.smartModeClassifierExecutorResource, runtime.createLocalProviderSmartModeClassifierExecutor(inference));
  const run = ctx => runtime.runSandAutoReviewClassifier({ ctx, resourceAccessor: accessor, toolCallId: randomUUID(), mode: "enforce", buildTarget: () => new runtime.SmartModeRiskTarget({ action: "shell", arguments: Struct.fromJson({ command: privateValue }) }), loadConversationContext: async () => [new runtime.SmartModeClassifierConversationMessage({ role: "user", content: privateValue })], errorReason: "Classification failed" });
  const ledger = path.join(dataRoot, "local-intercept.jsonl");
  try {
    for (const [value, kind] of [["ALLOW", "allow"], ["BLOCK", "block"], ["invalid", "reject"], ["failure", "reject"]]) {
      scenario = value;
      assert.equal((await run(runtime.createContext())).kind, kind);
    }
    scenario = "cancel";
    const received = new Promise(resolve => { accepted = resolve; });
    const [ctx, cancel] = runtime.createContext().withCancel();
    const pending = run(ctx);
    void pending.catch(() => {});
    await Promise.race([received, pending.then(() => { throw new Error("Classifier finished before accepting cancellation fixture"); })]);
    cancel(new Error("Cancel classification"));
    await assert.rejects(pending, { name: "AbortError" });
    const raw = await readFile(ledger, "utf8");
    assert.equal(raw.includes(privateValue), false);
    const rows = raw.trim().split("\n").map(JSON.parse).filter(row => row.phase === "classifier");
    assert.deepEqual(rows.map(row => row.outcome), ["success", "success", "failed", "failed", "cancelled"]);
    assert.ok(rows.every(row => row.mode === "text-only" && Number.isFinite(row.durationMs) && row.durationMs >= 0));
    scenario = "ALLOW";
    process.env.SAND_DISABLE_TELEMETRY = "0";
    assert.equal((await run(runtime.createContext())).kind, "allow");
    assert.equal(await readFile(ledger, "utf8"), raw);
    process.env.SAND_DISABLE_TELEMETRY = "1";
    const notDirectory = path.join(dataRoot, "file");
    await writeFile(notDirectory, "private diagnostic fixture");
    process.env.SAND_DATA_ROOT = notDirectory;
    assert.equal((await run(runtime.createContext())).kind, "allow");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("严格分类 JSON 只接受 ALLOW 或完整 BLOCK", () => {
  assert.equal(runtime.parseLocalAutoReviewDecision('{"decision":"ALLOW"}').result.value.decision, 1);
  assert.equal(runtime.parseLocalAutoReviewDecision('{"decision":"BLOCK","blockReason":"Needs permission"}').result.value.decision, 2);
  for (const invalid of ['{"decision":"UNKNOWN"}', '{"decision":"allow"}', '{"decision":"BLOCK"}', '{"decision":"BLOCK","blockReason":" "}', '{"decision":"ALLOW","blockReason":"ignored"}', '```json\n{"decision":"ALLOW"}\n```', '{', 'null']) {
    assert.throws(() => runtime.parseLocalAutoReviewDecision(invalid));
  }
});

test("分类上下文沿用消息限制并约束 Computer 历史总量", () => {
  const messages = [
    ...Array.from({ length: 10 }, (_, index) => ({ role: "user", content: `user-${index}:` + "u".repeat(5000) })),
    ...Array.from({ length: 10 }, (_, index) => ({ role: "assistant", content: `assistant-${index}:` + "a".repeat(5000) })),
    ...Array.from({ length: 100 }, (_, index) => ({ role: "computer", content: `computer-${index}:` + "c".repeat(5000) })),
  ];
  const bounded = runtime.truncateSandAutoReviewClassifierContext(messages);
  assert.ok(bounded.reduce((sum, message) => sum + message.content.length, 0) <= 32_000);
  assert.ok(bounded.every(message => message.content.length <= 4000));
  assert.equal(bounded.filter(message => message.role === "user").length, 2);
  assert.ok(bounded.some(message => message.content.startsWith("user-9:")));
  assert.ok(bounded.some(message => message.content.startsWith("computer-99:")));
});

test("Computer enforce 拒绝 screenshot 后追加需要审核的动作", () => {
  const parameters = runtime.buildComputerParameters({ mode: "enforce" });
  for (const action of [{ action: "type", text: "send" }, { action: "key", key: "ENTER" }, { action: "click", x: 1, y: 1 }, { action: "drag", x: 1, y: 1, x2: 2, y2: 2 }]) {
    assert.equal(parameters.safeParse({ action: "screenshot", then: [action] }).success, false);
  }
  assert.equal(parameters.safeParse({ action: "screenshot", then: [{ action: "wait", durationMs: 0 }] }).success, true);
});

test("Auto-review 提示说明等待当前卡片以及分类失败后停止", () => {
  const prompt = runtime.SAND_SYSTEM_PROMPT_CLOUD_AGENTS_DISABLED;
  assert.match(prompt, /host raises an approval card and waits within that tool call/);
  assert.match(prompt, /If classification fails.*stop the action and report the error/);
  assert.doesNotMatch(prompt, /approval-retry|same-tool approval retry|same-command retry|request_smart_mode_approval|requestSmartModeApproval/);
});

test("Shell BLOCK 首次调用等待人工卡片，批准后才执行真实命令", { timeout: 30_000 }, async () => {
  let completion = '{"decision":"BLOCK","blockReason":"Ask before writing the review file"}';
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "approval-classifier", object: "chat.completion.chunk", created: 1, model: "protocol-model", choices: [{ index: 0, delta: { content: completion }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const daemon = await runtime.startBoxExecDaemon({ port: 0, workspaceRoot: directory, terminalsDirectory: path.join(directory, "terminals") });
  const client = createPromiseClient({ typeName: runtime.ExecService.typeName, methods: { exec: { ...runtime.ExecService.methods.exec, kind: MethodKind.ServerStreaming } } }, createConnectTransport({ baseUrl: daemon.url, httpVersion: "1.1" }));
  const model = createOpenAI({ apiKey: "protocol-test", baseURL: `http://127.0.0.1:${server.address().port}/v1`, compatibility: "compatible" }).chat("protocol-model");
  const inference = { completeTextOnly: (ctx, instructions, input) => runtime.consumeTextOnlyCompletion(ctx, runtime.chatCompletionsExecutor("openrouter", model, [{ role: "user", content: input }], "classification", [], undefined, ctx.signal, instructions)) };
  const accessor = new runtime.RegistryResourceAccessor();
  accessor.register(runtime.smartModeClassifierExecutorResource, runtime.createLocalProviderSmartModeClassifierExecutor(inference));
  const executed = [];
  accessor.register(runtime.shellStreamExecutorResource, {
    async *execute(ctx, args) {
      executed.push(args);
      const stream = client.exec(new runtime.ExecServerMessage({ id: 1, execId: args.toolCallId, message: { case: "shellStreamArgs", value: args } }), { signal: ctx.signal, headers: { authorization: "Bearer local" } });
      for await (const event of stream) {
        if (event.element.case === "execClientMessage" && event.element.value.message.case === "shellStream") yield event.element.value.message.value;
        else if (event.element.case === "execClientControlMessage" && event.element.value.message.case === "throw") throw new Error(event.element.value.message.value.message);
      }
    },
  });
  const updates = [];
  const recorded = [];
  const interaction = new runtime.InteractionHandler({ sendUpdate: async (_ctx, update) => { updates.push(update); } }, { recordToolCall: call => { recorded.push(call); } }, "approval-test");
  const controller = new runtime.SandAutoReviewController({ agentId: "approval-test", hostGeneration: "test" });
  const gate = runtime.createAutoReviewGate({ baseModes: runtime.SAND_AUTO_REVIEW_MODES_ENFORCE, controller: () => controller, resolveBoxId: () => "local" });
  accessor.register(runtime.computerUseExecutorResource, {
    async execute(ctx, args) {
      for await (const event of client.exec(new runtime.ExecServerMessage({ id: 2, execId: args.toolCallId, message: { case: "computerUseArgs", value: args } }), { signal: ctx.signal, headers: { authorization: "Bearer local" } })) {
        if (event.element.case === "execClientMessage" && event.element.value.message.case === "computerUseResult") return event.element.value.message.value;
      }
      throw new Error("Computer executor did not return a result");
    },
  });
  const computer = runtime.createComputerTool(runtime.createHostComputerToolDependencies({
    resourceAccessor: accessor,
    autoReview: { mode: gate.currentModes().computer, agentId: "approval-test", boxIdentity: { boxId: "local", windowGeneration: "test" }, autoReviewController: controller, resolveDisplayNumber: async () => 1 },
  }));
  const state = gate.shellApprovalState("box_shell");
  const options = {
    smartModeClassifierMode: true, requestContext: { env: { smartModeClassifierAutoModeEnabled: true } },
    smartModeApprovalProvider: runtime.createSandShellApprovalProvider({ controller, agentId: "approval-test", surface: "box_shell", getExpiryPolicy: () => "park" }),
    smartModeShellApprovalState: state,
  };
  const tool = runtime.createShellTool(accessor, options);
  const streamArgs = async function* (args) { yield JSON.stringify(args); };
  const run = (id, ctx = runtime.createContext(), currentTool = tool) => currentTool.execute(ctx, interaction, streamArgs({ command: `printf approved > ${id}.txt`, working_directory: directory }), { toolCallId: id });
  const nextApproval = () => new Promise(resolve => {
    const unsubscribe = controller.subscribe(event => { if (event.type === "created") { unsubscribe(); resolve(event.approval); } });
  });
  try {
    for (const action of [{ action: "type", text: "send" }, { action: "key", key: "ENTER" }, { action: "click", x: 1, y: 1 }, { action: "drag", x: 1, y: 1, x2: 2, y2: 2 }]) {
      await assert.rejects(computer.execute({ action: "screenshot", then: [action] }, { context: runtime.createContext(), toolCallId: "computer-follow-up" }), { name: "ZodError" });
    }
    for (const resolution of ["approved", "denied", "cancelled", "expired", "changed"]) {
      const [ctx, cancel] = runtime.createContext().withCancel();
      const created = nextApproval();
      const pending = run(resolution, ctx);
      void pending.catch(() => {});
      const card = await created;
      assert.equal(card.reason, "Ask before writing the review file");
      assert.equal(card.command, `printf approved > ${resolution}.txt`);
      assert.match(card.fingerprint, /^[a-f0-9]{64}$/);
      await assert.rejects(access(path.join(directory, `${resolution}.txt`)));
      if (resolution === "cancelled") cancel(new Error("cancel review"));
      else if (resolution === "expired") controller.beginUserMessageEpoch();
      else {
        if (resolution === "changed") state.markSideEffectStart();
        controller.resolveApproval(card.id, resolution === "denied" ? "denied" : "approved");
      }
      if (resolution === "approved") {
        assert.equal((await pending).result.case, "success");
        assert.equal(await readFile(path.join(directory, "approved.txt"), "utf8"), "approved");
      } else {
        if (resolution === "denied") await assert.rejects(pending, /The user denied approval for this action/);
        else await assert.rejects(pending);
        await assert.rejects(access(path.join(directory, `${resolution}.txt`)));
      }
      assert.equal(controller.getPendingApprovals().length, 0);
      assert.equal(controller.resolveApproval(card.id, "approved"), undefined);
    }
    const readonlyTool = runtime.createShellTool(accessor, { ...options, sandboxEnabled: true, isReadonly: true });
    const readonlyCard = nextApproval();
    const readonlyResult = readonlyTool.execute(runtime.createContext(), interaction, streamArgs({ command: "pwd", working_directory: directory }), { toolCallId: "readonly" });
    controller.resolveApproval((await readonlyCard).id, "approved");
    assert.equal((await readonlyResult).result.case, "success");
    assert.equal(executed.at(-1).requestedSandboxPolicy.toJson().type, "TYPE_WORKSPACE_READONLY");
    const noProvider = runtime.createShellTool(accessor, { ...options, smartModeApprovalProvider: undefined });
    await assert.rejects(run("no-provider", runtime.createContext(), noProvider));
    assert.equal(controller.getPendingApprovals().length, 0);
    await assert.rejects(access(path.join(directory, "no-provider.txt")));
    completion = "invalid classifier response";
    await assert.rejects(run("invalid"));
    assert.equal(controller.getPendingApprovals().length, 0);
    await assert.rejects(access(path.join(directory, "invalid.txt")));
    assert.ok(updates.length > 0);
    assert.ok(recorded.length > 0);
  } finally {
    controller.expire("session_end");
    await daemon.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
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
  const session = runtime.createProviderPromptSession("claude-code");
  assert.throws(() => session.getExecutor([]).stream(runtime.createContext(), "missing-host", [{ name: "Shell" }]), /require the current host executor/);
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
  let closed;
  let responseDelayMs = 0;
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    accepted?.();
    response.once("close", () => closed?.());
    if (status !== 200) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "protocol service unavailable" } })); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "protocol-classifier", object: "chat.completion.chunk", created: 1, model: "protocol-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const finish = () => {
      if (toolCall) send({ tool_calls: [{ index: 0, id: "unexpected-call", type: "function", function: { name: "unexpected", arguments: "{}" } }] });
      else send({ content: completion });
      if (!hold) { send({}, toolCall ? "tool_calls" : "stop"); response.end("data: [DONE]\n\n"); }
    };
    if (responseDelayMs === 0) finish();
    else {
      const timer = setTimeout(finish, responseDelayMs);
      response.once("close", () => clearTimeout(timer));
    }
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
    const beforeSlow = requests.length;
    responseDelayMs = 10_100;
    assert.equal((await run(runtime.createContext())).kind, "block");
    assert.equal(requests.length - beforeSlow, 1);
    responseDelayMs = 0;
    for (const invalid of ['{"decision":"UNKNOWN"}', '{"decision":"BLOCK"}', 'not JSON', 'x'.repeat(16_385), '']) {
      completion = invalid;
      const decision = await run(runtime.createContext());
      assert.equal(decision.kind, "reject");
      assert.match(decision.reason, /invalid classification response/);
    }
    status = 503;
    const failed = await run(runtime.createContext());
    assert.equal(failed.kind, "reject");
    assert.match(failed.reason, /configured provider/);
    status = 200;
    toolCall = true;
    assert.equal((await run(runtime.createContext())).kind, "reject");
    toolCall = false;
    completion = "{";
    hold = true;
    const beforeTimeout = requests.length;
    const disconnected = new Promise(resolve => { closed = resolve; });
    const bounded = { ...classifier, executionPolicy: { timeoutMs: 1000, maxAttempts: 1 } };
    await assert.rejects(runtime.executeSmartModeClassifierWithMeasurement(runtime.createContext(), bounded, new runtime.SmartModeClassifierArgs({ target, conversationContext: conversation }), "enforce", undefined, { maxAttempts: 4 }), error => {
      assert.equal(error.kind, "timeout");
      assert.match(error.message, /timed out after 1s.*not executed/);
      return true;
    });
    await disconnected;
    assert.equal(requests.length - beforeTimeout, 1);
    closed = undefined;
    const [ctx, cancel] = runtime.createContext().withCancel();
    const received = new Promise(resolve => { accepted = resolve; });
    const pending = runtime.executeSmartModeClassifierWithMeasurement(ctx, classifier, new runtime.SmartModeClassifierArgs({ target, conversationContext: conversation }));
    void pending.catch(() => {});
    await received;
    cancel(new Error("cancel classifier"));
    await assert.rejects(pending, error => {
      assert.equal(error.name, "AbortError");
      assert.equal(error.kind, "cancelled");
      return true;
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
