import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay, setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

test("升级产物与真实 inspector 采样使用独占文件且拒绝链接目录", { skip: process.platform === "win32", timeout: 30_000 }, async t => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "host-artifact-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, "artifacts.cjs");
  await build({ stdin: { contents: 'export { stageHostBundleUpgrade } from "./source/host/extensions/host-upgrade/host-bundle-upgrade.ts"; export { createPressureCpuProfiler, createInspectorBackend, PRESSURE_CPU_PROFILE_PREFIX } from "./source/host/extensions/telemetry/pressure-cpu-profiler.ts";', resolveDir: root, loader: "ts" }, outfile, bundle: true, packages: "external", platform: "node", format: "cjs", logLevel: "silent" });
  const api = require(outfile);
  const argsFor = folder => ({ dir: folder, version: "0123456", bytes: Uint8Array.from([31, 139, 8, 0, 255]), nowMs: 1234, reason: "boundary-test", forceNow: true, stagedBundlePath: path.join(folder, "incoming-host-bundle.tgz"), stagedBundlePartPath: path.join(folder, "custom-bundle.part"), commandPath: path.join(folder, "command.json"), commandPartPath: path.join(folder, "custom-command.part") });

  await t.test("bundle 先于 command 发布且固定 part 链接不被写入", async () => {
    const folder = path.join(directory, "upgrade");
    await mkdir(folder);
    const args = argsFor(folder);
    const target = path.join(folder, "preserved");
    await writeFile(target, "untouched");
    for (const file of [args.stagedBundlePath, args.stagedBundlePartPath, args.commandPath, args.commandPartPath]) await symlink(target, file);
    const command = await api.stageHostBundleUpgrade(args);
    assert.deepEqual(await readFile(args.stagedBundlePath), Buffer.from(args.bytes));
    assert.deepEqual(JSON.parse(await readFile(args.commandPath, "utf8")), { id: "upgrade-0123456", kind: "upgrade", issuedAtMs: 1234, mode: "bundle", version: "0123456", bundlePath: args.stagedBundlePath, reason: "boundary-test", forceNow: true });
    assert.equal(command.bundlePath, args.stagedBundlePath);
    assert.equal(await readFile(target, "utf8"), "untouched");
    assert.equal((await lstat(args.stagedBundlePath)).isSymbolicLink(), false);
    assert.equal((await lstat(args.commandPath)).isSymbolicLink(), false);
    assert.deepEqual((await readdir(folder)).sort(), ["command.json", "custom-bundle.part", "custom-command.part", "incoming-host-bundle.tgz", "preserved"]);

    const failure = path.join(directory, "upgrade-command-failure");
    const failingArgs = argsFor(failure);
    await mkdir(failingArgs.commandPath, { recursive: true });
    await assert.rejects(api.stageHostBundleUpgrade(failingArgs));
    assert.deepEqual(await readFile(failingArgs.stagedBundlePath), Buffer.from(failingArgs.bytes));
    assert.deepEqual((await readdir(failure)).sort(), ["command.json", "incoming-host-bundle.tgz"]);
  });

  await t.test("升级拒绝预置父目录链接", async () => {
    const target = path.join(directory, "upgrade-target");
    const linked = path.join(directory, "upgrade-linked");
    await mkdir(target);
    await symlink(target, linked);
    await assert.rejects(api.stageHostBundleUpgrade(argsFor(linked)), /real directory/);
    assert.deepEqual(await readdir(target), []);
  });

  async function capture(folder) {
    const backend = api.createInspectorBackend();
    let stopped;
    const completed = new Promise(resolve => { stopped = resolve; });
    const stop = backend.stop;
    // 观察真实 inspector 停止完成，不替换采样数据或任何文件系统操作。
    backend.stop = async () => { try { return await stop(); } finally { stopped(); } };
    const captured = [];
    const profiler = api.createPressureCpuProfiler({ directory: folder, backend, profileDurationMs: 20, minIntervalMs: 0, maxRetainedProfiles: 1, onCaptured: file => captured.push(file) });
    profiler.onPressure();
    profiler.onPressure();
    const tick = setInterval(() => profiler.onTick(), 10);
    let timeout;
    try {
      await Promise.race([completed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("inspector did not finish")), 5000); })]);
      await immediate();
      return captured;
    } finally {
      clearInterval(tick);
      clearTimeout(timeout);
      profiler.dispose();
    }
  }

  await t.test("真实 CPU profile 保留最终目录、回调和保留数量，文件模式为0600", async () => {
    const folder = path.join(directory, "profiles");
    await mkdir(folder);
    const target = path.join(directory, "profile-target");
    await writeFile(target, "preserved");
    await symlink(target, path.join(folder, `${api.PRESSURE_CPU_PROFILE_PREFIX}0.cpuprofile`));
    const [first] = await capture(folder);
    assert.equal(path.dirname(first), folder);
    assert.match(path.basename(first), /^sand-host-pressure-\d+-[a-f0-9]{16}\.cpuprofile$/);
    const profile = JSON.parse(await readFile(first, "utf8"));
    assert.ok(profile.nodes.length > 0);
    assert.ok(profile.endTime >= profile.startTime);
    assert.equal((await stat(first)).mode & 0o777, 0o600 & ~process.umask());
    assert.equal(await readFile(target, "utf8"), "preserved");
    await delay(2);
    const [second] = await capture(folder);
    assert.notEqual(second, first);
    assert.deepEqual(await readdir(folder), [path.basename(second)]);
  });

  await t.test("真实采样完成后拒绝链接目录，不产生文件或回调", async () => {
    const target = path.join(directory, "profile-dir-target");
    const linked = path.join(directory, "profile-linked");
    await mkdir(target);
    await symlink(target, linked);
    assert.deepEqual(await capture(linked), []);
    assert.deepEqual(await readdir(target), []);
  });
});
