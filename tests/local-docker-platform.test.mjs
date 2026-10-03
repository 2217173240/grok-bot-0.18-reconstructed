import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".cache/docker-platform-"));
await build({ entryPoints: [path.join(root, "source/electron-main/box/local-docker-host-connector.ts"), path.join(root, "source/shared/node/local-docker-platform.ts")], outdir: directory, outbase: path.join(root, "source"), outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
const { localDockerPlatform, dockerBindMount } = await import(pathToFileURL(path.join(directory, "shared/node/local-docker-platform.mjs")).href);
const { dockerSpawnEnv, resolveDockerHost, decideDockerImage, localDockerRunPlan } = await import(pathToFileURL(path.join(directory, "electron-main/box/local-docker-host-connector.mjs")).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test("Windows x64 和 Mac arm64 使用独立 Linux 镜像与数据卷", () => {
  assert.deepEqual(localDockerPlatform("win32", "x64"), { image: "grok-bot-exec-box:amd64", dockerPlatform: "linux/amd64", dataVolume: "grok-bot-local-vm-data-amd64" });
  assert.deepEqual(localDockerPlatform("darwin", "arm64"), { image: "grok-bot-exec-box:arm64", dockerPlatform: "linux/arm64", dataVolume: "grok-bot-local-vm-data-arm64" });
  assert.throws(() => localDockerPlatform("win32", "arm64"), /unsupported architecture/);
  const platform = localDockerPlatform("win32", "x64");
  assert.equal(decideDockerImage({}, { present: true, depsPin: "pin" }, "pin", platform).image, platform.image);
  assert.equal(decideDockerImage({}, { present: true, depsPin: "old" }, "pin", platform).selection, "self-built-stale");
});

test("Windows Docker CLI 保留当前 context、显式 endpoint 与完整环境", () => {
  const envs = [{ PATH: "C:\\Docker", USERPROFILE: "C:\\Users\\测试" }, { DOCKER_HOST: "npipe:////./pipe/docker_engine", DOCKER_TLS_VERIFY: "1" }, { DOCKER_CONTEXT: "desktop-linux", DOCKER_HOST: "tcp://ignored:2376", DOCKER_CERT_PATH: "C:\\certs" }];
  for (const env of envs) assert.deepEqual(dockerSpawnEnv(env, "win32"), env);
  assert.equal(resolveDockerHost({}, directory, "absent", "win32"), undefined);
  assert.equal(resolveDockerHost(envs[1], directory, "absent", "win32"), envs[1].DOCKER_HOST);
  assert.equal(resolveDockerHost(envs[2], directory, "absent", "win32"), undefined);
});

test("Windows bind 路径保留盘符、Unicode、空格并转义 CSV 字段", () => {
  const source = 'C:\\Users\\测试, A\\box"folder';
  assert.equal(dockerBindMount(source, "/workspace", true), 'type=bind,"src=C:\\Users\\测试, A\\box""folder",dst=/workspace,readonly');
  const platform = localDockerPlatform("win32", "x64");
  const plan = localDockerRunPlan({ platform, image: platform.image, hostMainPath: source, boxExecDaemonDir: source, workspaceHostPath: source, token: "token", hostSha256: "host", boxExecDaemonSha256: "daemon", pluginsHostDir: source, anthropicTokenPath: source, hostTurn: true });
  assert.equal(plan.args[plan.args.indexOf("--platform") + 1], "linux/amd64");
  assert(plan.args.includes("grok-bot-local-vm-data-amd64:/home/box/sand-data"));
  assert(plan.args.includes(`SAND_WORKSPACE_HOST=${source}`));
  assert(plan.args.includes(dockerBindMount(source, "/workspace")));
  assert(plan.args.includes(dockerBindMount(source, "/home/box/sand-host", true)));
  assert(plan.args.includes("SAND_HOST_IN_BOX=1"));
});
