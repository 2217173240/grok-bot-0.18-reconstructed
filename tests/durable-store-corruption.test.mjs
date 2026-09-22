// Regression guard for the durable queues' absent-versus-damaged rule.
//
// These stores write read-modify-write: each update reads the queue, merges, and
// rewrites the file. When a read or parse failure was reported as an empty list,
// the next write rebuilt the file from that empty base and destroyed whatever it
// still held — pending upgrade resumes, queued wakes, or un-acked user messages.
// The loss was silent: no error, /health fine, the UI showing the turn finished.
//
// The rule now matches the repo's own prompt-acceptance-ledger standard: an
// ABSENT file means nothing pending, an UNREADABLE file is damage, and damage is
// quarantined and marked rather than overwritten.

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function loadStores() {
  const buildRoot = await mkdtemp(path.join(tmpdir(), "grok-durable-stores-"));
  const outfile = path.join(buildRoot, "stores.mjs");
  await build({
    entryPoints: [path.join(repositoryRoot, "source/host/extensions/transcript/durable-store-file.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  const durable = await import(pathToFileURL(outfile).href);
  const compiled = {};
  for (const [key, source] of [
    ["resume", "source/host/extensions/transcript/sand-upgrade-resume-store.ts"],
    ["wake", "source/host/extensions/transcript/sand-pending-wake-store.ts"],
    ["ack", "source/host/extensions/transcript/sand-ack-obligation-store.ts"],
  ]) {
    const target = path.join(buildRoot, `${key}.mjs`);
    await build({
      entryPoints: [path.join(repositoryRoot, source)],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: target,
      logLevel: "silent",
    });
    compiled[key] = await import(pathToFileURL(target).href);
  }
  return { durable, compiled, buildRoot };
}

test("durable queues treat damage as damage, not as an empty queue", async () => {
  const { compiled, buildRoot } = await loadStores();
  const root = await mkdtemp(path.join(tmpdir(), "grok-durable-data-"));
  try {
    // --- upgrade-resume -----------------------------------------------------
    const resume = new compiled.resume.SandUpgradeResumeStore(root);
    assert.deepEqual(resume.listPending(), [], "an absent file means nothing pending");

    const resumePath = resume.filePath;
    const corruptResume = '{"version":1,"pending":[{"agentId":"agent-a"';
    await writeFile(resumePath, corruptResume);

    // A damaged read is empty so no caller acts on a partial parse…
    assert.deepEqual(resume.listPending(), []);
    // …and the next write must not rebuild the file from that empty base: the
    // unreadable bytes are moved aside intact rather than overwritten.
    resume.markPending({ agentId: "agent-b", markedAtMs: 1 });
    const afterDamage = await readdir(root);
    const archived = afterDamage.filter((name) => name.includes(".corrupt-"));
    assert.equal(archived.length, 1, "exactly one archive of the unreadable file must be kept");
    assert.equal(
      await readFile(path.join(root, archived[0]), "utf8"),
      corruptResume,
      "the archive holds the original bytes",
    );
    assert.ok(afterDamage.some((name) => name.endsWith(".degraded")), "a degraded marker must be written");

    // After quarantine the queue works again and the marker is cleared by the
    // next successful write.
    resume.markPending({ agentId: "agent-c", markedAtMs: 2 });
    assert.deepEqual(resume.listPending().map((entry) => entry.agentId), ["agent-c"]);

    // --- pending-wake -------------------------------------------------------
    const wakeRoot = await mkdtemp(path.join(tmpdir(), "grok-durable-wake-"));
    const wake = new compiled.wake.SandPendingWakeStore(wakeRoot);
    assert.deepEqual(wake.listPending(), []);
    await writeFile(wake.filePath, "not json at all");
    assert.deepEqual(wake.listPending(), []);
    assert.equal(wake.markPending({ agentId: "a", kind: "shell", workId: "w", markedAtMs: 1 }), false, "a damaged queue must refuse the write");
    const wakeFiles = await readdir(wakeRoot);
    const archivedWake = wakeFiles.filter((name) => name.includes(".corrupt-"));
    assert.equal(archivedWake.length, 1, "the unreadable wake queue must be archived, not overwritten");
    assert.equal(await readFile(path.join(wakeRoot, archivedWake[0]), "utf8"), "not json at all");
    await rm(wakeRoot, { recursive: true, force: true });

    // --- ack-obligation -----------------------------------------------------
    const ackRoot = await mkdtemp(path.join(tmpdir(), "grok-durable-ack-"));
    const ack = new compiled.ack.SandAckObligationStore(ackRoot);
    assert.deepEqual(ack.list(), []);
    await writeFile(ack.filePath, "{}");
    assert.deepEqual(ack.list(), [], "a malformed object is damage, not an empty queue");
    ack.upsert({ agentId: "a", createdAtMs: 1, lastSendAtMs: 1, coalescedCount: 1, redriveAttempts: 0 });
    const ackFiles = await readdir(ackRoot);
    const archivedAck = ackFiles.filter((name) => name.includes(".corrupt-"));
    assert.equal(archivedAck.length, 1, "the malformed ack file must be archived, not overwritten");
    assert.equal(await readFile(path.join(ackRoot, archivedAck[0]), "utf8"), "{}");
    await rm(ackRoot, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(buildRoot, { recursive: true, force: true });
  }
});
