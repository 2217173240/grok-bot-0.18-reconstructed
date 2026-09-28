import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

assert.notEqual(process.pid, 1);
assert.equal(await readFile("/state/preserved.txt", "utf8"), "preserved across init migration");
const execute = promisify(execFile);
for (let round = 0; round < 2; round++) {
  const { stdout } = await execute(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn("sleep", ["0.1"], { detached: true, stdio: "ignore" });
    child.unref();
    process.stdout.write(String(child.pid));
  `]);
  const pid = Number(stdout);
  assert.ok(Number.isInteger(pid) && pid > 1);
  let exists = true;
  const deadline = performance.now() + 5000;
  while (exists && performance.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code !== "ESRCH") throw error; exists = false; }
    if (exists) await delay(20);
  }
  assert.equal(exists, false, "Docker init must reap the orphan, including its zombie entry");
}
console.log(JSON.stringify({ rounds: 2, orphansReaped: 2, dataPreserved: true }));
