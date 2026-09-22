// Regression guard for the local computer's reported state.
//
// The local (loopback) computer executes through the in-box exec daemon, which
// can die or be orphaned — the daemon watchdog and the heal-orphan path exist
// because that is a normal failure. `runState` nevertheless returned a constant
// "running", so the operator and the UI were told the computer was up while
// nothing could execute, and the failure only surfaced later as a failed tool
// call. The state now comes from a bounded probe of the daemon.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function loadModule() {
  const buildRoot = await mkdtemp(path.join(tmpdir(), "grok-local-box-state-"));
  const outfile = path.join(buildRoot, "loopback-sand-box.mjs");
  await build({
    entryPoints: [path.join(repositoryRoot, "source/host/box/loopback-sand-box.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  const module = await import(pathToFileURL(outfile).href);
  return { module, buildRoot };
}

function createBox(module, ping) {
  return new module.LoopbackSandBox({
    host: "127.0.0.1",
    authToken: "test-token",
    watchdogIntervalMs: 0,
    statusProbeTimeoutMs: 50,
    operations: {
      ping,
      createRemoteAccessor: () => ({ get: () => ({ execute: async () => ({ result: { case: "ok" } }) }) }),
      protectRemoteAccessor: (accessor) => accessor,
    },
  });
}

test("the local computer reports the exec daemon's real state", async () => {
  const { module, buildRoot } = await loadModule();
  try {
    // A reachable daemon is running.
    const running = createBox(module, async () => ({ outcome: "ok" }));
    assert.equal(await running.runState(), "running");
    assert.deepEqual(await running.listBoxes(), [{ agentId: "", running: true }]);

    // A daemon that refuses or is gone must not be reported as running.
    for (const outcome of ["refused", "disconnected", "dns"]) {
      const down = createBox(module, async () => ({ outcome }));
      assert.equal(await down.runState(), "stopped", `outcome ${outcome} must report stopped`);
      assert.deepEqual(await down.listBoxes(), [{ agentId: "", running: false }], `outcome ${outcome} must report not running`);
    }

    // An unresolved probe (its own timeout) before the daemon has ever been
    // ready reads as starting rather than down, so a slow boot is not a lie
    // in the other direction.
    const slowBoot = createBox(module, async () => ({ outcome: "timeout" }));
    assert.equal(await slowBoot.runState(), "starting");

    // A probe that throws is treated like an unreachable daemon.
    const throwing = createBox(module, async () => { throw new Error("transport exploded"); });
    assert.equal(await throwing.runState(), "stopped");

    // The probe must be bounded: a daemon that accepts the connection and never
    // answers cannot hang a status request.
    const hanging = createBox(module, () => new Promise(() => {}));
    const started = Date.now();
    const hangingState = await hanging.runState();
    assert.equal(hangingState, "starting");
    assert.ok(
      Date.now() - started < hanging.statusProbeTimeoutMs + 2_000,
      "the status probe must resolve within its bound",
    );
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
});
