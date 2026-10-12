import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const execute = promisify(execFile);

test("Piscina workers ignore inherited execArgv options", async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "piscina-security-"));
  try {
    const preload = path.join(directory, "preload.cjs");
    const worker = path.join(directory, "worker.cjs");
    const runner = path.join(directory, "runner.mjs");
    await writeFile(preload, "globalThis.inheritedPreloadExecuted = true;\n");
    await writeFile(worker, "module.exports = () => globalThis.inheritedPreloadExecuted === true;\n");
    await writeFile(runner, `
import assert from "node:assert/strict";
import Piscina from "piscina";
Object.prototype.execArgv = ["--require", ${JSON.stringify(preload)}];
const pool = new Piscina({ filename: ${JSON.stringify(worker)}, minThreads: 1, maxThreads: 1 });
try {
  assert.equal(await pool.run(), false, "Worker executed inherited preload");
} finally {
  await pool.destroy();
  delete Object.prototype.execArgv;
}
`);
    // 原型污染只发生在隔离子进程中，worker 执行真实任务。
    await execute(process.execPath, [runner], { cwd: root, timeout: 15_000 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
