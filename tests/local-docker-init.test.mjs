import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".cache/docker-init-"));
const outfile = path.join(directory, "connector.mjs");
await build({ entryPoints: [path.join(root, "source/electron-main/box/local-docker-host-connector.ts")], outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
const { localDockerRunPlan } = await import(outfile);
test.after(() => rm(directory, { recursive: true, force: true }));

function plan(desktop) {
  return localDockerRunPlan({ image: "grok-bot-exec-box:arm64", hostMainPath: directory, boxExecDaemonDir: directory, token: "", hostSha256: "test-host", boxExecDaemonSha256: "test-daemon", workspaceHostPath: directory, hostTurn: true, desktop });
}

test("desktop 与 exec 容器启动计划启用标准 Docker init", () => {
  for (const desktop of [false, true]) assert.equal(plan(desktop).args.filter(arg => arg === "--init").length, 1);
});

test("真实隔离容器启用 init 后回收孤儿并保留原数据卷", { skip: process.env.SAND_TEST_DOCKER_IMAGE == null, timeout: 30_000 }, async () => {
  const execute = promisify(execFile);
  const docker = async args => (await execute("docker", args, { timeout: 15_000 })).stdout;
  const name = `grok-init-test-${process.pid}`;
  const volume = `${name}-data`;
  const image = process.env.SAND_TEST_DOCKER_IMAGE;
  await docker(["volume", "create", volume]);
  try {
    await docker(["run", "--name", name, "--network", "none", "--user", "root", "--volume", `${volume}:/state`, "--entrypoint", "node", image, "-e", 'require("node:fs").writeFileSync("/state/preserved.txt", "preserved across init migration")']);
    assert.notEqual(JSON.parse(await docker(["inspect", "--format", "{{json .HostConfig.Init}}", name])), true);
    await docker(["rm", "--force", name]);
    const initArgs = plan(true).args.filter(arg => arg === "--init");
    const output = await docker(["run", ...initArgs, "--name", name, "--network", "none", "--user", "root", "--volume", `${volume}:/state`, "--mount", `type=bind,src=${path.join(root, "tests/fixtures/docker-init-orphans.mjs")},dst=/check.mjs,readonly`, "--entrypoint", "node", image, "/check.mjs"]);
    assert.deepEqual(JSON.parse(output), { rounds: 2, orphansReaped: 2, dataPreserved: true });
    assert.equal(JSON.parse(await docker(["inspect", "--format", "{{json .HostConfig.Init}}", name])), true);
  } finally {
    await docker(["rm", "--force", name]);
    await docker(["volume", "rm", volume]);
  }
});
