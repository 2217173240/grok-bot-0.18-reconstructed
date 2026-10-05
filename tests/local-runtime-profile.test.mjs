import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { resolveLocalRuntimeProfile, resolveLocalDataRoot, validateDockerRuntime, validateDockerImage, dockerEnvironment } from "../source/shared/node/local-runtime-profile.mjs";
import { createLocalDockerClient } from "../source/shared/node/local-docker-client.mjs";

const repo = path.resolve(import.meta.dirname, "..");
async function temporary(t) {
  await mkdir(path.join(repo, ".cache"), { recursive: true });
  const root = await mkdtemp(path.join(repo, ".cache/runtime-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("平台选择保留既有镜像与数据卷名称", async t => {
  const root = await temporary(t);
  for (const [platform, arch, suffix] of [["darwin", "arm64", "arm64"], ["win32", "x64", "amd64"], ["linux", "x64", "amd64"], ["linux", "arm64", "arm64"]]) {
    const profile = resolveLocalRuntimeProfile({ platform, arch, homeDir: root, dataRoot: root, env: {} });
    assert.deepEqual(profile.container, { platform: `linux/${suffix}`, image: `grok-bot-exec-box:${suffix}`, dataVolume: `grok-bot-local-vm-data-${suffix}` });
  }
  for (const [platform, arch] of [["darwin", "x64"], ["win32", "arm64"], ["linux", "ia32"]]) assert.throws(() => resolveLocalRuntimeProfile({ platform, arch, dataRoot: root, env: {} }), /unsupported host/);
});

test("配置文件与显式选择按固定优先级合并", async t => {
  const root = await temporary(t);
  await writeFile(path.join(root, "runtime.json"), JSON.stringify({ version: 1, docker: { context: "saved-context" }, image: "saved:image" }));
  const base = { dataRoot: root, homeDir: root, env: {} };
  const saved = resolveLocalRuntimeProfile(base);
  assert.deepEqual(saved.docker, { kind: "context", value: "saved-context", source: "runtime.json" });
  assert.equal(saved.container.image, "saved:image");
  const explicit = resolveLocalRuntimeProfile({ ...base, env: { DOCKER_CONTEXT: "chosen-context", DOCKER_HOST: "unix:///unused", GROKBOT_IMAGE: "chosen:image" } });
  assert.equal(explicit.docker.value, "chosen-context");
  assert.equal(explicit.container.image, "chosen:image");
  assert.deepEqual(dockerEnvironment(explicit, { DOCKER_HOST: "unix:///unused", PATH: "keep", DOCKER_CERT_PATH: "certificates" }), { DOCKER_CONTEXT: "chosen-context", PATH: "keep", DOCKER_CERT_PATH: "certificates" });
  const host = resolveLocalRuntimeProfile({ ...base, env: { DOCKER_HOST: "unix:///selected", SAND_LOCAL_ADMIN_IMAGE: "direct:image", GROKBOT_IMAGE: "unused:image" } });
  assert.equal(host.docker.value, "unix:///selected");
  assert.equal(host.container.image, "direct:image");
  assert.equal(dockerEnvironment(host, { DOCKER_CONTEXT: "unused" }).DOCKER_CONTEXT, undefined);
  assert.equal(resolveLocalRuntimeProfile({ ...base, env: {} }).container.image, "saved:image");
});

test("镜像单项持久配置保留平台默认端点", async t => {
  const root = await temporary(t);
  await writeFile(path.join(root, "runtime.json"), JSON.stringify({ version: 1, image: "selected:image" }));
  const profile = resolveLocalRuntimeProfile({ dataRoot: root, env: {} });
  assert.equal(profile.container.image, "selected:image");
  assert.notEqual(profile.docker.source, "runtime.json");
});

test("损坏、非法和不可读的运行配置保持原样并报告错误", async t => {
  const root = await temporary(t);
  const file = path.join(root, "runtime.json");
  const inputs = ['{"private":"SENSITIVE_FIXTURE",', "null", "[]", '{"version":2}', '{"version":1,"unknown":true}', '{"version":1,"docker":{"context":"one","host":"two"}}', '{"version":1,"docker":{"context":""}}', '{"version":1,"docker":{"context":"one","typo":true}}', '{"version":1,"docker":{"colimaProfile":"../other"}}'];
  for (const input of inputs) {
    await writeFile(file, input);
    assert.throws(() => resolveLocalRuntimeProfile({ dataRoot: root, env: { DOCKER_CONTEXT: "explicit" } }), error => {
      assert(!error.message.includes("SENSITIVE_FIXTURE"));
      return true;
    });
    assert.equal(await readFile(file, "utf8"), input);
  }
  await rm(file);
  await mkdir(file);
  assert.throws(() => resolveLocalRuntimeProfile({ dataRoot: root, env: {} }));
  await rm(file, { recursive: true });
  if (process.platform !== "win32" && process.getuid() !== 0) {
    await writeFile(file, '{"version":1}', { mode: 0o000 });
    try { assert.throws(() => resolveLocalRuntimeProfile({ dataRoot: root, env: {} }), /EACCES/); }
    finally { await chmod(file, 0o600); }
    assert.equal(await readFile(file, "utf8"), '{"version":1}');
  }
});

test("Mac 专属运行环境不会被其他项目目录代替", { skip: process.platform === "win32" }, async t => {
  const root = await temporary(t);
  await mkdir(path.join(root, ".colima", "other"), { recursive: true });
  await mkdir(path.join(root, ".orbstack", "run"), { recursive: true });
  const profile = resolveLocalRuntimeProfile({ platform: "darwin", arch: "arm64", homeDir: root, dataRoot: root, env: {} });
  assert.equal(profile.docker.value, `unix://${path.join(root, ".colima", "grokbot", "docker.sock")}`);
  const named = resolveLocalRuntimeProfile({ platform: "darwin", arch: "arm64", homeDir: root, dataRoot: root, env: { GROKBOT_COLIMA_PROFILE: "selected" } });
  assert.equal(named.docker.value, `unix://${path.join(root, ".colima", "selected", "docker.sock")}`);
  assert.throws(() => resolveLocalRuntimeProfile({ platform: "darwin", arch: "arm64", dataRoot: root, env: { GROKBOT_COLIMA_PROFILE: "../other" } }), /profile name/);
});

test("环境和镜像校验同时核对实际平台与依赖身份", async t => {
  const root = await temporary(t);
  const profile = resolveLocalRuntimeProfile({ dataRoot: root, env: { GROKBOT_IMAGE: "explicit:image" } });
  const arch = profile.container.platform.split("/")[1];
  const pin = "a".repeat(64);
  const image = { Os: "linux", Architecture: arch, Config: { Labels: { "com.grok-bot.local-vm.deps-pin": pin } } };
  assert.equal(validateDockerRuntime(profile, { OSType: "linux", Architecture: arch }), true);
  validateDockerImage(profile, image, pin);
  assert.throws(() => validateDockerRuntime(profile, { OSType: "windows", Architecture: arch }), /Linux containers/);
  assert.throws(() => validateDockerRuntime(profile, { OSType: "linux", Architecture: arch === "arm64" ? "amd64" : "arm64" }), /does not match/);
  assert.throws(() => validateDockerImage(profile, { ...image, Os: "windows" }, pin), /must match/);
  assert.throws(() => validateDockerImage(profile, image, "b".repeat(64)), /dependencies/);
  assert.throws(() => validateDockerImage(profile, { ...image, Config: { Labels: {} } }, pin), /dependencies/);
});

test("数据目录的显式值优先且保留平台路径规则", async t => {
  const root = await temporary(t);
  assert.equal(resolveLocalDataRoot({ dataRoot: root, env: { GROKBOT_DATA_ROOT: "ignored" } }), path.resolve(root));
  assert.equal(resolveLocalDataRoot({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\测试\\AppData\\Local" } }), "C:\\Users\\测试\\AppData\\Local\\GrokBotLocal");
  assert.equal(resolveLocalDataRoot({ platform: "darwin", env: { HOME: "/Users/验收 user" } }), "/Users/验收 user/.grokbot-local");
});

test("Shell 与 Node 共用配置，配置错误不被 Shell 吞掉", { skip: process.platform === "win32" }, async t => {
  const root = await temporary(t);
  const file = path.join(root, "runtime.json");
  await writeFile(file, JSON.stringify({ version: 1, docker: { context: "selected-context" } }));
  const env = { ...process.env, GROKBOT_DATA_ROOT: root };
  delete env.SAND_DATA_ROOT;
  delete env.DOCKER_HOST;
  delete env.DOCKER_CONTEXT;
  delete env.GROKBOT_COLIMA_PROFILE;
  const command = '. "$1"; resolve_docker_host || exit $?; printf "%s" "$DOCKER_CONTEXT"';
  assert.equal(execFileSync("bash", ["-c", command, "runtime-profile-test", path.join(repo, "scripts/lib/docker-socket.sh")], { env, encoding: "utf8" }), "selected-context");
  await writeFile(file, '{"version":');
  assert.throws(() => execFileSync("bash", ["-c", command, "runtime-profile-test", path.join(repo, "scripts/lib/docker-socket.sh")], { env, stdio: "pipe" }));
});

test("真实 Docker CLI 无法连接选定端点时保持选择并报告失败", async t => {
  const root = await temporary(t);
  const endpoint = process.platform === "win32" ? `npipe:////./pipe/grokbot-absent-${path.basename(root)}` : `unix://${path.join(root, "absent.sock")}`;
  const client = createLocalDockerClient({ dataRoot: root, env: { ...process.env, DOCKER_CONTEXT: "", DOCKER_HOST: endpoint } });
  await assert.rejects(client.inspect(), /unavailable/);
  assert.equal((await client.profile()).docker.value, endpoint);
});
