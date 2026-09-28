import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

test("SendMessage 写入真实 transcript 后结算一次；内部文本不直接交付", async () => {
  const previousLocalAdmin = process.env.SAND_LOCAL_ADMIN;
  process.env.SAND_LOCAL_ADMIN = "1";
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/message-delivery-"));
  const output = path.join(directory, "runtime.mjs");
  await build({ entryPoints: [path.join(root, "tests/fixtures/message-delivery-runtime.ts")], outfile: output, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
  const api = await import(output);
  const store = new api.SandAgentSessionStore(path.join(directory, "agents"));
  const manager = new api.TranscriptManager(store, new api.SandUpgradeResumeStore(directory), new api.SandAckObligationStore(directory));
  const session = await store.createSession({ name: "Delivery", description: "" });
  const updates = [], recorded = [];
  const ctx = api.createContext();
  const interaction = new api.InteractionHandler({ sendUpdate: async (_ctx, update) => { updates.push(update); } }, { recordToolCall: call => { recorded.push(call); } }, "delivery");
  let lastSentMessageId;
  const runner = new api.SandAgentRunner({
    conversationId: session.id,
    transport: { onUpdate: update => { lastSentMessageId = manager.turnRuntime.handleAgentUpdate(update, session); } },
    runStep: async (_step, context) => {
      const tool = api.createSendMessageTool({
        getIngestAttachment: () => undefined,
        onSendMessage: (message, timestampMs) => {
          context.emitUpdate({ type: "send-message", message, timestampMs });
          return lastSentMessageId;
        },
      });
      const result = await tool.execute(ctx, interaction, (async function* () { yield JSON.stringify({ type: "text", content: "Delivered answer" }); })(), { toolCallId: crypto.randomUUID() });
      assert.equal(result.result.case, "success");
      return { done: true };
    },
  });
  const epoch = manager.sendPipeline.currentTurnEpoch(session);
  const entries = () => session.db.getTranscriptEntries().filter(entry => entry.kind === "send-message");
  try {
    const image = await readFile(path.join(root, "tests/fixtures/host-tools-vision.png"));
    for (const [prompt, options] of [["text request", {}], ["", { selectedImages: [{ data: Uint8Array.from(image), mimeType: "image/png" }] }]]) {
      const before = entries().length;
      const delivered = await runner.run(prompt, options);
      assert.equal(delivered.sentMessageCount, 1);
      const settled = await manager.turnRuntime.ensureUserReply(runner, delivered, session, epoch);
      assert.equal(settled.replyNudgeAttempts, 0);
      assert.equal(settled.deliveryOwed, false);
      assert.equal(entries().length, before + 1);
    }
    const pending = { text: "Private assistant text", sentMessageCount: 0, reacted: false, aborted: false };
    const before = entries().length;
    const recovered = await manager.turnRuntime.ensureUserReply(runner, pending, session, epoch);
    assert.equal(recovered.replyNudgeAttempts, 1);
    assert.equal(recovered.deliveryOwed, false);
    assert.equal(entries().length, before + 1);
    assert.ok(entries().every(entry => entry.message.content !== pending.text));
    for (const flags of [{ aborted: true }, { awaitingUserSelection: true }, { quiescedForUpgrade: true }]) {
      const count = entries().length;
      const settled = await manager.turnRuntime.ensureUserReply(runner, { ...pending, ...flags }, session, epoch);
      assert.equal(settled.replyNudgeAttempts, 0);
      assert.equal(entries().length, count);
    }
    const superseded = await manager.turnRuntime.ensureUserReply(runner, pending, session, epoch - 1);
    assert.equal(superseded.replyNudgeAttempts, 0);
    assert.equal(recorded.length, 3);
    const count = entries().length;
    const blockedTool = api.createSendMessageTool({
      getIngestAttachment: () => undefined,
      isAwaitingUserSelection: () => true,
      onSendMessage: (message, timestampMs) => manager.turnRuntime.handleAgentUpdate({ type: "send-message", message, timestampMs }, session),
    });
    const argumentsStream = () => (async function* () { yield JSON.stringify({ type: "text", content: "Pending answer" }); })();
    const blocked = await blockedTool.execute(ctx, interaction, argumentsStream(), { toolCallId: crypto.randomUUID() });
    assert.equal(blocked.result.case, "error");
    assert.equal(entries().length, count);
    const [canceledContext, cancel] = ctx.withCancel();
    cancel();
    await assert.rejects(blockedTool.execute(canceledContext, interaction, argumentsStream(), { toolCallId: crypto.randomUUID() }));
    assert.equal(entries().length, count);
  } finally {
    runner.dispose();
    await manager.roster.emitAgents();
    session.db.close();
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
    if (previousLocalAdmin === undefined) delete process.env.SAND_LOCAL_ADMIN;
    else process.env.SAND_LOCAL_ADMIN = previousLocalAdmin;
  }
});
