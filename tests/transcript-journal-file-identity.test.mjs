import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
await mkdir(join(repositoryRoot, ".cache"), { recursive: true });
const root = await mkdtemp(join(repositoryRoot, ".cache/transcript-file-identity-"));
after(() => rm(root, { recursive: true, force: true }));
await build({
  entryPoints: ["transcript-mirror", "transcript-journal-codec"].map(name => join(repositoryRoot, `source/host/transcript-mirror/${name}.ts`)),
  outdir: root, outExtension: { ".js": ".mjs" }, bundle: true,
  platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { FileTranscriptMirror } = await import(pathToFileURL(join(root, "transcript-mirror.mjs")).href);
const { checkpointIdentity, fileIdentity, formatTextLine } = await import(pathToFileURL(join(root, "transcript-journal-codec.mjs")).href);
const previous = { turns: [Buffer.from("first-turn")] };
const checkpoint = { turns: [...previous.turns, Buffer.from("second-turn")] };
const initial = `${formatTextLine("user", "hello")}\n`;
const appendedLine = formatTextLine("assistant", "response");
const expectedAppend = `${appendedLine}\n`;

async function createPending(id) {
  const mirror = new FileTranscriptMirror(root);
  const path = mirror.jsonlPathFor(id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, initial);
  const identity = fileIdentity(await stat(path));
  const pending = {
    version: 1, previousCheckpointHash: checkpointIdentity(previous), checkpointHash: checkpointIdentity(checkpoint),
    appendOffset: identity.size, fileDevice: identity.device, fileInode: identity.inode,
    lines: [appendedLine], cursor: { turnCount: checkpoint.turns.length },
  };
  await writeFile(mirror.pendingPathFor(id), JSON.stringify(pending));
  return { mirror, path, pending };
}

test("recovery appends a pending WAL and retains the canonical file identity", async () => {
  const id = "normal";
  const { mirror, path, pending } = await createPending(id);
  await mirror.recover(undefined, id, checkpoint, undefined);
  assert.equal(await readFile(path, "utf8"), initial + expectedAppend);
  assert.deepEqual(mirror.states.get(id), {
    bytes: Buffer.byteLength(initial + expectedAppend), device: pending.fileDevice, inode: pending.fileInode,
  });
  await assert.rejects(readFile(mirror.pendingPathFor(id)), { code: "ENOENT" });
  await mirror.recover(undefined, id, checkpoint, undefined);
  assert.equal(await readFile(path, "utf8"), initial + expectedAppend);
});

test("recovery completes a partially written WAL without duplicating the prefix", async () => {
  const id = "partial";
  const { mirror, path } = await createPending(id);
  await appendFile(path, expectedAppend.slice(0, 17));
  await mirror.recover(undefined, id, checkpoint, undefined);
  assert.equal(await readFile(path, "utf8"), initial + expectedAppend);
  await assert.rejects(readFile(mirror.pendingPathFor(id)), { code: "ENOENT" });
});

test("recovery rejects a replaced inode without changing the replacement or pending WAL", async () => {
  const id = "replaced";
  const { mirror, path, pending } = await createPending(id);
  const replacement = join(dirname(path), "replacement.jsonl");
  const replacementBytes = initial + expectedAppend.slice(0, 17);
  await writeFile(replacement, replacementBytes);
  await rename(replacement, path);
  assert.notEqual(fileIdentity(await stat(path)).inode, pending.fileInode);
  await assert.rejects(mirror.recover(undefined, id, checkpoint, undefined), /canonical transcript changed before WAL commit/);
  assert.equal(await readFile(path, "utf8"), replacementBytes);
  assert.deepEqual(JSON.parse(await readFile(mirror.pendingPathFor(id), "utf8")), pending);
});

test("recovery preserves conflicting and excessive canonical tails", async () => {
  for (const [id, tail, message] of [
    ["conflicting", "conflict", /tail conflicts/],
    ["excessive", expectedAppend + "extra", /data beyond/],
  ]) {
    const { mirror, path } = await createPending(id);
    await appendFile(path, tail);
    await assert.rejects(mirror.recover(undefined, id, checkpoint, undefined), message);
    assert.equal(await readFile(path, "utf8"), initial + tail);
  }
});

test("initial recovery accepts a complete transcript and an empty transcript", async () => {
  for (const [id, contents] of [["complete", initial], ["empty", ""]]) {
    const mirror = new FileTranscriptMirror(root);
    const path = mirror.jsonlPathFor(id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
    await mirror.recover(undefined, id, { turns: [] }, undefined);
    assert.equal(mirror.states.get(id).bytes, Buffer.byteLength(contents));
    assert.equal(await readFile(path, "utf8"), contents);
  }
});
