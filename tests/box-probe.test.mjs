// Regression guard for the container gates' probe discipline.
//
// `docker exec` reports a stopped container, a refused exec and a missing binary
// identically: non-zero exit, empty stdout — the same shape as a command that ran
// and printed nothing. Gate G4 read that shape as "no Chromium processes", so it
// passed exactly when docker exec was failing. These tests drive the probe
// library's three outcomes to keep "measured" and "did not measure" apart.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const probeLibrary = path.join(repositoryRoot, "scripts", "lib", "box-probe.sh");

// Only the transport is replaced. The substitute runner executes the in-box
// script locally, so the sentinel protocol and the count classification run for
// real; what changes is where the bytes come from.
const TRANSPORT_OVERRIDE = `
probe_runner() {
  if [ "\${PROBE_TRANSPORT:-ok}" != "ok" ]; then
    printf '%s\\n' "Error response from daemon: No such container: $BOX_CONTAINER"
    return 1
  fi
  PATH="$FAKE_BIN:$PATH" sh -c "$1"
}
`;

// A stand-in for pgrep so the count branches are deterministic. The real tool
// cannot be asked for "3 matches" or for a specific error message.
const FAKE_PGREP = `#!/bin/sh
printf '%s\\n' "\${FAKE_PGREP_OUTPUT-0}"
`;

async function probeEnvironment() {
  const fakeBin = await mkdtemp(path.join(tmpdir(), "grok-box-probe-bin-"));
  const pgrep = path.join(fakeBin, "pgrep");
  await writeFile(pgrep, FAKE_PGREP);
  await chmod(pgrep, 0o755);
  return fakeBin;
}

async function runProbe(fakeBin, probeCall, env = {}) {
  const script = [
    "set -uo pipefail",
    "BOX_CONTAINER=grok-bot-probe-fixture",
    `. "${probeLibrary}"`,
    TRANSPORT_OVERRIDE,
    probeCall,
    `printf '%s|%s\\n' "$PROBE_STATUS" "$PROBE_OUTPUT"`,
  ].join("\n");
  const { stdout } = await run("bash", ["-c", script], {
    env: { ...process.env, FAKE_BIN: fakeBin, ...env },
  });
  const separator = stdout.indexOf("|");
  return {
    status: Number(stdout.slice(0, separator)),
    output: stdout.slice(separator + 1).replace(/\n+$/, ""),
  };
}

test("a probe that never reached the box is unknown, never a zero measurement", async () => {
  const fakeBin = await probeEnvironment();
  try {
    const count = await runProbe(fakeBin, "probe_box_process_count chromium", { PROBE_TRANSPORT: "broken" });
    assert.equal(count.status, 1, "a failed docker exec must not be PROBE_OK");
    assert.notEqual(count.output, "0", "a failed probe must never read as a clean zero count");
    assert.match(count.output, /No such container/, "the docker diagnostic must survive into the report");

    const pid = await runProbe(fakeBin, "probe_box_pid sand-window-router.mjs", { PROBE_TRANSPORT: "broken" });
    assert.equal(pid.status, 1, "a failed docker exec must not be PROBE_OK");
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("a probe that ran reports its measurement, including zero and absence", async () => {
  const fakeBin = await probeEnvironment();
  try {
    // pgrep -c prints 0 and exits 1 when nothing matches; the count is the
    // measurement, so this is a successful probe carrying zero.
    const none = await runProbe(fakeBin, "probe_box_process_count chromium", { FAKE_PGREP_OUTPUT: "0" });
    assert.equal(none.status, 0);
    assert.equal(none.output, "0");

    const three = await runProbe(fakeBin, "probe_box_process_count chromium", { FAKE_PGREP_OUTPUT: "3" });
    assert.equal(three.status, 0);
    assert.equal(three.output, "3");

    const pid = await runProbe(fakeBin, "probe_box_pid session-sync.mjs", { FAKE_PGREP_OUTPUT: "4242" });
    assert.equal(pid.status, 0);
    assert.equal(pid.output, "4242");

    // No matching process is a measurement, not a broken probe: the caller must
    // be able to tell "the daemon is gone" from "the box did not answer".
    const absent = await runProbe(fakeBin, "probe_box_pid session-sync.mjs", { FAKE_PGREP_OUTPUT: "" });
    assert.equal(absent.status, 0, "an absent process is still a successful probe");
    assert.equal(absent.output, "");
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("a count that is not a single number is unknown", async () => {
  const fakeBin = await probeEnvironment();
  try {
    const missing = await runProbe(fakeBin, "probe_box_process_count chromium", { FAKE_PGREP_OUTPUT: "sh: pgrep: not found" });
    assert.equal(missing.status, 1, "an unreadable count must not pass as zero");
    assert.notEqual(missing.output, "0");
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
});
