import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Code, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function startCdp(directory) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const chromium = process.env.DESKTOP_PROBE_CHROMIUM;
  const executable = chromium ?? require("electron");
  const args = chromium == null
    ? [path.join(root, "tests/fixtures/desktop-probe-cdp.cjs"), path.join(directory, "electron-profile")]
    : ["--headless", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${path.join(directory, "chromium-profile")}`, "data:text/html,<title>Desktop probe acceptance</title>"];
  const child = spawn(executable, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise(resolve => child.once("close", resolve));
  const stop = async () => { if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM"); await exited; };
  try {
    const port = await new Promise((resolve, reject) => {
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { reject(new Error("Browser CDP startup timed out")); }, 15_000);
      const check = () => {
        const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (match != null && (chromium != null || stdout.includes("desktop-probe-ready"))) { clearTimeout(timer); resolve(Number(match[1])); }
      };
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Browser exited before readiness: ${code ?? signal}\n${stderr.slice(-1500)}`)); });
      child.stdout.on("data", value => { stdout += value; check(); });
      child.stderr.on("data", value => { stderr += value; check(); });
    });
    const deadline = Date.now() + 5000;
    while (true) {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
      if (targets.some(target => target.type === "page" && target.title === "Desktop probe acceptance")) break;
      if (Date.now() >= deadline) throw new Error("CDP page did not finish loading");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { port, stop };
  } catch (error) { await stop(); throw error; }
}

test("真实 daemon 对关闭端口、curl 超时和浏览器 CDP 的返回按协议分类", { timeout: 40_000 }, async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/desktop-probe-"));
  const output = path.join(directory, "runtime.mjs");
  await build({ entryPoints: [path.join(root, "tests/fixtures/desktop-probe-runtime.ts")], outfile: output, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
  const { startBoxExecDaemon, ExecService, ExecServerMessage, ShellArgs, navigationProbeCommand, navigationProbeOutput } = await import(pathToFileURL(output).href);
  const token = randomUUID();
  const daemon = await startBoxExecDaemon({ port: 0, authToken: token, workspaceRoot: path.join(directory, "workspace") });
  const client = createClient(ExecService, createConnectTransport({ baseUrl: daemon.url, httpVersion: "1.1" }));
  let id = 0;
  const execute = async (command, options = {}, signal) => {
    const request = new ExecServerMessage({ id: ++id, message: { case: "shellArgs", value: new ShellArgs({ command, workingDirectory: "/workspace", skipApproval: true, ...options }) } });
    for await (const event of client.exec(request, { headers: { authorization: `Bearer ${token}` }, signal })) {
      if (event.element.case === "execClientMessage" && event.element.value.message.case === "shellResult") return event.element.value.message.value;
      if (event.element.case === "execClientControlMessage" && event.element.value.message.case === "throw") throw new Error(event.element.value.message.value.error);
    }
    throw new Error("Daemon did not return a ShellResult");
  };
  const waitingServer = createServer(() => {});
  let cdp;
  try {
    const closedServer = createServer();
    const closedPort = await listen(closedServer);
    await close(closedServer);
    const closed = await execute(navigationProbeCommand(closedPort - 9222));
    assert.equal(closed.result.case, "failure");
    assert.equal(closed.result.value.exitCode, 7);
    assert.equal(closed.result.value.aborted, false);
    assert.equal(navigationProbeOutput(closed), undefined);

    const waitingPort = await listen(waitingServer);
    const timedOut = await execute(navigationProbeCommand(waitingPort - 9222));
    assert.equal(timedOut.result.case, "failure");
    assert.equal(timedOut.result.value.exitCode, 28);
    assert.equal(navigationProbeOutput(timedOut), undefined);

    cdp = await startCdp(directory);
    const available = await execute(navigationProbeCommand(cdp.port - 9222));
    assert.equal(available.result.case, "success");
    const targets = JSON.parse(navigationProbeOutput(available));
    assert.ok(targets.some(target => target.type === "page" && target.title === "Desktop probe acceptance"));

    const killed = await execute("kill -TERM $$");
    assert.equal(killed.result.case, "failure");
    assert.equal(killed.result.value.signal, "SIGTERM");
    assert.throws(() => navigationProbeOutput(killed));
    const spawnError = await execute("pwd", { workingDirectory: "/outside-workspace" });
    assert.equal(spawnError.result.case, "spawnError");
    assert.throws(() => navigationProbeOutput(spawnError));
    const executionTimeout = await execute("sleep 2", { timeout: 50 });
    assert.equal(executionTimeout.result.case, "timeout");
    assert.throws(() => navigationProbeOutput(executionTimeout));
    const otherFailure = await execute("command_that_does_not_exist_for_desktop_probe");
    assert.equal(otherFailure.result.case, "failure");
    assert.equal(otherFailure.result.value.exitCode, 127);
    assert.throws(() => navigationProbeOutput(otherFailure));
    const cancellation = new AbortController();
    const canceled = execute("sleep 2", {}, cancellation.signal);
    const cancelTimer = setTimeout(() => cancellation.abort(), 50);
    try { await assert.rejects(canceled, error => error.code === Code.Canceled); }
    finally { clearTimeout(cancelTimer); }
  } finally {
    await cdp?.stop();
    if (waitingServer.listening) await close(waitingServer);
    await daemon.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
