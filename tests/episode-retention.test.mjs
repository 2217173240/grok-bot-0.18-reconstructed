import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const buildDir = await mkdtemp(join(root, ".cache", "episode-build-"));
const bundle = join(buildDir, "episode.mjs");
await build({ stdin: { contents: `
export { SandAgentDb } from "./source/host/extensions/session/agent-db.ts";
export { FileMemoryStore } from "./source/host/extensions/memory/memory-service.ts";
export { runTurnMemory } from "./source/host/runner/turn-memory.ts";
export { getEpisodeInterval } from "./source/host/runner/sand-memory.ts";
export { BasePromptExecutor, BasePromptBuilder } from "./source/packages/chat-inference/base.ts";
export { createRealDebouncePolicy } from "./source/internal/scheduling.ts";
`, resolveDir: root }, outfile: bundle, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
const { SandAgentDb, FileMemoryStore, runTurnMemory, getEpisodeInterval, BasePromptExecutor, BasePromptBuilder, createRealDebouncePolicy } = await import(bundle);
test.after(() => rm(buildDir, { recursive: true, force: true }));

test("Episode interval 完整校验整数范围", () => {
  assert.equal(getEpisodeInterval({}), 6);
  for (const value of ["1", "64", " 6 "]) assert.equal(getEpisodeInterval({ SAND_MEMORY_EPISODE_INTERVAL: value }), Number(value));
  for (const value of ["", "0", "65", "-1", "1.5", "6junk", "1e1", "NaN", "Infinity"]) {
    assert.throws(() => getEpisodeInterval({ SAND_MEMORY_EPISODE_INTERVAL: value }), RangeError);
  }
});

test("SQLite Episode 队列超过64条重启保持完整，非法消费参数不改变数据", async () => {
  const dir = await mkdtemp(join(root, ".cache", "episode-db-"));
  let db = new SandAgentDb(join(dir, "agent.db"));
  try {
    for (let i = 1; i <= 100; i++) db.recordEpisodeTurn({ ts: i, user: `user-${i}`, agent: `agent-${i}` });
    db.close(); db = new SandAgentDb(join(dir, "agent.db"));
    assert.deepEqual(db.getPendingEpisodeTurns().map(turn => turn.ts), Array.from({ length: 100 }, (_, i) => i + 1));
    for (const count of [-1, 1.5, NaN, Infinity, 101]) assert.throws(() => db.consumePendingEpisodeTurns(count), RangeError);
    assert.equal(db.getPendingEpisodeTurns().length, 100);
    db.consumePendingEpisodeTurns(6);
    assert.equal(db.getPendingEpisodeTurns()[0].ts, 7);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("关闭SQLite后Episode修改明确失败，重新打开保留全部数据", async () => {
  const dir = await mkdtemp(join(root, ".cache", "episode-closed-"));
  const dbPath = join(dir, "agent.db");
  let db = new SandAgentDb(dbPath);
  const turn = { ts: 1, user: "retained user", agent: "retained answer" };
  try {
    db.recordEpisodeTurn(turn);
    db.close();
    assert.throws(() => db.recordEpisodeTurn({ ...turn, ts: 2 }), /closed/);
    assert.throws(() => db.consumePendingEpisodeTurns(1), /closed/);
    assert.throws(() => db.consumePendingEpisodeTurns(0), /closed/);
    assert.throws(() => db.clearPendingEpisodeTurns(), /Failed to clear/);
    db = new SandAgentDb(dbPath);
    assert.deepEqual(db.getPendingEpisodeTurns(), [turn]);
    db.consumePendingEpisodeTurns(1);
    assert.deepEqual(db.getPendingEpisodeTurns(), []);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("SQLite写入锁使Episode追加、消费与清空明确失败并保留队列", async () => {
  const dir = await mkdtemp(join(root, ".cache", "episode-locked-"));
  const dbPath = join(dir, "agent.db");
  const db = new SandAgentDb(dbPath, { busyTimeoutMs: 1 });
  const blocker = new DatabaseSync(dbPath);
  const turns = [1, 2].map(ts => ({ ts, user: `retained-${ts}`, agent: `answer-${ts}` }));
  try {
    for (const turn of turns) db.recordEpisodeTurn(turn);
    blocker.exec("BEGIN IMMEDIATE");
    assert.throws(() => db.recordEpisodeTurn({ ts: 3, user: "new", agent: "answer" }), /Failed to persist Episode turn/);
    assert.throws(() => db.consumePendingEpisodeTurns(1), /Failed to persist Episode consumption/);
    assert.throws(() => db.consumePendingEpisodeTurns(2), /Failed to persist Episode consumption/);
    assert.throws(() => db.clearPendingEpisodeTurns(), /Failed to clear/);
    assert.deepEqual(db.getPendingEpisodeTurns(), turns);
    blocker.exec("ROLLBACK");
    db.consumePendingEpisodeTurns(2);
    assert.deepEqual(db.getPendingEpisodeTurns(), []);
  } finally { blocker.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("真实HTTP SSE与文件写入：失败保留并追加，成功和NONE只消费本次批次", async () => {
  const dir = await mkdtemp(join(root, ".cache", "episode-http-"));
  const db = new SandAgentDb(join(dir, "agent.db"));
  const store = new FileMemoryStore(join(dir, "memory"), createRealDebouncePolicy({ name: "episode-test", delayMs: 0 }));
  let responseMode = "failure";
  const episodeRequests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const episode = body.messages.some(message => message.content.includes("<<SAND_MEMORY_EPISODE>>"));
    if (episode) episodeRequests.push(body.messages);
    if (episode && responseMode === "failure") { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "episode unavailable" } })); return; }
    const text = episode ? responseMode === "empty" ? "" : responseMode === "none" ? "NONE" : "Completed the retained episode." : "NONE";
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "episode", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "episode", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const model = createOpenAI({ apiKey: "local-test", baseURL: `http://127.0.0.1:${server.address().port}/v1`, compatibility: "compatible" }).chat("local");
  class HttpTextExecutor extends BasePromptExecutor {
    constructor() { super(new BasePromptBuilder()); }
    stream() { return streamText({ model, messages: this.getMessages(), maxRetries: 0 }); }
  }
  const session = { getExecutor: () => new HttpTextExecutor() };
  const previousInterval = process.env.SAND_MEMORY_EPISODE_INTERVAL;
  process.env.SAND_MEMORY_EPISODE_INTERVAL = "6";
  const turn = ts => runTurnMemory(store, db, session, {}, ts, { user: `user-${ts}`, agent: `agent-${ts}` });
  try {
    for (let i = 1; i <= 70; i++) db.recordEpisodeTurn({ ts: i, user: `user-${i}`, agent: `agent-${i}` });
    await turn(71);
    assert.equal(db.getPendingEpisodeTurns().length, 71);
    responseMode = "empty"; await turn(72);
    assert.equal(db.getPendingEpisodeTurns().length, 72);
    responseMode = "summary";
    const blockedLog = join(store.logDir, "1970-01.md");
    await mkdir(blockedLog, { recursive: true });
    await turn(73);
    assert.equal(db.getPendingEpisodeTurns().length, 73);
    await rm(blockedLog, { recursive: true });
    await turn(74);
    assert.deepEqual(db.getPendingEpisodeTurns().map(turn => turn.ts), Array.from({ length: 68 }, (_, i) => i + 7));
    assert.match(await readFile(blockedLog, "utf8"), /Completed the retained episode/);
    for (const messages of episodeRequests) {
      const prompt = messages.at(-1).content;
      assert.match(prompt, /User: user-1\n/);
      assert.match(prompt, /User: user-6\n/);
      assert.doesNotMatch(prompt, /User: user-7\n/);
    }
    responseMode = "none"; await turn(75);
    assert.deepEqual(db.getPendingEpisodeTurns().map(turn => turn.ts), Array.from({ length: 63 }, (_, i) => i + 13));
    assert.equal(store.listMemories(100).length, 1);
    process.env.SAND_MEMORY_EPISODE_INTERVAL = "6junk";
    await turn(76);
    assert.equal(db.getPendingEpisodeTurns().length, 64);
    assert.equal(db.getPendingEpisodeTurns().at(-1).ts, 76);
    assert.equal(episodeRequests.length, 5);
  } finally {
    if (previousInterval === undefined) delete process.env.SAND_MEMORY_EPISODE_INTERVAL; else process.env.SAND_MEMORY_EPISODE_INTERVAL = previousInterval;
    db.close(); store.dir.stopWatching(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
