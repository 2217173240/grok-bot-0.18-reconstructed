import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const execute = promisify(execFile);
await mkdir(path.join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".cache/runtime-diagnostics-"));
test.after(() => rm(directory, { recursive: true, force: true }));
const env = { ...process.env, GROKBOT_DATA_ROOT: directory };
const unreachable = { ...env, DOCKER_HOST: `unix://${directory}/unreachable.sock` };

function launch(command, environment) {
  const child = spawn("bash", [path.join(root, "start-local.sh"), command], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const ended = once(child, "close");
  return { child, ended, output: () => output.split("\n").filter(line => !line.startsWith("handover:")).join("\n") };
}

test("launcher shell 语法有效", async () => {
  await execute("bash", ["-n", path.join(root, "start-local.sh")]);
});

test("真实 HTTP 健康检查仅接受 2xx，并且不跟随重定向", async () => {
  const healthRoot = await mkdtemp(path.join(directory, "health-"));
  const token = randomUUID();
  await writeFile(path.join(healthRoot, "local-docker-vm.json"), JSON.stringify({ token }), { mode: 0o600 });
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorized: request.headers.authorization === `Bearer ${token}` });
    const status = Number(request.url.slice(1));
    if (status === 302) response.setHeader("location", "/200");
    response.writeHead(status);
    response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const status of [200, 204, 302, 401, 500]) {
      let code = 0, output = "";
      try {
        const result = await execute("bash", ["-c", 'source "$1"; health_ok "$2"', "health-test", path.join(root, "start-local.sh"), `http://127.0.0.1:${server.address().port}/${status}`], { env: { ...env, GROKBOT_DATA_ROOT: healthRoot } });
        output = result.stdout + result.stderr;
      } catch (error) {
        code = error.code;
        output = error.stdout + error.stderr;
      }
      assert.equal(code, status < 300 ? 0 : 1);
      assert.equal(output.length, 0);
    }
    assert.deepEqual(requests.map(request => request.path), ["/200", "/204", "/302", "/401", "/500"]);
    assert.equal(requests.every(request => request.authorized), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("真实 Docker CLI 对不可达 socket 返回明确状态", { timeout: 10_000 }, async () => {
  const run = launch("status", unreachable);
  const [code] = await run.ended;
  assert.equal(code, 0);
  assert.equal(run.output().includes("host:        unknown (Docker unreachable)"), true);
  assert.equal(run.output().includes("box-exec:    unknown (Docker unreachable)"), true);
  assert.equal(run.output().includes("Mac local-exec:"), true);
  assert.equal(run.output().includes("host:        not running"), false);
});

test("日志命令在 Docker 不可达时明确失败", { timeout: 10_000 }, async () => {
  const run = launch("logs", unreachable);
  const [code] = await run.ended;
  assert.equal(code, 1);
  assert.equal(run.output().includes("Docker unreachable"), true);
});

test("容器未创建时准确报告未运行", { timeout: 10_000 }, async t => {
  try { await execute("docker", ["info"], { env }); }
  catch { t.skip("Docker daemon unavailable"); return; }
  try { await execute("docker", ["inspect", "grok-bot-local-vm"], { env }); }
  catch {
    const run = launch("status", env);
    const [code] = await run.ended;
    assert.equal(code, 0);
    assert.equal(run.output().includes("container not running (not found)"), true);
    assert.equal(run.output().includes("box-exec:    not running (container not found)"), true);
    return;
  }
  t.skip("Existing user container is preserved");
});

test("读取实际运行容器的 host 与 box-exec 状态", { skip: process.env.SAND_TEST_RUNTIME_DIAGNOSTICS !== "1", timeout: 10_000 }, async () => {
  const run = launch("status", env);
  const [code] = await run.ended;
  assert.equal(code, 0);
  assert.equal(run.output().includes("host:        running in container (pid "), true);
  assert.equal(run.output().includes("box-exec:    healthy (container port 1337)"), true);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`实际 Docker 日志与 app 日志在 ${signal} 后清理 followers`, { skip: process.env.SAND_TEST_RUNTIME_DIAGNOSTICS !== "1", timeout: 10_000 }, async () => {
    const marker = `app-diagnostic-${signal}`;
    await writeFile(path.join(directory, "app.log"), `${marker}\n`);
    // 同时跟随容器日志，持续覆盖 launcher 启动期间的新记录。
    const reference = spawn("docker", ["logs", "--tail", "40", "--follow", "grok-bot-local-vm"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let referenceStdout = "", referenceStderr = "";
    reference.stdout.on("data", chunk => { referenceStdout += chunk; });
    reference.stderr.on("data", chunk => { referenceStderr += chunk; });
    const referenceEnded = once(reference, "close");
    const hasContainerOutput = output => [referenceStdout, referenceStderr].some(stream =>
      stream.split("\n").slice(0, -1).some(line => line.length > 0 && output.includes(line)));
    const run = launch("logs", env);
    let followers = [];
    try {
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        try {
          const { stdout } = await execute("pgrep", ["-P", String(run.child.pid)]);
          followers = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
        } catch { followers = []; }
        if (followers.length === 2 && run.output().includes(marker) && hasContainerOutput(run.output())) break;
        await delay(50);
      }
      assert.equal(run.output().includes("Docker grok-bot-local-vm logs"), true);
      assert.equal(run.output().includes(marker), true);
      assert.equal(hasContainerOutput(run.output()), true);
      assert.equal(followers.length, 2);
      run.child.kill(signal);
      const [code] = await run.ended;
      assert.equal(code, signal === "SIGTERM" ? 143 : 130);
      for (const pid of followers) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      if (run.child.exitCode === null && run.child.signalCode === null) {
        run.child.kill("SIGTERM");
        await run.ended;
      }
      if (reference.exitCode === null && reference.signalCode === null) reference.kill("SIGTERM");
      await referenceEnded;
    }
  });
}
