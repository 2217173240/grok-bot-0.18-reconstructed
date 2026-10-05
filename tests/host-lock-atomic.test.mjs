import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile, readFile, stat, rm, rename } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".cache/lock-atomic-"));
const outfile = path.join(directory, "lock.mjs");
await build({ entryPoints: [path.join(root, "source/host/host-lock.ts")], outfile, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
const { acquireHostLock } = await import(pathToFileURL(outfile).href);
test.after(() => rm(directory, { recursive: true, force: true }));
const script = path.join(directory, "host-main.cjs");
await writeFile(script, `
const fs = require('node:fs');
let handle;
let closing = false;
const lockPath = process.env.LOCK_TEST_PATH;
function release() {
  if (closing) return;
  closing = true;
  if (handle) {
    fs.appendFileSync(lockPath + '.events', 'release ' + process.pid + '\\n');
    fs.unlinkSync(lockPath + '.critical');
    handle.release();
  }
  process.exit(0);
}
process.on('SIGTERM', () => setTimeout(release, Number(process.env.LOCK_TEST_EXIT_DELAY || 0)));
process.on('message', async message => {
  if (message === 'release') return release();
  if (message !== 'go') return;
  try {
    const { acquireHostLock } = await import('./lock.mjs');
    const result = await acquireHostLock({ path: lockPath });
    handle = result.lock;
    fs.writeFileSync(lockPath + '.critical', String(process.pid), { flag: 'wx' });
    fs.appendFileSync(lockPath + '.events', 'acquire ' + process.pid + '\\n');
    process.send({ acquired: true });
  } catch (error) { process.send({ error: error.message }); process.exit(1); }
});
process.send({ ready: true });
`);

async function worker(t, lockPath, extra = {}) {
  const proc = fork(script, [], { execArgv: [], execPath: extra.execPath ?? process.execPath, env: { ...process.env, LOCK_TEST_PATH: lockPath, ...extra.env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  proc.stderr.on('data', data => { stderr += data; });
  const ended = once(proc, 'exit');
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); await ended; });
  // 子进程提前退出时报告原因，并清除等待消息的监听器。
  const nextMessage = async () => {
    const controller = new AbortController();
    try {
      return await Promise.race([
        once(proc, 'message', { signal: controller.signal }).then(([value]) => value),
        ended.then(([code, signal]) => { throw new Error(`worker exited before IPC message (code=${code}, signal=${signal}, stderr=${stderr})`); }),
      ]);
    } finally { controller.abort(); }
  };
  assert.deepEqual(await nextMessage(), { ready: true }, stderr);
  return { proc, ended, go() { const message = nextMessage(); proc.send('go'); return message; } };
}

test('真实并发进程在整个持有期间互斥，接管等待旧进程退出', { timeout: 30000 }, async t => {
  const lockPath = path.join(directory, 'race.lock');
  await writeFile(lockPath, String(process.pid));
  const workers = await Promise.all(Array.from({ length: 12 }, () => worker(t, lockPath)));
  const results = await Promise.all(workers.map(w => w.go()));
  assert(results.some(r => r.acquired));
  await Promise.all(workers.map(async w => {
    if (!w.proc.connected) return;
    // 检查通道后进程仍可能退出；后续统一等待 exit，确认清理完成。
    await new Promise((resolve, reject) => w.proc.send('release', error => {
      if (error && !['ERR_IPC_CHANNEL_CLOSED', 'EPIPE'].includes(error.code)) reject(error);
      else resolve();
    }));
  }));
  await Promise.all(workers.map(w => w.ended));
  const active = new Set();
  for (const line of (await readFile(lockPath + '.events', 'utf8')).trim().split('\n')) {
    const [event, pid] = line.split(' ');
    if (event === 'acquire') { active.add(pid); assert.equal(active.size, 1); }
    else assert(active.delete(pid));
  }
  assert.equal(active.size, 0);
  assert(!results.some(r => r.error?.includes('EEXIST')), JSON.stringify(results));
});

test('崩溃释放内核锁且 guard inode 不变，旧句柄不能删除后继记录', async t => {
  const lockPath = path.join(directory, 'crash.lock');
  const child = await worker(t, lockPath);
  assert.deepEqual(await child.go(), { acquired: true });
  const inode = (await stat(lockPath + '.sqlite')).ino;
  child.proc.kill('SIGKILL');
  await child.ended;
  const first = await acquireHostLock({ path: lockPath });
  assert.equal(first.outcome, 'reclaimed-stale');
  first.lock.release();
  const second = await acquireHostLock({ path: lockPath });
  const metadata = await readFile(lockPath, 'utf8');
  first.lock.release();
  assert.equal(await readFile(lockPath, 'utf8'), metadata);
  await assert.rejects(acquireHostLock({ path: lockPath }), /already holds/);
  assert.equal(await readFile(lockPath, 'utf8'), metadata);
  second.lock.release();
  assert.equal((await stat(lockPath + '.sqlite')).ino, inode);
});

test('损坏与 IO 错误明确失败且不改变 PID 文件，预取消不创建锁', async () => {
  const lockPath = path.join(directory, 'invalid.lock');
  await writeFile(lockPath, '123');
  await writeFile(lockPath + '.sqlite', 'not a database');
  await assert.rejects(acquireHostLock({ path: lockPath }), /database/);
  assert.equal(await readFile(lockPath, 'utf8'), '123');
  const ioPath = path.join(directory, 'io.lock');
  await mkdir(ioPath);
  await assert.rejects(acquireHostLock({ path: ioPath }), /EISDIR/);
  await rm(ioPath, { recursive: true });
  const retry = await acquireHostLock({ path: ioPath });
  retry.lock.release();
  const cancelled = path.join(directory, 'cancelled.lock');
  await assert.rejects(acquireHostLock({ path: cancelled, signal: AbortSignal.abort() }), /abort/i);
  await assert.rejects(stat(cancelled + '.sqlite'), { code: 'ENOENT' });
});

test('真实接管等待期间取消不发布新 owner', async t => {
  const lockPath = path.join(directory, 'cancel-takeover.lock');
  const child = await worker(t, lockPath, { env: { LOCK_TEST_EXIT_DELAY: '1500' } });
  assert.deepEqual(await child.go(), { acquired: true });
  const before = await readFile(lockPath, 'utf8');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try { await assert.rejects(acquireHostLock({ path: lockPath, signal: controller.signal }), /abort/i); }
  finally { clearTimeout(timer); }
  assert.equal(await readFile(lockPath, 'utf8'), before);
  process.kill(child.proc.pid, 0);
  child.proc.send('release');
  await child.ended;
});

test('Electron-as-Node 实际 SQLite guard 可获取和释放', { skip: process.platform !== 'darwin' }, async t => {
  const lockPath = path.join(directory, 'electron.lock');
  const child = await worker(t, lockPath, { execPath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.deepEqual(await child.go(), { acquired: true });
  child.proc.send('release');
  await child.ended;
});

test('真实接管等候旧 host 完全退出，启动标识不匹配时保留存活进程', async t => {
  const lockPath = path.join(directory, 'takeover.lock');
  const child = await worker(t, lockPath, { env: { LOCK_TEST_EXIT_DELAY: '300' } });
  assert.deepEqual(await child.go(), { acquired: true });
  const record = JSON.parse(await readFile(lockPath, 'utf8'));
  await writeFile(lockPath, JSON.stringify({ ...record, processStartId: 'different-start' }));
  await assert.rejects(acquireHostLock({ path: lockPath }), /Cannot verify/);
  process.kill(child.proc.pid, 0);
  await writeFile(lockPath, JSON.stringify(record));
  const result = await acquireHostLock({ path: lockPath });
  assert.equal(result.outcome, 'took-over');
  assert.throws(() => process.kill(child.proc.pid, 0), { code: 'ESRCH' });
  await child.ended;
  result.lock.release();
});

test('既有 WAL guard 转为 rollback journal，真实 SQLite busy 不改元数据', async () => {
  const lockPath = path.join(directory, 'wal.lock');
  const setup = new DatabaseSync(lockPath + '.sqlite');
  setup.exec('PRAGMA journal_mode=WAL; CREATE TABLE marker(value)');
  setup.close();
  const result = await acquireHostLock({ path: lockPath });
  result.lock.release();
  const guard = new DatabaseSync(lockPath + '.sqlite');
  assert.equal(guard.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  guard.exec('BEGIN EXCLUSIVE');
  try {
    await assert.rejects(acquireHostLock({ path: lockPath }), /remained busy/);
    await assert.rejects(stat(lockPath), { code: 'ENOENT' });
  } finally { guard.exec('ROLLBACK'); guard.close(); }
});

test('真实 guard 被改名替换后拒绝与存活 host 并行持有', async t => {
  const lockPath = path.join(directory, 'replaced-guard.lock');
  const child = await worker(t, lockPath);
  assert.deepEqual(await child.go(), { acquired: true });
  const metadata = await readFile(lockPath, 'utf8');
  const originalInode = (await stat(lockPath + '.sqlite')).ino;
  await rename(lockPath + '.sqlite', lockPath + '.sqlite.previous');
  await assert.rejects(acquireHostLock({ path: lockPath }), /guard may have been replaced/);
  assert.notEqual((await stat(lockPath + '.sqlite')).ino, originalInode);
  assert.equal(await readFile(lockPath, 'utf8'), metadata);
  process.kill(child.proc.pid, 0);
  child.proc.send('release');
  await child.ended;
});
