// 手动验收：在独立的容器中运行镜像自带的桌面入口。
// 用法：node scripts/manual-local-docker-desktop-health.mjs <已暂存的 v3 runtime 目录>
// 使用当前 Docker 端点：DOCKER_HOST 优先，否则取当前 context；start-local.sh 会导出
// DOCKER_HOST，profile 名由 scripts/lib/docker-socket.sh 与 GROKBOT_COLIMA_PROFILE 决定。

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const image = process.env.GROKBOT_EVAL_IMAGE || "grok-bot-exec-box:arm64";
const runtime = process.argv[2];
if (runtime == null) throw new Error("Pass the staged v3 runtime directory as the first argument.");
for (const entry of ["sand-host/host-main.cjs", "box-exec-daemon/main.cjs"]) {
  if (!(await stat(path.join(runtime, entry))).isFile()) throw new Error(`Missing staged runtime file: ${entry}`);
}

async function docker(...args) {
  return await run("docker", args, { maxBuffer: 2_000_000 });
}

await docker("info", "--format", "{{.ServerVersion}}");
await docker("image", "inspect", image, "--format", "{{.Id}}");
// The bundled connector below reads DOCKER_HOST; an operator who set it keeps
// their choice, otherwise the active context's endpoint is used.
const configuredEndpoint = process.env.DOCKER_HOST?.trim();
if (configuredEndpoint == null || configuredEndpoint.length === 0) {
  const { stdout } = await docker("context", "inspect", "--format", "{{.Endpoints.docker.Host}}");
  process.env.DOCKER_HOST = stdout.trim();
}
const previousHost = configuredEndpoint;

await mkdir(path.join(root, ".cache"), { recursive: true });
const workRoot = await mkdtemp(path.join(root, ".cache", "desktop-health-manual-"));
const workspace = path.join(workRoot, "workspace");
const name = `grok-desktop-health-${process.pid}`;
const volume = `${name}-data`;
const token = randomBytes(32).toString("hex");
let connector;

async function startContainer() {
  await docker("run", "--detach", "--name", name,
    "--security-opt", "seccomp=unconfined",
    "--entrypoint", "/usr/local/bin/box-init-exec",
    "--memory", "4g",
    "--env", "SAND_GATEWAY_BIND_HOST=0.0.0.0",
    "--env", "SAND_HOST_IN_BOX=1", "--env", "SAND_LOCAL_ADMIN=1",
    "--env", "SAND_HOST_PORT=1340",
    "--env", `SAND_GATEWAY_TOKEN=${token}`,
    "--env", "SAND_GATEWAY_REQUIRE_AUTH=1",
    "--env", "SAND_DATA_ROOT=/home/box/sand-data",
    "--env", "SAND_WORKSPACE_ROOT=/workspace",
    "--env", "SAND_AGENT_WORKSPACE=/workspace",
    "--mount", `type=bind,src=${path.resolve(runtime, "sand-host")},dst=/home/box/sand-host,readonly`,
    "--mount", `type=bind,src=${path.resolve(runtime, "box-exec-daemon")},dst=/home/box/box-exec-daemon,readonly`,
    "--mount", `type=bind,src=${workspace},dst=/workspace`,
    "--volume", `${volume}:/home/box/sand-data`,
    image, "/home/box/sand-host/host-main.cjs");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await docker("exec", name, "curl", "--fail", "--silent", "--max-time", "2", "--header", `authorization: Bearer ${token}`, "http://127.0.0.1:1340/health");
      const activity = JSON.parse((await docker("exec", name, "cat", "/home/box/.cache/grok-session-sync/activity.json")).stdout);
      if (activity.version === 1 && activity.state === "idle" && Date.now() - activity.updatedAt < 15_000) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  const { stdout: logs } = await docker("logs", "--tail", "40", name);
  throw new Error(`Desktop container gateway did not become ready.\n${logs}`);
}

async function assertProcesses(router, sessionSync) {
  const processes = await connector.probeLocalDockerDesktopProcesses(name);
  assert.deepEqual(processes, { router, sessionSync });
  return connector.desktopProcessRebuildReason(processes);
}

try {
  await mkdir(workspace);
  await chmod(workspace, 0o777);
  await docker("volume", "create", volume);
  await docker("run", "--rm", "--user", "root", "--volume", `${volume}:/home/box/sand-data`, "--entrypoint", "sh", image, "-c", "chown -R box:box /home/box/sand-data");
  const outfile = path.join(workRoot, "connector.mjs");
  await build({ entryPoints: [path.join(root, "source/electron-main/box/local-docker-host-connector.ts")], bundle: true, format: "esm", platform: "node", packages: "external", outfile, logLevel: "silent" });
  connector = await import(pathToFileURL(outfile).href);

  await startContainer();
  assert.equal(await assertProcesses(1, 1), undefined);

  await docker("exec", name, "pkill", "-f", "[s]and-window-router.mjs");
  assert.match(await assertProcesses(0, 1), /Reset Grok Bot's Computer/);
  await docker("exec", name, "curl", "--fail", "--silent", "--max-time", "2", "--header", `authorization: Bearer ${token}`, "http://127.0.0.1:1340/health");

  await docker("rm", "--force", name);
  await startContainer();
  assert.equal(await assertProcesses(1, 1), undefined);

  await docker("exec", name, "pkill", "-f", "[s]ession-sync.mjs");
  assert.match(await assertProcesses(1, 0), /Reset Grok Bot's Computer/);
  await docker("rm", "--force", name);
  await startContainer();
  assert.equal(await assertProcesses(1, 1), undefined);

  process.stdout.write("Real desktop processes: healthy, router exit, rebuild, session-sync exit, rebuild passed.\n");
} finally {
  await docker("rm", "--force", name).catch(() => undefined);
  await docker("volume", "rm", "--force", volume).catch(() => undefined);
  await rm(workRoot, { recursive: true, force: true });
  if (previousHost == null) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = previousHost;
}
