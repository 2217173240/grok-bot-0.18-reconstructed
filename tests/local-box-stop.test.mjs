// Regression guard for the local Docker box stop.
//
// `docker stop` returning success is not proof that the container is down. The
// connector stops the box before it starts the Mac host, which binds the same
// gateway port and reads the same token file, so a stop that did not take
// effect makes the Mac-host branch answer from the container that is still
// running. The retired implementation returned as soon as docker stop exited
// zero, and the caller swallowed a failure with `.catch(() => undefined)`.
// These cases pin the verdict to observed state.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function loadConnector() {
  await mkdir(path.join(repositoryRoot, ".cache"), { recursive: true });
  const buildRoot = await mkdtemp(path.join(repositoryRoot, ".cache", "grok-box-stop-"));
  const outfile = path.join(buildRoot, "connector.mjs");
  await build({
    entryPoints: [path.join(repositoryRoot, "source/electron-main/box/local-docker-host-connector.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    outfile,
    logLevel: "silent",
  });
  return { module: await import(pathToFileURL(outfile).href), buildRoot };
}

const NAME = "grok-bot-local-vm";
const OWNED_RUNNING = { exists: true, running: true, owned: true };

test("the local box stop verdict follows observed state", async () => {
  const { module, buildRoot } = await loadConnector();
  const { judgeLocalBoxStop } = module;
  try {
    // Nothing to stop: an absent container and an already stopped container both
    // leave the gateway port free, which is the only property the caller needs.
    assert.deepEqual(judgeLocalBoxStop(NAME, { before: { exists: false, running: false, owned: false } }), { stopped: true });
    assert.deepEqual(judgeLocalBoxStop(NAME, { before: { exists: true, running: false, owned: true } }), { stopped: true });

    // A container this repository does not own is never stopped, and the reason
    // keeps the phrase the configuration-error classifier matches on.
    const unowned = judgeLocalBoxStop(NAME, { before: { exists: true, running: true, owned: false } });
    assert.equal(unowned.stopped, false);
    assert.match(unowned.reason, /unowned container/);

    // The observed state decides, whichever way docker stop reported.
    assert.deepEqual(
      judgeLocalBoxStop(NAME, { before: OWNED_RUNNING, stop: { succeeded: true }, after: { exists: true, running: false, owned: true } }),
      { stopped: true },
    );
    assert.deepEqual(
      judgeLocalBoxStop(NAME, { before: OWNED_RUNNING, stop: { succeeded: false }, after: { exists: true, running: false, owned: true } }),
      { stopped: true },
    );
    const stillRunning = judgeLocalBoxStop(NAME, { before: OWNED_RUNNING, stop: { succeeded: true }, after: { exists: true, running: true, owned: true } });
    assert.equal(stillRunning.stopped, false, "a successful docker stop that left the container running is not a stop");
    assert.match(stillRunning.reason, /still running/);

    // Without a post-stop observation only a successful stop counts, and only
    // because the container was there to stop in the first place.
    assert.deepEqual(judgeLocalBoxStop(NAME, { before: OWNED_RUNNING, stop: { succeeded: true } }), { stopped: true });
    const unproven = judgeLocalBoxStop(NAME, { before: OWNED_RUNNING, stop: { succeeded: false } });
    assert.equal(unproven.stopped, false, "an unverifiable stop must not be reported as a stop");
    assert.match(unproven.reason, /could not be observed/);
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
});
