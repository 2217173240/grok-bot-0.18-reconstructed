import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import test from "node:test";

test("Linux XTEST 在独立 Xvfb 正确发送和释放组合键", { skip: process.platform !== "linux", timeout: 15_000 }, async () => {
  await promisify(execFile)("python3", [path.join(import.meta.dirname, "xtest-key-chords.py")], { timeout: 12_000 });
});
