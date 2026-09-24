import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { build } from "esbuild";

const repoRoot = path.resolve(import.meta.dirname, "..");
const execute = promisify(execFile);

async function createFixture(t, initial) {
  await mkdir(path.join(repoRoot, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(repoRoot, ".cache/secrets-durability-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "modules.cjs");
  await build({
    stdin: {
      contents: [
        'export * from "./source/host/extensions/secrets/secrets-service.ts";',
        'export { createContext } from "./source/packages/context/core.ts";',
        'export * as scheduling from "./source/internal/scheduling.ts";',
      ].join("\n"),
      resolveDir: repoRoot,
      loader: "ts",
    },
    outfile: output,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node26",
    logLevel: "error",
  });
  const m = createRequire(output)(output);
  const dataDirectory = path.join(directory, "data");
  await mkdir(dataDirectory);
  const storePath = path.join(dataDirectory, "box-secrets.json");
  const environmentPath = path.join(directory, "child-environment.json");
  if (initial !== undefined) {
    await writeFile(storePath, typeof initial === "string" ? initial : JSON.stringify({ version: 1, secrets: initial }), { mode: 0o600 });
  }
  const ctx = m.createContext();
  function createApplier() {
    const applier = new m.BoxSecretsApplier({
      applyToBox: async (_ctx, update) => {
        assert.equal(update.replace, true);
        await execute(process.execPath, [
          "-e",
          'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.env))',
          environmentPath,
        ], { env: update.env });
      },
      retryPolicy: m.scheduling.createRetryPolicy(m.scheduling.realClock, {
        name: "durability-apply", maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1,
      }),
      applyDeadline: m.scheduling.createDeadlinePolicy(m.scheduling.realClock, {
        name: "durability-save", timeoutMs: 5_000,
      }),
      storePath,
    });
    t.after(() => applier.stop());
    return applier;
  }
  return {
    ...m, ctx, dataDirectory, storePath, environmentPath, createApplier,
    readSaved: async () => JSON.parse(await readFile(storePath, "utf8")).secrets,
    readEnvironment: async () => JSON.parse(await readFile(environmentPath, "utf8")),
  };
}

for (const operation of ["replace", "merge"]) {
  test(`写入失败后的 ${operation} 不进入后续合并`, { skip: process.getuid?.() === 0 }, async (t) => {
    const f = await createFixture(t, { SAVED_KEY: "saved", OTHER_KEY: "other" });
    const applier = f.createApplier();
    await applier.applyPersisted(f.ctx);
    const before = await applier.getStatus();
    const original = await readFile(f.storePath, "utf8");
    await chmod(f.dataDirectory, 0o500);
    try {
      await assert.rejects(
        () => operation === "replace"
          ? applier.setSecrets(f.ctx, { FAILED_KEY: "failed" })
          : applier.mergeSecrets(f.ctx, { FAILED_KEY: "failed" }, ["SAVED_KEY"]),
        { code: "EACCES" },
      );
      assert.deepEqual(await applier.getStatus(), before);
      assert.equal(await readFile(f.storePath, "utf8"), original);
      assert.equal((await f.readEnvironment()).FAILED_KEY, undefined);
    } finally {
      await chmod(f.dataDirectory, 0o700);
    }
    await applier.mergeSecrets(f.ctx, { NEXT_KEY: "next" }, []);
    const expected = { SAVED_KEY: "saved", OTHER_KEY: "other", NEXT_KEY: "next" };
    assert.deepEqual(await f.readSaved(), expected);
    const environment = await f.readEnvironment();
    for (const [key, value] of Object.entries(expected)) assert.equal(environment[key], value);
    assert.equal(environment.CLOUD_AGENT_INJECTED_SECRET_NAMES, "NEXT_KEY,OTHER_KEY,SAVED_KEY");
    assert.equal(environment.FAILED_KEY, undefined);
    assert.equal((await stat(f.storePath)).mode & 0o777, 0o600);
  });
}

test("同时提交的合并按调用顺序保存，重启后恢复全部修改", async (t) => {
  const f = await createFixture(t, { SAVED_KEY: "saved", REMOVE_KEY: "remove" });
  const applier = f.createApplier();
  await Promise.all([
    applier.mergeSecrets(f.ctx, { FIRST_KEY: "first", SHARED_KEY: "first" }, ["REMOVE_KEY"]),
    applier.mergeSecrets(f.ctx, { SECOND_KEY: "second", SHARED_KEY: "second" }, []),
    applier.mergeSecrets(f.ctx, { THIRD_KEY: "third" }, ["FIRST_KEY"]),
  ]);
  const expected = { SAVED_KEY: "saved", SECOND_KEY: "second", SHARED_KEY: "second", THIRD_KEY: "third" };
  assert.deepEqual(await f.readSaved(), expected);
  applier.stop();
  const restarted = f.createApplier();
  await restarted.applyPersisted(f.ctx);
  assert.deepEqual((await restarted.getStatus()).keys, Object.keys(expected).sort());
  const environment = await f.readEnvironment();
  for (const [key, value] of Object.entries(expected)) assert.equal(environment[key], value);
  assert.equal(environment.CLOUD_AGENT_INJECTED_SECRET_NAMES, "SAVED_KEY,SECOND_KEY,SHARED_KEY,THIRD_KEY");
  assert.equal(environment.REMOVE_KEY, undefined);
  assert.equal(environment.FIRST_KEY, undefined);
});

test("启动读取期间查询状态会返回已保存的名称", async (t) => {
  const f = await createFixture(t, { SAVED_KEY: "saved" });
  const applier = f.createApplier();
  const startup = applier.applyPersisted(f.ctx);
  assert.deepEqual((await applier.getStatus()).keys, ["SAVED_KEY"]);
  await startup;
  assert.equal((await applier.getStatus()).isApplied, true);
  assert.equal((await f.readEnvironment()).SAVED_KEY, "saved");
});

test("首次查询状态直接读取已保存的名称", async (t) => {
  const f = await createFixture(t, { SAVED_KEY: "saved" });
  const applier = f.createApplier();
  assert.deepEqual(await applier.getStatus(), {
    keys: ["SAVED_KEY"], isApplied: false, lastAppliedAtMs: null,
  });
});

for (const original of [
  '{"version":1,"secrets":{"SAVED_KEY":"truncated',
  JSON.stringify({ version: 1, secrets: { SAVED_KEY: 42 } }),
  JSON.stringify({ version: 1, secrets: { PATH: "/invalid" } }),
  JSON.stringify({ version: 2, secrets: {} }),
]) {
  test(`损坏的启动文件明确报错并保留内容：${original}`, async (t) => {
    const f = await createFixture(t, original);
    const applier = f.createApplier();
    await assert.rejects(() => applier.applyPersisted(f.ctx), f.SandBoxSecretsUnreadableError);
    await assert.rejects(() => applier.getStatus(), f.SandBoxSecretsUnreadableError);
    await assert.rejects(() => applier.mergeSecrets(f.ctx, { NEW_KEY: "new" }, []), f.SandBoxSecretsUnreadableError);
    await assert.rejects(() => applier.setSecrets(f.ctx, { NEW_KEY: "new" }), f.SandBoxSecretsUnreadableError);
    assert.equal(await readFile(f.storePath, "utf8"), original);
    await assert.rejects(() => stat(f.environmentPath), { code: "ENOENT" });
  });
}
