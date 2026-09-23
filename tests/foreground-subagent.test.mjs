import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { getEventListeners, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

async function setup(t) {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const workspace = await mkdtemp(path.join(root, ".cache/foreground-subagent-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const outfile = path.join(workspace, "runtime.mjs");
  await build({ stdin: { contents: `
    export { createSubagentRuntime } from "./source/host/runner/subagent-runtime.ts";
    export { SandSubagentHostAdapter } from "./source/host/runner/agent-adapters.ts";
    export { createSubagentExecutor } from "./source/packages/agent-exec/subagent.ts";
    export { SubagentArgs } from "./source/packages/proto/generated/agent/v1/subagent_exec_pb.ts";
    export { createContext } from "./source/packages/context/core.ts";
  `, resolveDir: root }, outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
  const api = await import(pathToFileURL(outfile).href);
  const events = [];
  const windows = new Set();
  const runtime = api.createSubagentRuntime({
    getConversationId: () => "parent",
    resolveBoxId: () => "local",
    emitAsyncTasksChanged: () => events.push(["changed"]),
    computerUse: { freeWindow: id => { windows.delete(id); events.push(["free", id]); } },
    isComputerUseSubagentType: type => type === "computerUse",
    onPendingWakeArmed: event => events.push(["armed", event]),
    onPendingWakeDisarmed: event => events.push(["disarmed", event]),
    onComputerUseUsage: event => events.push(["usage", event]),
    actionAuditor: { record: event => events.push(["audit", event]) },
  });
  runtime.setBackgroundSubagentHandler(event => events.push(["completed", event]));
  runtime.setBackgroundSubagentDispatchHandler(event => events.push(["dispatched", event]));
  let session;
  const adapter = new api.SandSubagentHostAdapter(runtime.sessions, () => {
    session = new ProcessSession(path.join(workspace, "result.txt"));
    t.after(() => session.child?.kill());
    return session;
  }, {
    isRunning: runtime.isRunning,
    allocateComputerUseWindow: id => { windows.add(id); return id; },
    freeComputerUseWindow: id => windows.delete(id),
    dispatch: runtime.dispatchBackgroundSubagent,
    dispatchForeground: runtime.dispatchForegroundSubagent,
    abort: runtime.abortSubagent,
  });
  return { ...api, workspace, runtime, adapter, events, windows, getSession: () => session };
}

class ProcessSession {
  constructor(file) { this.file = file; this.count = 0; }
  async run(prompt) {
    this.child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { writeFile } from "node:fs/promises";
      process.stderr.write("ready");
      for await (const input of process.stdin) {
        if (input.toString().trim() === "fail") process.exit(7);
        await writeFile(process.argv[1], process.argv[2]);
        process.stdout.write(process.argv[2]);
        break;
      }
    `, this.file, prompt], { stdio: ["pipe", "pipe", "pipe"] });
    this.ready = once(this.child.stderr, "data");
    let text = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => { text += chunk; });
    const [code, signal] = await once(this.child, "close");
    if (signal != null) return { text, aborted: true };
    if (code !== 0) throw new Error(`Process exited with ${code}`);
    this.count++;
    return { text, aborted: false };
  }
  interrupt() { this.child.kill(); }
  async getResolvedOutline() { return this.count ? [{ text: await readFile(this.file, "utf8") }] : []; }
  getObservedToolCallCount() { return this.count; }
  getActivitySnapshot() { return ["process"]; }
  getTranscriptPath() { return this.file; }
  getComputerUseUsageSnapshot() { return { turnEndedCount: this.count }; }
  getComputerUseAuditActionCounts() { return new Map([["process", this.count]]); }
}

for (const runInBackground of [undefined, false, true]) {
  test(`Task runInBackground=${runInBackground} executes a process and delivers its result once`, async t => {
    const env = await setup(t);
    const args = new env.SubagentArgs({ subagentType: "computerUse", toolCallId: "task", parentConversationId: "parent", prompt: "file written by child", ...(runInBackground === undefined ? {} : { runInBackground }) });
    const executor = env.createSubagentExecutor(env.adapter);
    const context = env.createContext();
    let resolved = false;
    const pending = executor.execute(context, args).then(result => { resolved = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    const session = env.getSession();
    await session.ready;
    assert.equal(resolved, runInBackground === true);
    assert.equal(env.runtime.listSubagents()[0].status, "running");
    assert.equal(env.windows.size, 1);
    session.child.stdin.end("complete");
    const result = await pending;
    await env.runtime.drainBackgroundSubagents();
    assert.equal(await readFile(session.file, "utf8"), args.prompt);
    assert.equal(result.result.case, "success");
    assert.equal(result.result.value.finalMessage, runInBackground === true ? undefined : args.prompt);
    if (runInBackground === true) assert.equal(env.events.find(([kind]) => kind === "completed")[1].result, args.prompt);
    assert.equal(env.events.filter(([kind]) => kind === "completed").length, runInBackground === true ? 1 : 0);
    assert.equal(env.events.filter(([kind]) => kind === "armed").length, runInBackground === true ? 1 : 0);
    assert.equal(env.events.filter(([kind]) => kind === "usage").length, 1);
    assert.equal(env.events.filter(([kind]) => kind === "audit").length, 1);
    assert.equal(env.windows.size, 0);
    assert.equal(env.runtime.sessions.size, 0);
    assert.equal(env.runtime.listSubagents()[0].status, "done");
    assert.deepEqual(await env.runtime.getSubagentOutline(result.result.value.agentId), [{ text: args.prompt }]);
    assert.equal(await executor.execute(context, args), result);
    assert.equal(session.count, 1);
    assert.equal(getEventListeners(context.signal, "abort").length, 0);
  });
}

test("a canceled parent never starts the foreground process", async t => {
  const env = await setup(t);
  const [context, cancel] = env.createContext().withCancel();
  cancel("already stopped");
  const args = new env.SubagentArgs({ subagentType: "computerUse", toolCallId: "canceled", prompt: "unused" });
  const result = await env.createSubagentExecutor(env.adapter).execute(context, args);
  assert.equal(result.result.case, "error");
  assert.equal(env.getSession().child, undefined);
  assert.equal(env.windows.size, 0);
  assert.equal(env.runtime.sessions.size, 0);
  assert.deepEqual(env.events, []);
});

for (const action of ["cancel", "fail"]) {
  test(`foreground ${action} cleans up the process without background delivery`, async t => {
    const env = await setup(t);
    const args = new env.SubagentArgs({ subagentType: "computerUse", toolCallId: action, prompt: "unfinished" });
    const [context, cancel] = env.createContext().withCancel();
    const executor = env.createSubagentExecutor(env.adapter);
    const pending = executor.execute(context, args);
    await new Promise(resolve => setImmediate(resolve));
    const session = env.getSession();
    await session.ready;
    if (action === "cancel") cancel("parent stopped");
    else session.child.stdin.end("fail");
    const result = await pending;
    assert.equal(result.result.case, "error");
    assert.equal(env.runtime.listSubagents()[0].status, action === "cancel" ? "aborted" : "error");
    assert.equal(env.windows.size, 0);
    assert.equal(env.runtime.sessions.size, 0);
    assert.equal(env.events.filter(([kind]) => ["completed", "armed", "disarmed"].includes(kind)).length, 0);
    assert.equal(env.events.filter(([kind]) => kind === "usage").length, 1);
    assert.equal(env.events.filter(([kind]) => kind === "audit").length, 1);
    assert.equal(getEventListeners(context.signal, "abort").length, action === "cancel" ? 0 : 1);
  });
}
