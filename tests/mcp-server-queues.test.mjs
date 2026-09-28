import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Value } from "@bufbuild/protobuf";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const serverFile = path.join(root, "tests/fixtures/mcp-controlled-server.mjs");
const observe = promise => { promise.catch(() => undefined); return promise; };
const events = async fixture => (await readFile(fixture.eventsPath, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
async function until(fixture, predicate) {
  let watcher, timer;
  try {
    await new Promise((resolve, reject) => {
      const check = () => events(fixture).then(rows => { if (predicate(rows)) resolve(); }, reject);
      watcher = watch(fixture.eventsPath, check);
      timer = setTimeout(() => reject(new Error(`Missing server event: ${fixture.identity}`)), 5000);
      check();
    });
  } finally { watcher?.close(); clearTimeout(timer); }
}
const count = async (fixture, event) => (await events(fixture)).filter(row => row.event === event).length;
const text = result => { assert.equal(result.result.case, "success"); return JSON.parse(result.result.value.content[0].content.value.text); };

async function withHost(mode, run) {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/mcp-queues-"));
  const outfile = path.join(directory, "host.mjs");
  await build({ entryPoints: [path.join(root, "source/box-exec-daemon/mcp-host.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
  const { BoxMcpHost, parseMcpServerConfigs } = await import(pathToFileURL(outfile).href);
  const host = new BoxMcpHost({ workspaceRoot: directory, connectTimeoutMs: 3000 });
  const children = [];
  const fixture = async (identity, notifications = true, initial = {}) => {
    const controlPath = path.join(directory, `${identity}.control.json`);
    const eventsPath = path.join(directory, `${identity}.events.jsonl`);
    let state = { sequence: 0, revision: "v1", released: [], ...initial };
    await writeFile(controlPath, JSON.stringify(state));
    await writeFile(eventsPath, "");
    const value = { identity, controlPath, eventsPath };
    const args = [serverFile, mode, controlPath, eventsPath, identity, String(notifications)];
    if (mode === "stdio") value.config = { command: process.execPath, args };
    else {
      const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
      children.push({ child, closed: new Promise(resolve => child.once("close", resolve)) });
      const lines = createInterface({ input: child.stdout });
      const port = await new Promise((resolve, reject) => { lines.once("line", line => resolve(JSON.parse(line).port)); child.once("error", reject); });
      lines.close();
      value.config = { url: `http://127.0.0.1:${port}/mcp` };
    }
    value.control = async changes => {
      state = { ...state, ...changes, sequence: state.sequence + 1 };
      await writeFile(`${controlPath}.next`, JSON.stringify(state));
      await rename(`${controlPath}.next`, controlPath);
      await until(value, rows => rows.some(row => row.event === "control" && row.sequence === state.sequence));
    };
    return value;
  };
  const call = (name, tool, args = {}, signal) => observe(host.callTool({ name: tool, toolName: `${name}__${tool}`, providerIdentifier: name, toolCallId: args.marker ?? tool, args: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, Value.fromJson(value)])) }, signal));
  const list = (names = [], kickOnly = false, signal) => observe(host.listState({ serverIdentifiers: names, kickOnly }, signal));
  try { await run({ host, fixture, call, list, parseMcpServerConfigs }); }
  finally {
    await host.dispose();
    await Promise.all(children.map(async ({ child, closed }) => { child.kill("SIGTERM"); await closed; }));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const mode of ["stdio", "http"]) {
  test(`${mode} 不同服务器独立推进，同一服务器保持调用顺序`, { timeout: 15000 }, async () => withHost(mode, async ({ host, fixture, call, list }) => {
    const slow = await fixture("slow", false), fast = await fixture("fast", false);
    await host.load(JSON.stringify({ mcpServers: { slow: slow.config, fast: fast.config } }));
    await list();
    const first = call("slow", "wait", { marker: "first" });
    await until(slow, rows => rows.some(row => row.event === "call-start" && row.marker === "first"));
    const second = call("slow", "wait", { marker: "second" });
    const [status, discovery, echo] = await Promise.all([list(["fast"], true), list(["fast"]), call("fast", "echo_v1", { text: "independent" })]);
    assert.equal(status.result.value.servers[0].status, "connected");
    assert.equal(discovery.result.value.servers[0].tools.length, 4);
    assert.equal(text(echo).text, "independent");
    assert.equal((await events(slow)).some(row => row.event === "effect"), false);
    assert.equal((await events(slow)).some(row => row.marker === "second"), false);
    await slow.control({ released: ["first"] });
    await first;
    await until(slow, rows => rows.some(row => row.event === "call-start" && row.marker === "second"));
    await slow.control({ released: ["first", "second"] });
    await second;
    const ordered = (await events(slow)).filter(row => row.marker != null).map(row => `${row.event}:${row.marker}`);
    assert.deepEqual(ordered, ["call-start:first", "effect:first", "call-start:second", "effect:second"]);
    await slow.control({ gatePage2: true });
    const combined = list();
    await until(slow, rows => rows.filter(row => row.event === "list-start" && row.page === 2).length === 2);
    await until(fast, rows => rows.filter(row => row.event === "list-end" && row.page === 2).length === 3);
    await slow.control({ gatePage2: false });
    assert.equal((await combined).result.case, "success");
  }));

  test(`${mode} 配置切换保留预约顺序并隔离连接代次`, { timeout: 15000 }, async () => withHost(mode, async ({ host, fixture, call, list }) => {
    const old = await fixture("old"), next = await fixture("next"), third = await fixture("third"), other = await fixture("other"), otherNext = await fixture("other-next");
    await host.load(JSON.stringify({ mcpServers: { selected: old.config, other: other.config } }));
    let otherPid = text(await call("other", "identity")).pid;
    const blocked = call("selected", "wait", { marker: "replace" });
    await until(old, rows => rows.some(row => row.event === "call-start" && row.marker === "replace"));
    const before = call("selected", "identity");
    const replacing = observe(host.load(JSON.stringify({ mcpServers: { selected: next.config, other: other.config } })));
    const after = call("selected", "identity");
    assert.equal(text(await call("other", "identity")).pid, otherPid);
    assert.equal((await list(["selected"], true)).result.value.servers[0].status, "connected");
    const secondLoad = observe(host.load(JSON.stringify({ mcpServers: { selected: next.config, other: otherNext.config } })));
    const afterSecondLoad = text(await call("other", "identity"));
    assert.equal(afterSecondLoad.identity, "other-next");
    assert.notEqual(afterSecondLoad.pid, otherPid);
    otherPid = afterSecondLoad.pid;
    await old.control({ released: ["replace"] });
    await blocked;
    assert.equal(text(await before).identity, "old");
    await replacing;
    await secondLoad;
    assert.equal(text(await after).identity, "next");
    const removingCall = call("selected", "wait", { marker: "remove" });
    await until(next, rows => rows.some(row => row.event === "call-start" && row.marker === "remove"));
    const beforeRemoval = call("selected", "identity");
    const removing = observe(host.load(JSON.stringify({ mcpServers: { other: otherNext.config } })));
    const afterRemoval = call("selected", "identity");
    const recreating = observe(host.load(JSON.stringify({ mcpServers: { selected: third.config, other: otherNext.config } })));
    const afterRecreate = call("selected", "identity");
    await next.control({ released: ["remove"] });
    await removingCall;
    assert.equal(text(await beforeRemoval).identity, "next");
    await removing;
    assert.equal((await afterRemoval).result.case, "serverNotFound");
    await recreating;
    assert.equal(text(await afterRecreate).identity, "third");
    assert.equal(text(await call("other", "identity")).pid, otherPid);
  }));

  test(`${mode} 通知缓存完整分页，目录变更及失败保持可见`, { timeout: 15000 }, async () => withHost(mode, async ({ host, fixture, call, list }) => {
    const server = await fixture("notifying");
    await host.load(JSON.stringify({ mcpServers: { catalog: server.config } }));
    for (let index = 0; index < 20; index++) await list();
    assert.equal(await count(server, "list-start"), 2);
    await server.control({ revision: "v2" });
    assert.equal(text(await call("catalog", "identity")).revision, "v2");
    assert.ok((await list()).result.value.servers[0].tools.some(tool => tool.toolName === "echo_v2"));
    assert.equal(await count(server, "list-start"), 4);
    await server.control({ gatePage2: true, notify: 1 });
    const listing = list();
    await until(server, rows => rows.filter(row => row.event === "list-start" && row.page === 2).length === 3);
    await server.control({ revision: "v3", gatePage2: false });
    const fresh = await listing;
    assert.ok(fresh.result.value.servers[0].tools.some(tool => tool.toolName === "echo_v3"));
    assert.equal(fresh.result.value.servers[0].tools.some(tool => tool.toolName === "echo_v2"), false);
    assert.equal(await count(server, "list-start"), 8);
    await server.control({ failList: true, notify: 2 });
    const failed = await list();
    assert.equal(failed.result.value.servers[0].status, "error");
    assert.match(failed.result.value.servers[0].errorMessage, /controlled catalog failure/);
    assert.deepEqual(failed.result.value.servers[0].tools, []);
    await server.control({ failList: false });
    assert.equal((await list()).result.value.servers[0].status, "connected");
    const starts = await count(server, "call-start");
    const toolFailure = await call("catalog", "fail");
    assert.equal(toolFailure.result.case, "error");
    assert.match(toolFailure.result.value.error, /controlled call failure/);
    assert.equal(await count(server, "call-start"), starts + 1);
    const next = await fixture("new-generation");
    const previousPages = (await events(server)).filter(row => row.event === "list-start" && row.page === 2).length;
    await server.control({ gatePage2: true, notify: 3 });
    const oldListing = list();
    await until(server, rows => rows.filter(row => row.event === "list-start" && row.page === 2).length === previousPages + 1);
    const replacing = observe(host.load(JSON.stringify({ mcpServers: { catalog: next.config } })));
    const newListing = list();
    await server.control({ revision: "retired", gatePage2: false });
    assert.ok((await oldListing).result.value.servers[0].tools.some(tool => tool.toolName === "echo_retired"));
    await replacing;
    const newTools = (await newListing).result.value.servers[0].tools.map(tool => tool.toolName);
    assert.ok(newTools.includes("echo_v1"));
    assert.equal(newTools.includes("echo_retired"), false);
    assert.equal(text(await call("catalog", "identity")).identity, "new-generation");
    assert.equal(await count(next, "list-start"), 2);
  }));

  test(`${mode} 无通知服务器保持主动刷新，未知工具只刷新目录`, { timeout: 15000 }, async () => withHost(mode, async ({ host, fixture, call, list }) => {
    const server = await fixture("unnotified", false);
    await host.load(JSON.stringify({ mcpServers: { catalog: server.config } }));
    for (let index = 0; index < 20; index++) await list();
    assert.equal(await count(server, "list-start"), 40);
    await server.control({ revision: "v2" });
    assert.equal(text(await call("catalog", "echo_v2", { text: "new-tool" })).text, "new-tool");
    assert.equal(await count(server, "list-start"), 42);
    assert.equal((await call("catalog", "missing")).result.case, "toolNotFound");
    assert.equal(await count(server, "list-start"), 44);
    assert.equal(await count(server, "call-start"), 1);
  }));

  test(`${mode} 排队请求及时取消，dispose 拒绝新请求并排空所有队列`, { timeout: 15000 }, async () => withHost(mode, async ({ host, fixture, call, list }) => {
    const server = await fixture("closing");
    await host.load(JSON.stringify({ mcpServers: { selected: server.config } }));
    const pid = text(await call("selected", "identity")).pid;
    const active = call("selected", "wait", { marker: "active" });
    await until(server, rows => rows.some(row => row.event === "call-start" && row.marker === "active"));
    const abort = new AbortController();
    const canceled = call("selected", "wait", { marker: "canceled" }, abort.signal);
    abort.abort(new Error("queued operation canceled"));
    await assert.rejects(canceled, /canceled/);
    const queued = call("selected", "wait", { marker: "queued" });
    const listing = list();
    const closing = host.dispose();
    await assert.rejects(active, /disposed/);
    await assert.rejects(queued, /disposed/);
    assert.equal((await listing).result.case, "error");
    assert.equal((await call("selected", "identity")).result.case, "error");
    await closing;
    if (mode === "http") await until(server, rows => rows.some(row => row.event === "call-aborted" && row.marker === "active"));
    const calls = (await events(server)).filter(row => row.event === "call-start");
    assert.deepEqual(calls.map(row => row.marker), [null, "active"]);
    if (mode === "stdio") assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }));
}

test("合法 __proto__ 服务器名称经过 JSON 解析、连接和调用仍然保留", { timeout: 10000 }, async () => withHost("stdio", async ({ host, fixture, call, list, parseMcpServerConfigs }) => {
  const server = await fixture("prototype-name");
  const configJson = JSON.stringify({ mcpServers: Object.fromEntries([["__proto__", server.config]]) });
  const parsed = parseMcpServerConfigs(configJson);
  assert.deepEqual(Object.keys(parsed), ["__proto__"]);
  assert.equal(Object.getPrototypeOf(parsed), null);
  const sentinel = randomUUID();
  let message;
  try { parseMcpServerConfigs(`{"mcpServers":{"private":{"headers":{"Authorization":"${sentinel}`); }
  catch (error) { message = error.message; }
  assert.equal(message?.includes(sentinel), false);
  assert.equal(message, "MCP server config is not valid JSON.");
  assert.deepEqual(await host.load(configJson), ["__proto__"]);
  assert.equal(text(await call("__proto__", "identity")).identity, "prototype-name");
  const argumentsWithOwnKeys = JSON.parse('{"__proto__":{"text":"preserved"},"text":"own-key"}');
  const ownKeyResult = await call("__proto__", "echo_v1", argumentsWithOwnKeys);
  assert.equal(ownKeyResult.result.case, "success", JSON.stringify(ownKeyResult.toJson()));
  assert.deepEqual((await events(server)).find(row => row.event === "wire-call" && row.arguments.text === "own-key").arguments, argumentsWithOwnKeys);
  // 当前 SDK 的请求 schema 会清理 __proto__；host 的线协议仍须完整保留输入。
  assert.deepEqual(text(ownKeyResult).arguments, { text: "own-key" });
  const constructorArguments = { constructor: "own-key", text: "constructor-key" };
  const rejectedKey = await call("__proto__", "echo_v1", constructorArguments);
  assert.equal(rejectedKey.result.case, "error");
  assert.match(rejectedKey.result.value.error, /expected record/);
  assert.deepEqual((await events(server)).find(row => row.event === "wire-call" && row.arguments.text === "constructor-key").arguments, constructorArguments);
  assert.equal((await list()).result.value.servers[0].serverIdentifier, "__proto__");
  assert.equal((await call("constructor", "identity")).result.case, "serverNotFound");
}));

test("真实 stdio 关闭失败阻止替代进程，重复 load 共享失败并保留关闭所有权", { timeout: 20000 }, async () => withHost("stdio", async ({ host, fixture, call, list }) => {
  const old = await fixture("held-pipe", true, { holdStdout: true });
  const next = await fixture("never-started");
  await host.load(JSON.stringify({ mcpServers: { selected: old.config } }));
  const holderPid = (await events(old)).find(row => row.event === "pipe-owner").holderPid;
  try {
    const config = JSON.stringify({ mcpServers: {} });
    const replacing = host.load(config);
    const repeated = host.load(config);
    const [first, second] = await Promise.allSettled([replacing, repeated]);
    assert.equal(first.status, "rejected");
    assert.equal(second.status, "rejected");
    assert.match(first.reason.message, /shutdown failed/);
    assert.match(second.reason.message, /shutdown failed/);
    assert.equal(await count(next, "started"), 0);
    assert.equal((await list()).result.value.servers[0].status, "error");
    await assert.rejects(host.load(config), /shutdown failed/);
    await assert.rejects(host.load(JSON.stringify({ mcpServers: { selected: next.config } })), /shutdown failed/);
    assert.equal(await count(next, "started"), 0);
    assert.match((await list(["selected"], true)).result.value.servers[0].errorMessage, /close failed/);
    assert.equal((await call("selected", "identity")).result.case, "error");
  } finally {
    process.kill(holderPid, "SIGTERM");
    const deadline = Date.now() + 3000;
    while ((await list(["selected"], true)).result.value.servers[0].errorMessage !== "MCP transport closed.") {
      if (Date.now() >= deadline) throw new Error("stdio close event did not follow pipe owner exit");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}));

for (const mode of ["reject", "timeout"]) test(`HTTP 取消通知 ${mode} 明确报告，物理关闭后显式 reload 可以恢复`, { timeout: 15000 }, async () => withHost("http", async ({ host, fixture, call, list }) => {
  const old = await fixture(`cancel-${mode}`, true, { cancelDelivery: mode });
  const next = await fixture(`recovery-${mode}`);
  await host.load(JSON.stringify({ mcpServers: { selected: old.config } }));
  const abort = new AbortController();
  const active = call("selected", "wait", { marker: "unacknowledged" }, abort.signal);
  await until(old, rows => rows.some(row => row.event === "call-start" && row.marker === "unacknowledged"));
  abort.abort(new Error("cancel tool"));
  await assert.rejects(active, /cancel/);
  await until(old, rows => rows.some(row => row.event === "cancellation-refused"));
  const config = JSON.stringify({ mcpServers: { selected: next.config } });
  await assert.rejects(host.load(config), /shutdown failed/);
  assert.match((await list(["selected"], true)).result.value.servers[0].errorMessage, /close failed/);
  await host.load(config);
  assert.equal(text(await call("selected", "identity")).identity, `recovery-${mode}`);
}));
