// Regression guard for the desktop health forwarding contract.
//
// The forwarder's outcome is what the telemetry service branches on: "absent"
// means the supervisor-written file does not exist, which is the permanent state
// of this topology because the host IS the container process and no supervisor
// runs. The service used to discard the outcome inside a bare `catch {}`, so a
// beat that can never fire looked the same as one that had simply stopped. This
// pins the contract the service now reports on.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function loadModule() {
  const buildRoot = await mkdtemp(path.join(tmpdir(), "grok-desktop-health-"));
  const outfile = path.join(buildRoot, "desktop-health-forwarder.mjs");
  await build({
    entryPoints: [path.join(repositoryRoot, "source/host/extensions/telemetry/desktop-health-forwarder.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  return { module: await import(pathToFileURL(outfile).href), buildRoot };
}

function snapshot(overrides = {}) {
  return JSON.stringify({
    updatedAtMs: 1_000,
    revision: 1,
    supervisionEnabled: true,
    total: 1,
    up: 1,
    down: 0,
    crashlooping: 0,
    restartsInWindow: 0,
    components: [{ name: "d1/xvfb", up: true, crashloop: false, restartsInWindow: 0 }],
    ...overrides,
  });
}

async function forward(module, raw) {
  const emitted = [];
  const outcome = await module.forwardDesktopHealthWith({
    heartbeatMs: 300_000,
    readRaw: async () => raw,
    emit: (level, metadata) => emitted.push({ level, metadata }),
    now: () => 1_000,
    getLast: () => ({ revision: null, atMs: null }),
    setLast: () => {},
  });
  return { outcome, emitted };
}

test("a missing health file is reported as absent, not as a silent skip", async () => {
  const { module, buildRoot } = await loadModule();
  try {
    const { outcome, emitted } = await forward(module, null);
    assert.equal(outcome, "absent", "the service reports the absence; the file has no producer in this topology");
    assert.equal(emitted.length, 0);

    // A file that exists but does not parse is a different fact from a missing
    // one, and the service reports both under their own name.
    const malformed = await forward(module, "{ not json");
    assert.equal(malformed.outcome, "parse_error");

    const healthy = await forward(module, snapshot());
    assert.equal(healthy.outcome, "emitted");
    assert.equal(healthy.emitted.length, 1);
    assert.equal(healthy.emitted[0].level, "info", "a healthy plane is not a warning");
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
});
