import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createProviderPromptSession } from "../source/host/extensions/inference/provider-session.ts";
import { createSubagentRuntime } from "../source/host/runner/subagent-runtime.ts";
import { SandSubagentHostAdapter } from "../source/host/runner/agent-adapters.ts";
import { createContext } from "../source/packages/context/core.ts";

// 用 esbuild 打包后，在仅挂载推理凭据的隔离 Linux 容器运行。
if (process.platform !== "linux" || !existsSync("/.dockerenv")) throw new Error("Foreground Task acceptance requires an isolated Linux container");
const marker = `foreground-${randomUUID()}`;
const [ctx, cancel] = createContext().withTimeoutAndCancel(240_000);
let childRuns = 0;
let taskCalls = 0;
let notifications = 0;
const runtime = createSubagentRuntime({
  getConversationId: () => marker,
  resolveBoxId: () => marker,
  emitAsyncTasksChanged() {},
  computerUse: { freeWindow() {} },
});
runtime.setBackgroundSubagentHandler(() => { notifications++; });
const adapter = new SandSubagentHostAdapter(runtime.sessions, () => {
  const [childCtx, cancelChild] = ctx.withTimeoutAndCancel(120_000);
  let outline = [];
  return {
    async run(prompt) {
      childRuns++;
      const result = createProviderPromptSession("claude-code").getExecutor([{ role: "user", content: prompt }]).stream(childCtx, `${marker}-child`, []);
      try {
        for await (const _part of result.fullStream) {}
        const response = await result.response;
        outline = response.messages;
        const text = response.messages.filter(message => message.role === "assistant").flatMap(message => message.content).filter(part => part.type === "text").map(part => part.text).join("\n");
        return { text, aborted: false };
      } finally { cancelChild(); }
    },
    interrupt: () => cancelChild(),
    getResolvedOutline: async () => outline,
    getObservedToolCallCount: () => 0,
    getActivitySnapshot: () => [],
    getTranscriptPath: () => null,
  };
}, {
  isRunning: runtime.isRunning,
  allocateComputerUseWindow() { throw new Error("Text subagent unexpectedly requested a desktop"); },
  freeComputerUseWindow() {},
  dispatch: runtime.dispatchBackgroundSubagent,
  dispatchForeground: runtime.dispatchForegroundSubagent,
  abort: runtime.abortSubagent,
});
try {
  const root = createProviderPromptSession("claude-code").getExecutor([{ role: "user", content: `Call mcp__grok_bot_host_tools__Task exactly once with prompt "Reply with exactly ${marker}. Do not use any tools." Wait for its result, then repeat that result in your final response. Use this host MCP tool for the task.` }]);
  const result = root.stream(ctx, marker, [{ name: "Task", description: "Run a foreground text subagent and return its completed result.", inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"], additionalProperties: false } }], {
    hostToolExecution: { async execute(call) {
      taskCalls++;
      assert.equal(call.name, "Task");
      const args = { prompt: call.args.prompt, subagentType: "generalPurpose", toolCallId: call.toolCallId };
      const id = await adapter.createOrResumeSession(ctx, args);
      const outcome = await adapter.runSession(ctx, id, args);
      assert.equal(outcome.status, "success");
      assert.ok(outcome.finalMessage.includes(marker));
      return { content: [{ type: "text", text: outcome.finalMessage }], isError: false };
    } },
  });
  for await (const _part of result.fullStream) {}
  const response = await result.response;
  const finalText = response.messages.filter(message => message.role === "assistant").flatMap(message => message.content).filter(part => part.type === "text").map(part => part.text).join("\n");
  assert.equal(taskCalls, 1);
  assert.equal(childRuns, 1);
  assert.equal(notifications, 0);
  assert.equal(runtime.hasRunningSubagents(), false);
  assert.ok(finalText.includes(marker));
  console.log(JSON.stringify({ ok: true, taskCalls, childRuns, notifications, returnedToParent: true }));
} finally { cancel(); }
