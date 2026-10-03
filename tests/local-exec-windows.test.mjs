import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".cache/local-exec-windows-"));
const outfile = path.join(directory, "native.mjs");
await build({ entryPoints: [path.join(root, "source/electron-main/local-exec/local-exec-native.ts")], outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
const native = await import(pathToFileURL(outfile).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test("Windows CIM 身份读取使用数值时间戳并保留完整命令", () => {
  const identity = { pid: 42, startEpochMs: 1780000000123, command: '"C:\\Program Files\\node.exe" "C:\\测试 folder\\main.cjs" --sand-local-exec-generation=uuid' };
  assert.deepEqual(native.parseWindowsProcessIdentity(42, JSON.stringify(identity)), identity);
  for (const output of ["", "null", "{}", '{"startEpochMs":"/Date(1780000000123)/","command":"node"}', '{"startEpochMs":1,"command":""}']) assert.equal(native.parseWindowsProcessIdentity(42, output), null);
  assert.equal(native.parseWindowsProcessIdentity(-1, JSON.stringify(identity)), null);
  assert.throws(() => native.terminateWindowsProcessTree({ ...identity, pid: process.pid }), /Invalid local-exec/);
});

test("generation 核验接受完整引用参数并拒绝前后缀", () => {
  const entry = 'C:\\Users\\测试 folder\\main.cjs';
  const flag = "--sand-local-exec-generation=uuid";
  for (const command of [`node "${entry}" ${flag}`, `node "${entry}" "${flag}"`]) assert(native.commandCarriesLocalExecGeneration(command, entry, "uuid"));
  for (const command of [`node "${entry}.other" ${flag}`, `node "${entry}" ${flag}-other`, `node "prefix${entry}" ${flag}`, `node "${entry}" prefix${flag}`]) assert.equal(native.commandCarriesLocalExecGeneration(command, entry, "uuid"), false);
});

async function startProcess(t) {
  const subdirectory = await mkdtemp(path.join(directory, "真实 process "));
  const entry = path.join(subdirectory, "worker.cjs");
  const report = path.join(subdirectory, "report.json");
  await copyFile(path.join(root, "tests/fixtures/local-exec-windows-process.cjs"), entry);
  const spawned = await native.spawnLocalExecDaemon({ logPath: path.join(subdirectory, "output.log"), mainPath: entry, env: { LOCAL_EXEC_PROCESS_REPORT: report } });
  let details;
  t.after(async () => {
    if (details?.childPid && native.isProcessAlive(details.childPid)) process.kill(details.childPid);
    if (spawned.child.pid && native.isProcessAlive(spawned.child.pid)) spawned.child.kill();
    for (let i = 0; i < 100 && spawned.child.exitCode === null && spawned.child.signalCode === null; i++) await delay(20);
  });
  for (let i = 0; i < 100; i++) {
    try { details = JSON.parse(await readFile(report, "utf8")); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; await delay(20); }
  }
  assert(details, "真实父子进程未完成启动");
  return { spawned, details, subdirectory };
}

test("真实 detached 进程保留当前用户路径与 generation 环境", { timeout: 30000 }, async t => {
  const { spawned, details } = await startProcess(t);
  assert.equal(details.pid, spawned.child.pid);
  assert.equal(details.generation, spawned.generationToken);
  assert.equal(details.args[1], spawned.entryRealpath);
  const identity = native.readProcessIdentity(details.pid);
  assert(identity);
  assert(native.commandCarriesLocalExecGeneration(identity.command, spawned.entryRealpath, spawned.generationToken), JSON.stringify({ identity, entry: spawned.entryRealpath }));
  assert(identity.startEpochMs <= Date.now());
  assert(native.isProcessAlive(details.childPid));
});

test("Windows 创建时间和 generation 拒绝不匹配身份，已核验父子进程共同终止", { skip: process.platform !== "win32", timeout: 60000 }, async t => {
  const { spawned, details, subdirectory } = await startProcess(t);
  const identity = native.readProcessIdentity(details.pid);
  assert(identity);
  assert.throws(() => native.terminateWindowsProcessTree({ ...identity, startEpochMs: identity.startEpochMs - 1 }));
  assert(native.isProcessAlive(details.pid));
  assert(native.isProcessAlive(details.childPid));
  const discovery = path.join(subdirectory, "discovery.json");
  const published = { pid: details.pid, startedAt: Date.now(), entryRealpath: spawned.entryRealpath, generationToken: "other-generation" };
  await writeFile(discovery, JSON.stringify(published));
  await native.killLocalExecDaemon(discovery, { expectedEntryRealpath: spawned.entryRealpath });
  assert(native.isProcessAlive(details.pid));
  await writeFile(discovery, JSON.stringify({ ...published, generationToken: spawned.generationToken }));
  await native.killLocalExecDaemon(discovery, { expectedEntryRealpath: spawned.entryRealpath });
  assert.equal(native.isProcessAlive(details.pid), false);
  assert.equal(native.isProcessAlive(details.childPid), false);
});
