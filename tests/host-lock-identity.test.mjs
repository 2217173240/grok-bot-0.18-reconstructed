import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".cache/host identity-"));
const outfile = path.join(directory, "lock.mjs");
await build({ entryPoints: [path.join(root, "source/host/host-lock.ts")], outfile, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
const { acquireHostLock, isSandHostProcess } = await import(pathToFileURL(outfile).href);
test.after(() => rm(directory, { recursive: true, force: true }));
const script = path.join(directory, "host-main.cjs");
const wrapper = path.join(directory, "wrapper.cjs");
const program = 'process.stdout.write("ready"); setInterval(() => {}, 1000);';
await writeFile(script, program);
await writeFile(wrapper, program);

async function child(t, executable, args, env = process.env) {
  const proc = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const ended = once(proc, "exit");
  proc.stderr.resume();
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM"); await ended; });
  await once(proc.stdout, "data");
  return { proc, ended };
}

test("真实 Node 入口可接管，wrapper 与 eval 中的 host-main 字样不会触发终止", async t => {
  const actual = await child(t, process.execPath, [script]);
  const unrelated = [
    await child(t, process.execPath, [wrapper, script]),
    await child(t, process.execPath, ["-e", program, script]),
    await child(t, "/bin/sh", ["-c", "printf ready; read unused", script]),
  ];
  assert.equal(isSandHostProcess(actual.proc.pid), true);
  const lockPath = path.join(directory, "identity.lock");
  for (const { proc } of unrelated) {
    assert.equal(isSandHostProcess(proc.pid), false);
    await writeFile(lockPath, String(proc.pid));
    const result = await acquireHostLock({ path: lockPath });
    assert.equal(result.outcome, "reclaimed-foreign");
    assert.doesNotThrow(() => process.kill(proc.pid, 0));
    result.lock.release();
  }
  await writeFile(lockPath, String(actual.proc.pid));
  const result = await acquireHostLock({ path: lockPath });
  assert.equal(result.outcome, "took-over");
  await actual.ended;
  assert.equal(actual.proc.signalCode, "SIGTERM");
  assert.equal(await readFile(lockPath, "utf8"), String(process.pid));
  result.lock.release();
});

test("macOS Electron-as-Node 的实际 host 入口保持可识别", { skip: process.platform !== "darwin" }, async t => {
  const executable = path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const actual = await child(t, executable, [script], { ...process.env, ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(isSandHostProcess(actual.proc.pid), true);
});

test("隔离 Docker init 携带 host-main 参数时保留 PID1 并收回旧锁", { skip: process.env.SAND_TEST_DOCKER_IMAGE == null, timeout: 20_000 }, async () => {
  const probe = path.join(directory, "probe.mjs");
  await writeFile(probe, `
    import assert from "node:assert/strict";
    import { writeFile, readFile, mkdir } from "node:fs/promises";
    import { spawn } from "node:child_process";
    import { once } from "node:events";
    import { acquireHostLock, isSandHostProcess } from "./lock.mjs";
    assert.equal(isSandHostProcess(1), false);
    const lockPath = "/home/box/.cache/lock-identity/host.lock";
    await mkdir("/home/box/.cache/lock-identity", { recursive: true });
    await writeFile(lockPath, "1");
    const result = await acquireHostLock({ path: lockPath });
    assert.equal(result.outcome, "reclaimed-foreign");
    process.kill(1, 0);
    assert.equal(await readFile(result.lock.path, "utf8"), String(process.pid));
    result.lock.release();
    const host = spawn(process.execPath, ["/probe/host-main.cjs"]);
    const exited = once(host, "exit");
    await once(host.stdout, "data");
    assert.equal(isSandHostProcess(host.pid), true);
    await writeFile(lockPath, String(host.pid));
    const takeover = await acquireHostLock({ path: lockPath });
    assert.equal(takeover.outcome, "took-over");
    await exited;
    takeover.lock.release();
    console.log("init-survived");
  `);
  const { stdout } = await promisify(execFile)("docker", ["run", "--rm", "--init", "--network", "none", "--mount", `type=bind,src=${directory},dst=/probe,readonly`, "--entrypoint", "node", process.env.SAND_TEST_DOCKER_IMAGE, "/probe/probe.mjs", "/probe/host-main.cjs"], { timeout: 15_000 });
  assert.equal(stdout.trim(), "init-survived");
});
