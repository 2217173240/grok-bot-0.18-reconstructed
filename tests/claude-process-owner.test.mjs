import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

test("Claude 进程组在正常退出、取消和启动失败后释放，保留其他会话", { timeout: 15_000 }, async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/claude-owner-"));
  const owners = [];
  try {
    const outfile = path.join(directory, "owner.mjs");
    await build({ entryPoints: [path.join(root, "source/host/extensions/inference/claude-process-owner.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    const { createClaudeProcessOwner, liveClaudeProcessGroup } = await import(pathToFileURL(outfile).href);
    const tracked = () => {
      let child;
      const owner = createClaudeProcessOwner(value => { child = value; value.stderr.resume(); });
      owners.push(owner);
      return { owner, get child() { return child; } };
    };
    const launch = (item, command, args, signal = new AbortController().signal) => item.owner.spawn({ command, args, cwd: directory, env: process.env, signal });
    const other = tracked();
    launch(other, "/bin/sleep", ["30"]);
    await once(other.child, "spawn");

    const completed = tracked();
    launch(completed, process.execPath, ["-e", "const {spawn}=require('node:child_process'); const child=spawn('/bin/sleep',['30'],{stdio:'ignore'}); child.once('spawn',()=>process.exit(0));"]);
    assert.equal((await once(completed.child, "exit"))[0], 0);
    await completed.owner.close();
    assert.deepEqual(await liveClaudeProcessGroup(completed.child.pid), []);
    assert.ok((await liveClaudeProcessGroup(other.child.pid)).includes(other.child.pid));

    const canceled = tracked();
    const abort = new AbortController();
    launch(canceled, "/bin/sh", ["-c", "trap '' TERM; printf ready; sleep 30"], abort.signal);
    await once(canceled.child.stdout, "data");
    abort.abort(new Error("cancel owned group"));
    await canceled.owner.close();
    assert.deepEqual(await liveClaudeProcessGroup(canceled.child.pid), []);
    assert.ok((await liveClaudeProcessGroup(other.child.pid)).includes(other.child.pid));

    const failed = tracked();
    launch(failed, path.join(directory, "missing-executable"), []);
    assert.equal((await once(failed.child, "error"))[0].code, "ENOENT");
    await failed.owner.close();
    assert.deepEqual(failed.owner.processIds, []);
    await other.owner.close();
    assert.deepEqual(await liveClaudeProcessGroup(other.child.pid), []);
  } finally {
    await Promise.all(owners.map(owner => owner.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
