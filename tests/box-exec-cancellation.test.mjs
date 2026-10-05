import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

test("production Box Context 取消会终止 shell 及其子进程，后续请求仍然可用", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/box-exec-cancellation-"));
  const output = path.join(directory, "runtime.mjs");
  await build({ entryPoints: [path.join(root, "tests/fixtures/box-exec-cancellation-runtime.ts")], outfile: output, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
  const { startBoxExecDaemon, productionBoxGeneratedPorts: ports, createBoxTransport, createContext, ExecServerMessage, ShellArgs } = await import(pathToFileURL(output).href);
  const authToken = randomUUID();
  const workspaceRoot = path.join(directory, "workspace");
  const daemon = await startBoxExecDaemon({ port: 0, authToken, workspaceRoot });
  const endpoint = new URL(daemon.url);
  const transport = createBoxTransport({ host: endpoint.hostname, port: Number(endpoint.port), authToken }, ports.createTransport);
  const client = ports.createExecClient(transport);
  let id = 0;
  const request = (command) => new ExecServerMessage({ id: ++id, message: { case: "shellStreamArgs", value: new ShellArgs({ command, workingDirectory: "/workspace", skipApproval: true }) } });
  try {
    const [ctx, cancel] = createContext().withCancel();
    const started = Promise.withResolvers();
    const running = (async () => {
      for await (const envelope of client.exec(ctx, request("printf '%s' $$ > shell.pid; sleep 3 & sleeper=$!; printf '%s' $sleeper > sleep.pid; printf STARTED; wait $sleeper; printf SHOULD_NOT_EXIST > delayed.txt"))) {
        if (envelope.element.case !== "execClientMessage") continue;
        const message = envelope.element.value.message;
        if (message.case === "shellStream" && message.value.event.case === "stdout" && message.value.event.value.data.includes("STARTED")) started.resolve();
      }
    })();
    const outcome = running.then(() => undefined, error => error);
    await Promise.race([started.promise, running.then(() => { throw new Error("shell 未输出 STARTED"); })]);
    const pids = await Promise.all(["shell.pid", "sleep.pid"].map(async name => Number(await readFile(path.join(workspaceRoot, name), "utf8"))));
    for (const pid of pids) process.kill(pid, 0);
    cancel(new Error("用户中断"));
    await delay(3300);
    assert.equal(existsSync(path.join(workspaceRoot, "delayed.txt")), false, "取消后 shell 仍然写入延迟文件");
    assert.ok(await outcome, "取消应使正在消费的 RPC 失败");
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });

    let stdout = "";
    let exitCode;
    for await (const envelope of client.exec(createContext(), request("printf AFTER_CANCEL"))) {
      if (envelope.element.case !== "execClientMessage") continue;
      const message = envelope.element.value.message;
      if (message.case !== "shellStream") continue;
      if (message.value.event.case === "stdout") stdout += message.value.event.value.data;
      if (message.value.event.case === "exit") exitCode = message.value.event.value.code;
    }
    assert.equal(stdout, "AFTER_CANCEL");
    assert.equal(exitCode, 0);
    await assert.rejects(ports.createControlClient(transport).ping(createContext().withDeadline(new Date(0)), {}, { timeoutMs: 1000 }));
    await ports.createControlClient(transport).ping(createContext(), {}, { timeoutMs: 1000 });
  } finally {
    await daemon.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
