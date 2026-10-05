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
const { dockerBindMount, localDockerPlatform } = await import(pathToFileURL(path.join(directory, "shared/node/local-docker-platform.mjs")).href);
const { localDockerRunPlan } = await import(pathToFileURL(path.join(directory, "electron-main/box/local-docker-host-connector.mjs")).href);
const profile = await import(pathToFileURL(path.join(root, "source/shared/node/local-runtime-profile.mjs")).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test("canonical runtime profile maps Windows and arm64 inputs", () => {
  assert.equal(profile.localDockerPlatform("win32", "x64").dockerPlatform, "linux/amd64");
  assert.equal(profile.localDockerPlatform("darwin", "arm64").dockerPlatform, "linux/arm64");
  assert.throws(() => profile.localDockerPlatform("win32", "arm64"), /unsupported host/);
});

test("canonical profile validates Docker architecture and dependency pin", () => {
  const runtime = profile.resolveLocalRuntimeProfile({ platform: "win32", arch: "x64", env: {}, dataRoot: path.join(directory, "data"), homeDir: "C:\\Users\\测试" });
  assert.equal(runtime.container.platform, "linux/amd64");
  assert.equal(runtime.container.image, "grok-bot-exec-box:amd64");
  const pin = "a".repeat(64);
  assert.doesNotThrow(() => profile.validateDockerImage(runtime, { Os: "linux", Architecture: "amd64", Config: { Labels: { "com.grok-bot.local-vm.deps-pin": pin } } }, pin));
  assert.throws(() => profile.validateDockerImage(runtime, { Os: "linux", Architecture: "arm64", Config: { Labels: {} } }, pin), /match/);
  assert.throws(() => profile.validateDockerImage(runtime, { Os: "linux", Architecture: "amd64", Config: { Labels: {} } }, pin), /dependencies/);
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
