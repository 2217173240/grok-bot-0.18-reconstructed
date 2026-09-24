import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, appendFile, access, chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
const bundle = join(root, ".cache", "action-audit-outbox.mjs");
await build({
  stdin: {
    contents: 'export { createSandActionAuditor } from "./source/host/extensions/action-audit/action-audit-service.ts"; export { createRealPollingPolicy } from "./source/internal/scheduling.ts";',
    resolveDir: root
  },
  outfile: bundle, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent"
});
const { createSandActionAuditor, createRealPollingPolicy } = await import(bundle);
const record = (i = 1) => ({
  occurredAtMs: i, agentId: "agent",
  action: { kind: "shellCommand", command: `echo ${i}`, shellKind: "sh", target: "local" }
});
const event = (i = 1) => ({ ...record(i), eventId: `stored-${i}`, turnId: "", boxId: "" });

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(root, ".cache", "audit-outbox-"));
  const path = join(dir, "outbox.json");
  const local = join(dir, "audit.jsonl");
  const received = join(dir, "received.jsonl");
  const reports = [];
  const service = createSandActionAuditor({
    outboxPath: path, auditPath: () => local,
    flushPolicy: createRealPollingPolicy({ name: "audit-test", intervalMs: 60_000 }),
    isBackendForwardingEnabled: () => true,
    sendBatch: async (events) => appendFile(received, `${JSON.stringify(events)}\n`),
    report: (diagnostic) => reports.push(diagnostic), ...overrides
  });
  t.after(async () => {
    await service.dispose().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, path, local, received, reports, service };
}

for (const invalid of ["broken", "{}", "[{}]", JSON.stringify([{ ...event(), action: { kind: "unknown" } }]), JSON.stringify([{ ...event(), occurredAtMs: "yesterday" }])]) {
  test(`invalid outbox remains intact: ${invalid}`, async (t) => {
    const { path, reports, service, received, local } = await fixture(t);
    await writeFile(path, invalid);
    service.auditor.record(record(2));
    await assert.rejects(service.flush());
    await assert.rejects(service.dispose());
    assert.equal(await readFile(path, "utf8"), invalid);
    assert.equal(reports.filter((x) => x.event === "outbox_load_failed").length, 1);
    await assert.rejects(access(received), { code: "ENOENT" });
    assert.equal(JSON.parse((await readFile(local, "utf8")).trim()).command, "echo 2");
  });
}

test("load preserves records queued before and during asynchronous reading", async (t) => {
  const { path, received, service } = await fixture(t);
  await writeFile(path, JSON.stringify([event()]));
  service.auditor.record(record(2));
  const flushing = service.flush();
  service.auditor.record(record(3));
  assert.equal(service.flush(), flushing);
  await flushing;
  await service.dispose();
  const accepted = (await readFile(received, "utf8")).trim().split("\n").flatMap(JSON.parse);
  assert.deepEqual(accepted.map((x) => x.action.command), ["echo 1", "echo 2", "echo 3"]);
  await assert.rejects(access(path), { code: "ENOENT" });
});

test("disabled forwarding preserves old pending records and writes new local records", async (t) => {
  const { path, received, local, service } = await fixture(t, { isBackendForwardingEnabled: async () => false });
  await writeFile(path, JSON.stringify([event()]));
  service.auditor.record(record(2));
  await service.flush();
  service.auditor.record(record(3));
  await service.dispose();
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), [event()]);
  await assert.rejects(access(received), { code: "ENOENT" });
  assert.deepEqual((await readFile(local, "utf8")).trim().split("\n").map(JSON.parse).map((x) => x.command), ["echo 2", "echo 3"]);
});

test("failed delivery retains more than 2000 records and reports capacity once", async (t) => {
  const { path, received, reports, service } = await fixture(t);
  await mkdir(received);
  for (let i = 0; i < 2051; i++) service.auditor.record(record(i));
  await service.flush();
  await service.dispose();
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.length, 2051);
  assert.equal(new Set(saved.map((x) => x.eventId)).size, 2051);
  assert.equal(reports.filter((x) => x.event === "outbox_capacity_exceeded").length, 1);
  assert.equal(reports.filter((x) => x.event === "outbox_flush_failed").length, 1);
  await rm(received, { recursive: true });
  const retry = createSandActionAuditor({
    outboxPath: path,
    flushPolicy: createRealPollingPolicy({ name: "audit-retry-test", intervalMs: 60_000 }),
    isBackendForwardingEnabled: () => true,
    sendBatch: async (events) => appendFile(received, `${JSON.stringify(events)}\n`)
  });
  await retry.dispose();
  const batches = (await readFile(received, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(batches.every((batch) => batch.length <= 50));
  assert.deepEqual(batches.flat(), saved);
  await assert.rejects(access(path), { code: "ENOENT" });
});

test("persist failure rejects flush while retaining pending for recovery", async (t) => {
  const { dir, path, service, reports, received } = await fixture(t);
  await service.flush();
  await mkdir(path);
  service.auditor.record(record());
  await assert.rejects(service.flush());
  assert.equal(reports.filter((x) => x.event === "outbox_persist_failed").length, 1);
  assert.equal((await readdir(dir)).filter((name) => name.endsWith(".tmp")).length, 0);
  await assert.rejects(access(received), { code: "ENOENT" });
  await rm(path, { recursive: true });
  await service.flush();
  await service.dispose();
  assert.equal(JSON.parse((await readFile(received, "utf8")).trim())[0].action.command, "echo 1");
});

test("dispose joins an active flush and drains accepted local writes once", async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { path, local, received, service } = await fixture(t, {
    sendBatch: async (events) => {
      entered.resolve();
      await release.promise;
      await appendFile(received, `${JSON.stringify(events)}\n`);
    }
  });
  service.auditor.record(record(1));
  const flushing = service.flush();
  await entered.promise;
  assert.equal(JSON.parse(await readFile(path, "utf8")).length, 1);
  service.auditor.record(record(2));
  const disposing = service.dispose();
  assert.equal(service.dispose(), disposing);
  assert.equal(service.flush(), disposing);
  service.auditor.record(record(3));
  release.resolve();
  await Promise.all([flushing, disposing]);
  assert.deepEqual((await readFile(received, "utf8")).trim().split("\n").flatMap(JSON.parse).map((x) => x.action.command), ["echo 1", "echo 2"]);
  assert.deepEqual((await readFile(local, "utf8")).trim().split("\n").map(JSON.parse).map((x) => x.command), ["echo 1", "echo 2"]);
  await assert.rejects(access(path), { code: "ENOENT" });
});

test("unwritable outbox rejects disposal and preserves the previous file", async (t) => {
  const { dir, path, received, reports, service } = await fixture(t);
  await writeFile(path, JSON.stringify([event()]));
  await chmod(dir, 0o500);
  try {
    await assert.rejects(service.dispose(), { code: "EACCES" });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), [event()]);
    assert.equal(reports.filter((x) => x.event === "outbox_persist_failed").length, 1);
    await assert.rejects(access(received), { code: "ENOENT" });
    assert.equal((await readdir(dir)).filter((name) => name.endsWith(".tmp")).length, 0);
  } finally {
    await chmod(dir, 0o700);
  }
});
