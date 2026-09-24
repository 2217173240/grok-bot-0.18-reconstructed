import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("失败消息状态保留完整历史，并在清除会话时清理", async () => {
  const cacheRoot = path.join(repositoryRoot, ".cache");
  await mkdir(cacheRoot, { recursive: true });
  const root = await mkdtemp(path.join(cacheRoot, "failed-user-messages-"));
  const outfile = path.join(root, "agent-db.mjs");
  await build({
    entryPoints: [path.join(repositoryRoot, "source/host/extensions/session/agent-db.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  const { SandAgentDb } = await import(pathToFileURL(outfile).href);
  const dbPath = path.join(root, "agent", "store.db");
  let db = new SandAgentDb(dbPath);
  try {
    assert.deepEqual(db.getFailedUserMessageIds(), []);
    const ids = Array.from({ length: 150 }, (_, index) => `message-${index}`);
    const messages = ids.map((id) => ({ id, text: id }));
    for (const message of messages) {
      assert.equal(db.appendTranscriptEntry({ id: message.id, content: message.text, kind: "message", role: "user" }), true);
      db.recordFailedUserMessageId(message.id);
    }
    db.recordFailedUserMessageId(" message-0 ");
    db.recordFailedUserMessageId("");
    assert.deepEqual(db.getFailedUserMessageIds(), ids);
    db.clearTransientState();
    assert.deepEqual(db.getFailedUserMessageIds(), ids);
    db.close();
    db = new SandAgentDb(dbPath);
    assert.deepEqual(db.getFailedUserMessageIds(), ids);
    assert.equal(db.getTranscriptEntries().length, 150);
    const pending = { id: "pending-new", text: "待处理消息" };
    const pendingOlder = { id: "pending-old", text: "尚未处理的历史消息" };
    assert.deepEqual(db.filterFailedUserMessages([pendingOlder, ...messages, pending]), [pendingOlder, pending]);

    for (const raw of ["[", "{}", "null", '["message-0",42]', '["message-0",""]', '["message-0"," "]']) {
      assert.equal(db.writeKv("failedUserMessageIds", raw), true);
      assert.throws(() => db.getFailedUserMessageIds(), /Invalid failedUserMessageIds/);
      assert.throws(() => db.filterFailedUserMessages([pending]), /Invalid failedUserMessageIds/);
      assert.throws(() => db.recordFailedUserMessageId(pending.id), /Invalid failedUserMessageIds/);
      assert.equal(db.readKv("failedUserMessageIds"), raw);
      db.close();
      db = new SandAgentDb(dbPath);
      assert.throws(() => db.getFailedUserMessageIds(), /Invalid failedUserMessageIds/);
      assert.equal(db.readKv("failedUserMessageIds"), raw);
    }

    db.writeKv("failedUserMessageIds", '["message-0","message-0"]');
    assert.deepEqual(db.getFailedUserMessageIds(), ["message-0"]);
    db.recordFailedUserMessageId("message-1");
    assert.deepEqual(JSON.parse(db.readKv("failedUserMessageIds")), ["message-0", "message-1"]);
    assert.equal(db.clearConversation(), true);
    assert.equal(db.readKv("failedUserMessageIds"), null);
    assert.deepEqual(db.getTranscriptEntries(), []);
    db.close();
    db = new SandAgentDb(dbPath);
    assert.deepEqual(db.getFailedUserMessageIds(), []);
    assert.deepEqual(db.filterFailedUserMessages(messages), messages);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
