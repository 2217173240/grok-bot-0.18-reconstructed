import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".cache"), { recursive: true });
const dir = await mkdtemp(join(root, ".cache", "structured-checkpoint-"));
const bundle = join(dir, "transport.mjs");
await build({ stdin: { contents: `
export * from "./source/shared/observability/structured-log-transport.ts";
export { HOST_LOG_EVENT, TELEMETRY_DROPPED_EVENT } from "./source/shared/observability/telemetry-events.ts";
export { createRealPollingPolicy, createDeadlinePolicy, realClock } from "./source/internal/scheduling.ts";
`, resolveDir: root }, outfile: bundle, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
const { StructuredLogTransport, emptyDropCounters, HOST_LOG_EVENT, TELEMETRY_DROPPED_EVENT, createRealPollingPolicy, createDeadlinePolicy, realClock } = await import(bundle);
test.after(() => rm(dir, { recursive: true, force: true }));

test("checkpoint 1001条保留1000条，优先移除普通日志并通过HTTP确认overflow计数", async () => {
  const received = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    received.push(...body.logs);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ logsProcessed: body.logs.length, logsDropped: 0 }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const checkpointFile = join(dir, "checkpoint.json");
  const counters = emptyDropCounters();
  counters.overflow_evicted = { observed: 4, acknowledgedThrough: 4 };
  const records = Array.from({ length: 1001 }, (_, i) => ({ level: "info", message: i === 500 ? HOST_LOG_EVENT : `event-${i}`, timestamp: Date.now(), metadata: { index: String(i) } }));
  await writeFile(checkpointFile, JSON.stringify({ counterId: "persistent-counter", counters, records }));
  const loaded = JSON.parse(await readFile(checkpointFile, "utf8"));
  const settlements = [];
  loaded.records = loaded.records.map(record => ({ ...record, onSettled: result => settlements.push({ index: record.metadata.index, result }) }));
  const transport = new StructuredLogTransport({
    key: "local-checkpoint", platformTags: {}, initialCheckpoint: loaded,
    polling: createRealPollingPolicy({ name: "checkpoint-test", intervalMs: 60_000 }),
    submitDeadline: createDeadlinePolicy(realClock, { name: "checkpoint-http", timeoutMs: 5_000 }),
    createClient: () => ({ async submitLogs(request, { signal }) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(request, (_, value) => typeof value === "bigint" ? String(value) : value) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    } }),
  });
  try {
    const checkpoint = transport.captureCheckpoint();
    assert.equal(checkpoint.records.length, 1000);
    assert.equal(checkpoint.records[0].message, "event-0");
    assert.equal(checkpoint.records.some(record => record.message === HOST_LOG_EVENT), false);
    assert.deepEqual(settlements, [{ index: "500", result: "dropped" }]);
    assert.deepEqual(checkpoint.counters.overflow_evicted, { observed: 5, acknowledgedThrough: 4 });
    assert.equal(checkpoint.counterId, "persistent-counter");
    assert.equal(await transport.flushNow(), true);
    assert.equal(transport.capturePending().length, 0);
    assert.equal(settlements.filter(entry => entry.result === "delivered").length, 1000);
    assert.equal(new Set(settlements.map(entry => entry.index)).size, 1001);
    assert.deepEqual(transport.captureCheckpoint().counters.overflow_evicted, { observed: 5, acknowledgedThrough: 5 });
    const reports = received.filter(log => log.message === TELEMETRY_DROPPED_EVENT);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].metadata.reason, "overflow_evicted");
    assert.equal(reports[0].metadata.count, "5");
    assert.equal(reports[0].metadata.counter_id, "persistent-counter");
  } finally { await transport.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
