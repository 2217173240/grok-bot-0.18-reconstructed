import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
process.env.SAND_LOCAL_ADMIN = "1";

async function loadModules(t) {
  await mkdir(path.join(repoRoot, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(repoRoot, ".cache/secrets-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "modules.cjs");
  await build({
    stdin: { contents: [
      'export * from "./source/electron-main/secrets/user-secrets-store.ts";',
      'export { createBoxSecretsPush } from "./source/electron-main/secrets/secrets-ipc.ts";',
      'export { BoxSecretsApplier, SandBoxSecretsUnreadableError } from "./source/host/extensions/secrets/secrets-service.ts";',
      'export { createContext } from "./source/packages/context/core.ts";',
      'export * as scheduling from "./source/internal/scheduling.ts";',
    ].join("\n"), resolveDir: repoRoot, loader: "ts" },
    outfile: output, bundle: true, format: "cjs", platform: "node", target: "node22", external: ["electron"], logLevel: "error",
  });
  return { ...createRequire(output)(output), directory };
}

const damagedFiles = {
  "v2 numeric secret": { version: 2, accounts: { account: { KEY: 42 } } },
  "v2 valid and invalid siblings": { version: 2, accounts: { account: { GOOD_KEY: "stored", KEY: false } } },
  "v2 array account": { version: 2, accounts: { account: ["stored"] } },
  "v2 null account": { version: 2, accounts: { account: null } },
  "v2 string account": { version: 2, accounts: { account: "stored" } },
  "v2 invalid second account": { version: 2, accounts: { account: {}, other: { KEY: {} } } },
  "v2 array accounts": { version: 2, accounts: [] },
  "v1 object secret": { version: 1, secrets: { KEY: {} } },
  "unknown version": { version: 3, accounts: {} },
  "array root": ["version", 2],
};

async function assertUnreadable(m, storePath) {
  const store = new m.SandUserSecretsStore(storePath, () => "account");
  for (const operation of [() => store.exportSnapshot(), () => store.listKeys(["REMOTE_KEY"]), () => store.reveal("KEY"), () => store.upsert({ NEW_KEY: "new" }), () => store.remove(["KEY"])]) {
    await assert.rejects(operation, m.SandUserSecretsUnreadableError);
  }
}

for (const [name, content] of Object.entries(damagedFiles)) {
  test(`损坏的 user-secrets.json 拒绝读取和修改：${name}`, async (t) => {
    const m = await loadModules(t), storePath = path.join(m.directory, "user-secrets.json");
    const original = `${JSON.stringify(content)}\n`;
    await writeFile(storePath, original, { mode: 0o600 });
    await assertUnreadable(m, storePath);
    assert.equal(await readFile(storePath, "utf8"), original);
  });
}

test("截断的 JSON 保留原文件", async (t) => {
  const m = await loadModules(t), storePath = path.join(m.directory, "user-secrets.json");
  const original = '{"version":2,"accounts":{"account":{"KEY":"trunc';
  await writeFile(storePath, original, { mode: 0o600 });
  await assertUnreadable(m, storePath);
  assert.equal(await readFile(storePath, "utf8"), original);
});

test("读取权限失败保留原文件与权限", { skip: process.getuid?.() === 0 }, async (t) => {
  const m = await loadModules(t), storePath = path.join(m.directory, "user-secrets.json");
  const original = JSON.stringify({ version: 2, accounts: {} });
  await writeFile(storePath, original, { mode: 0o600 });
  await chmod(storePath, 0o000);
  try { await assertUnreadable(m, storePath); assert.equal((await stat(storePath)).mode & 0o777, 0o000); }
  finally { await chmod(storePath, 0o600); }
  assert.equal(await readFile(storePath, "utf8"), original);
});

test("local-admin 缺少文件时保存会话修改并合并远端列表", async (t) => {
  const m = await loadModules(t), storePath = path.join(m.directory, "user-secrets.json");
  const store = new m.SandUserSecretsStore(storePath, () => "account");
  assert.equal(store.isPersistent(), false);
  assert.deepEqual(await store.exportSnapshot(), { accountScope: "account", secrets: {}, complete: false, removed: [] });
  await store.upsert({ NEW_KEY: "new" });
  assert.equal(await store.reveal("NEW_KEY"), "new");
  assert.deepEqual(await store.listKeys(["SAVED_KEY", "NEW_KEY"]), ["NEW_KEY", "SAVED_KEY"]);
  await store.remove(["SAVED_KEY"]);
  assert.deepEqual(await store.listKeys(["SAVED_KEY"]), ["NEW_KEY"]);
  assert.deepEqual(await store.exportSnapshot(), { accountScope: "account", secrets: { NEW_KEY: "new" }, complete: false, removed: ["SAVED_KEY"] });
  await assert.rejects(() => stat(storePath), { code: "ENOENT" });
});

function createApplier(t, m, storePath) {
  const environmentPath = path.join(m.directory, "child-environment.json");
  const applier = new m.BoxSecretsApplier({
    applyToBox: async (_ctx, update) => {
      assert.equal(update.replace, true);
      await execute(process.execPath, ["-e", 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.env))', environmentPath], { env: update.env });
    },
    retryPolicy: m.scheduling.createRetryPolicy(m.scheduling.realClock, { name: "test-apply", maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 }),
    applyDeadline: m.scheduling.createDeadlinePolicy(m.scheduling.realClock, { name: "test-save", timeoutMs: 5_000 }),
    storePath,
  });
  t.after(() => applier.stop());
  return { applier, environmentPath };
}

const readSecrets = async (storePath) => JSON.parse(await readFile(storePath, "utf8")).secrets;
async function assertEnvironment(environmentPath, secrets) {
  const environment = JSON.parse(await readFile(environmentPath, "utf8"));
  // macOS 为新进程自动添加文本编码变量。
  if (process.platform === "darwin") delete environment.__CF_USER_TEXT_ENCODING;
  assert.deepEqual(environment, { ...secrets, CLOUD_AGENT_INJECTED_SECRET_NAMES: Object.keys(secrets).sort().join(",") });
}

test("重新创建 host 后合并添加和删除，子进程接收完整环境", async (t) => {
  const m = await loadModules(t), storePath = path.join(m.directory, "box-secrets.json"), ctx = m.createContext();
  await writeFile(storePath, JSON.stringify({ version: 1, secrets: { SAVED_KEY: "saved", OTHER_KEY: "other" } }), { mode: 0o600 });
  const first = createApplier(t, m, storePath);
  await first.applier.mergeSecrets(ctx, { NEW_KEY: "new" }, []);
  assert.deepEqual(await readSecrets(storePath), { SAVED_KEY: "saved", OTHER_KEY: "other", NEW_KEY: "new" });
  await assertEnvironment(first.environmentPath, await readSecrets(storePath));
  first.applier.stop();
  const second = createApplier(t, m, storePath);
  await second.applier.mergeSecrets(ctx, {}, ["SAVED_KEY"]);
  assert.deepEqual(await readSecrets(storePath), { OTHER_KEY: "other", NEW_KEY: "new" });
  await assertEnvironment(second.environmentPath, await readSecrets(storePath));
  assert.deepEqual((await second.applier.getStatus()).keys, ["NEW_KEY", "OTHER_KEY"]);
  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
});

test("缺少 box 文件时保存与应用新增密钥", async (t) => {
  const m = await loadModules(t), storePath = path.join(m.directory, "box-secrets.json");
  const { applier, environmentPath } = createApplier(t, m, storePath);
  await applier.mergeSecrets(m.createContext(), { NEW_KEY: "new" }, ["NOT_THERE"]);
  assert.deepEqual(await readSecrets(storePath), { NEW_KEY: "new" });
  await assertEnvironment(environmentPath, { NEW_KEY: "new" });
});

for (const [name, original] of Object.entries({ "invalid JSON": '{"version":1,"secrets":{"KEY":"trunc', "numeric secret": JSON.stringify({ version: 1, secrets: { KEY: 42 } }), "unknown version": JSON.stringify({ version: 2, secrets: {} }) })) {
  test(`损坏的 box 文件保留原内容：${name}`, async (t) => {
    const m = await loadModules(t), storePath = path.join(m.directory, "box-secrets.json");
    await writeFile(storePath, original, { mode: 0o600 });
    const { applier, environmentPath } = createApplier(t, m, storePath);
    await assert.rejects(() => applier.mergeSecrets(m.createContext(), { NEW_KEY: "new" }, []), m.SandBoxSecretsUnreadableError);
    assert.equal(await readFile(storePath, "utf8"), original);
    await assert.rejects(() => stat(environmentPath), { code: "ENOENT" });
  });
}

test("超过容量或使用保留名称的修改在写入之前失败", async (t) => {
  const m = await loadModules(t), storePath = path.join(m.directory, "box-secrets.json");
  const original = JSON.stringify({ version: 1, secrets: { SAVED_KEY: "saved" } });
  await writeFile(storePath, original, { mode: 0o600 });
  const { applier, environmentPath } = createApplier(t, m, storePath);
  await assert.rejects(() => applier.mergeSecrets(m.createContext(), { BIG_KEY: "x".repeat(40 * 1024) }, []));
  await assert.rejects(() => applier.mergeSecrets(m.createContext(), { PATH: "/invalid" }, []));
  assert.equal(await readFile(storePath, "utf8"), original);
  await assert.rejects(() => stat(environmentPath), { code: "ENOENT" });
});

test("local-admin 会话通过生产 push 合并到 host，并保留 Mac 文件", async (t) => {
  const m = await loadModules(t), storePath = path.join(m.directory, "box-secrets.json"), macSecretsPath = path.join(m.directory, "mac-secrets.json");
  await writeFile(storePath, JSON.stringify({ version: 1, secrets: { SAVED_KEY: "saved", OLD_KEY: "old" } }), { mode: 0o600 });
  const store = new m.SandUserSecretsStore(path.join(m.directory, "user-secrets.json"), () => "account");
  const { applier, environmentPath } = createApplier(t, m, storePath);
  const push = m.createBoxSecretsPush({
    userSecretsStore: store, isAccountDeparting: () => false,
    setBoxSecrets: (request) => request.merge ? applier.mergeSecrets(m.createContext(), request.secrets, request.removeKeys) : applier.setSecrets(m.createContext(), request.secrets),
    report: (report) => assert.equal(report.outcome, "ok"), macSecretsPath,
  });
  assert.equal(await push.push("resync"), true);
  await assert.rejects(() => stat(environmentPath), { code: "ENOENT" });
  await store.upsert({ NEW_KEY: "new" });
  await store.remove(["OLD_KEY"]);
  await push.pushOrThrow("edit");
  assert.deepEqual(await readSecrets(storePath), { SAVED_KEY: "saved", NEW_KEY: "new" });
  await assertEnvironment(environmentPath, await readSecrets(storePath));
  assert.deepEqual(await store.listKeys((await applier.getStatus()).keys), ["NEW_KEY", "SAVED_KEY"]);
  await assert.rejects(() => stat(macSecretsPath), { code: "ENOENT" });
});
