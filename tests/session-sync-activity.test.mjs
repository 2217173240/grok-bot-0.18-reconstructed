import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

test("session sync activity publishes real files and owns its lifecycle", async (t) => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const dir = await mkdtemp(path.join(root, ".cache/session-sync-activity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, "activity.mjs");
  await build({ entryPoints: [path.join(root, "source/host/box/session-sync-activity.ts")], bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent" });
  const { SessionSyncActivity, SESSION_SYNC_ACTIVITY_HEARTBEAT_MS } = await import(pathToFileURL(outfile).href);
  const read = async (file) => JSON.parse(await readFile(file, "utf8"));

  await t.test("initial busy, atomic immediate updates, private permissions, heartbeat and disposal", async () => {
    const file = path.join(dir, "lifecycle/activity.json");
    const activity = new SessionSyncActivity(file);
    try {
      const before = Date.now();
      activity.start();
      const initial = await read(file);
      assert.deepEqual(Object.keys(initial).sort(), ["pid", "state", "updatedAt", "version"]);
      assert.equal(initial.version, 1);
      assert.equal(initial.state, "busy");
      assert.equal(initial.pid, process.pid);
      assert.ok(initial.updatedAt >= before && initial.updatedAt <= Date.now());
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
      const previous = await open(file, "r");
      try {
        activity.setBusy(false);
        assert.equal((await read(file)).state, "idle");
        assert.equal(JSON.parse(await previous.readFile("utf8")).state, "busy");
      } finally {
        await previous.close();
      }
      const idle = await read(file);
      activity.start();
      await setTimeout(SESSION_SYNC_ACTIVITY_HEARTBEAT_MS + 150);
      const refreshed = await read(file);
      assert.equal(refreshed.state, "idle");
      assert.ok(refreshed.updatedAt > idle.updatedAt);
      activity.setBusy(true);
      assert.equal((await read(file)).state, "busy");
      assert.deepEqual(await readdir(path.dirname(file)), ["activity.json"]);
      activity.dispose();
      activity.dispose();
      activity.start();
      activity.setBusy(false);
      await setTimeout(SESSION_SYNC_ACTIVITY_HEARTBEAT_MS + 150);
      assert.deepEqual(await readdir(path.dirname(file)), []);
    } finally {
      activity.dispose();
    }
  });

  await t.test("setBusy before start publishes immediately and retains the real state", async () => {
    const file = path.join(dir, "early/activity.json");
    const activity = new SessionSyncActivity(file);
    try {
      activity.setBusy(false);
      assert.equal((await read(file)).state, "idle");
      activity.start();
      assert.equal((await read(file)).state, "idle");
    } finally {
      activity.dispose();
    }
    await assert.rejects(stat(file), { code: "ENOENT" });
  });

  await t.test("disposal preserves a replacement publisher's file", async () => {
    const file = path.join(dir, "ownership/activity.json");
    const first = new SessionSyncActivity(file);
    const second = new SessionSyncActivity(file);
    try {
      first.start();
      second.setBusy(false);
      first.dispose();
      assert.equal((await read(file)).state, "idle");
    } finally {
      first.dispose();
      second.dispose();
    }
    await assert.rejects(stat(file), { code: "ENOENT" });
  });

  await t.test("filesystem publication errors propagate", async () => {
    const blocker = path.join(dir, "blocked");
    await writeFile(blocker, "occupied");
    const activity = new SessionSyncActivity(path.join(blocker, "activity.json"));
    assert.throws(() => activity.start(), { code: "EEXIST" });
    activity.dispose();
  });
});
