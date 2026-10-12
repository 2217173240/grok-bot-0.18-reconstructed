import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

test("桌面截图通过真实 shell 原样传递 DISPLAY，特殊字符不能执行命令", { skip: process.platform === "win32", timeout: 30_000 }, async (t) => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "computer-display-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, "computer.mjs");
  await build({ entryPoints: [path.join(root, "source/host/box/local-computer-use.ts")], outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const { captureDesktopPng } = await import(pathToFileURL(outfile).href);

  // 临时可执行程序通过真实进程和管道记录 argv；这里验证 shell 边界，不执行图像渲染。
  await writeFile(path.join(directory, "xwd"), '#!/bin/sh\nprintf "%s\\0" "$@"\n', { mode: 0o755 });
  await writeFile(path.join(directory, "convert"), '#!/bin/sh\ncat\n', { mode: 0o755 });
  const savedPath = process.env.PATH;
  const savedDisplay = process.env.DISPLAY;
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = savedDisplay;
  });
  process.env.PATH = `${directory}${path.delimiter}${savedPath ?? "/usr/bin:/bin"}`;
  for (const value of [
    ":1",
    ":1$(printf UNEXPECTED_SUBSTITUTION)",
    ":1`printf UNEXPECTED_BACKTICK`",
    ':1 "quoted" \'single\' spaces; printf UNEXPECTED_COMMAND',
    ":1\\backslash\nsecond line",
  ]) {
    process.env.DISPLAY = value;
    assert.deepEqual((await captureDesktopPng()).toString().split("\0"), ["-root", "-display", value, "-silent", ""], value);
  }
  delete process.env.DISPLAY;
  assert.deepEqual((await captureDesktopPng()).toString().split("\0"), ["-root", "-display", ":1", "-silent", ""]);
});
