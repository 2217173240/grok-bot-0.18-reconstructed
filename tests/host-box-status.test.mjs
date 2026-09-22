// Regression guard for the reported computer status.
//
// Two layers used to misreport a live computer. The loopback box returned a
// constant "running" (covered by local-box-state-probe.test.mjs), and this layer
// overwrote whatever the box reported with "absent" whenever no takeover URL had
// been cached yet — so a running computer with no cached URL read as missing.
// The operator status field is what this protects.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function loadHostBox() {
  const buildRoot = await mkdtemp(path.join(tmpdir(), "grok-host-box-status-"));
  const outfile = path.join(buildRoot, "host-box.mjs");
  await build({
    entryPoints: [path.join(repositoryRoot, "source/host/extensions/forever-box/host-box.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  const module = await import(pathToFileURL(outfile).href);
  return { HostBox: module.HostBox, buildRoot };
}

function createBox(HostBox, state) {
  return new HostBox({
    runState: async () => state,
    ensureReady: async () => ({ vncUrl: "http://127.0.0.1:6080/vnc.html" }),
    listBoxes: async () => [{ agentId: "", running: state === "running" }],
    uploadFile: async () => {},
    downloadFile: async () => new Uint8Array(),
  });
}

test("the reported computer status reflects the box's own state", async () => {
  const { HostBox, buildRoot } = await loadHostBox();
  try {
    // Running with no cached takeover URL must still read as running.
    const running = createBox(HostBox, "running");
    const runningStatus = await running.getStatus({}, "");
    assert.equal(runningStatus.state, "running", "a running computer must not read as absent");
    assert.equal(runningStatus.vncUrl, null, "no url is cached yet");

    // A cached URL produces the full running status with the url.
    running.recordConnection("agent-1", { vncUrl: "http://127.0.0.1:6080/vnc.html?token=t" });
    const withUrl = await running.getStatus({}, "agent-1");
    assert.equal(withUrl.state, "running");
    assert.ok(withUrl.vncUrl.includes("token=t"));

    // A stopped daemon reports stopped and drops any cached url, so a stale
    // takeover link is not presented for a dead computer.
    const stopped = createBox(HostBox, "stopped");
    stopped.recordConnection("agent-2", { vncUrl: "http://127.0.0.1:6080/vnc.html?token=stale" });
    const stoppedStatus = await stopped.getStatus({}, "agent-2");
    assert.equal(stoppedStatus.state, "stopped");
    assert.equal(stoppedStatus.vncUrl, null, "a dead computer must not keep advertising a takeover url");

    // isBoxRunning inherits the same verdict.
    assert.equal(await running.isBoxRunning({}), true);
    assert.equal(await stopped.isBoxRunning({}), false);
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
});
