import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const run = promisify(execFile);

test("Electron 解压依赖完整读取 stored、deflate 文件并保留符号链接和可执行权限", { timeout: 15_000 }, async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/electron-zip-"));
  try {
    const source = path.join(directory, "source");
    const destination = path.join(directory, "extracted");
    const archive = path.join(directory, "fixture.zip");
    await mkdir(source);
    const stored = randomBytes(128 * 1024);
    const deflated = Buffer.alloc(2 * 1024 * 1024, "electron-extraction-regression\n");
    await writeFile(path.join(source, "stored.bin"), stored);
    await writeFile(path.join(source, "deflated.bin"), deflated);
    await writeFile(path.join(source, "executable"), "executable payload\n");
    await chmod(path.join(source, "executable"), 0o755);
    await symlink("stored.bin", path.join(source, "linked.bin"));
    await run("zip", ["-q", "-0", archive, "stored.bin"], { cwd: source });
    await run("zip", ["-q", "-9", "-y", archive, "deflated.bin", "executable", "linked.bin"], { cwd: source });
    const extraction = await run(process.execPath, ["--input-type=module", "--eval", "import extract from 'extract-zip'; await extract(process.argv[1], { dir: process.argv[2] }); console.log('extracted');", archive, destination], {
      cwd: root,
      env: { ...process.env, TMPDIR: directory },
      timeout: 10_000,
    });
    assert.equal(extraction.stdout.trim(), "extracted");
    assert.deepEqual(await readFile(path.join(destination, "stored.bin")), stored);
    assert.deepEqual(await readFile(path.join(destination, "deflated.bin")), deflated);
    assert.equal(await readFile(path.join(destination, "executable"), "utf8"), "executable payload\n");
    assert.equal((await lstat(path.join(destination, "executable"))).mode & 0o777, 0o755);
    assert.equal(await readlink(path.join(destination, "linked.bin")), "stored.bin");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
