// Manual, isolated Docker E2E for fork noVNC credentials.
// Run: node scripts/box-windows-auth-e2e.mjs
// Uses the current Docker endpoint: DOCKER_HOST if set, otherwise the active
// context. start-local.sh exports DOCKER_HOST after discovering the socket, and
// scripts/lib/docker-socket.sh names the profile this project owns.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const container = `grok-fork-auth-e2e-${process.pid}`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 });
const inBox = (command) => docker("exec", container, "bash", "-lc", command);

function handshake(token) {
  // A successful WebSocket stays open. curl prints 101 before its time limit.
  const result = spawnSync("docker", ["exec", container, "bash", "-lc", `curl -s -o /dev/null -w '%{http_code}' --max-time 2 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' 'http://127.0.0.1:6081/websockify?token=${token}'`], { encoding: "utf8", timeout: 10_000 });
  return result.stdout.trim();
}

async function loadWindows() {
  const cache = path.join(root, ".cache");
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(path.join(cache, "box-windows-auth-e2e-"));
  const output = path.join(temporary, "box-windows.mjs");
  await build({ entryPoints: [path.join(root, "source/host/box/box-windows.ts")], outfile: output, bundle: true, format: "esm", platform: "node", target: "node22", packages: "external" });
  return { windows: await import(pathToFileURL(output).href), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

let loaded;
try {
  docker("image", "inspect", "grok-bot-exec-box:arm64");
  loaded = await loadWindows();
  docker("run", "--rm", "--detach", "--name", container, "--entrypoint", "/bin/bash", "grok-bot-exec-box:arm64", "-lc", "sleep 300");
  inBox("mkdir -p /tmp/sand-window-tokens.d /tmp/sand-novnc-tokens.d /tmp/sand-desktop");
  docker("exec", "--detach", container, "websockify", "--web=/usr/share/novnc/", "--token-plugin=TokenFile", "--token-source=/tmp/sand-novnc-tokens.d", "6081");

  let pauseBeforeStart = false;
  let failMint = false;
  // This accessor runs every command in the isolated container. The two
  // command substitutions below inject a pause/failure around real image
  // binaries so revocation and cleanup can be observed during execution.
  const accessor = { get() { return { async execute(_ctx, args) {
    let command = pauseBeforeStart ? args.command.replace("/usr/local/bin/start-window 2 owner2 9>&-", "sleep 3; /usr/local/bin/start-window 2 owner2 9>&-") : args.command;
    if (pauseBeforeStart) assert.notEqual(command, args.command, "the reentry pause must wrap the real start-window call");
    if (failMint) {
      const before = command;
      command = command.replace("token=\"$(od -An -N32 -tx1 /dev/urandom | tr -d ' \\n')\"", "token=\"\"");
      assert.notEqual(command, before, "the mint failure must be injected after start-window");
    }
    const result = await new Promise((resolve) => execFile("docker", ["exec", container, "bash", "-lc", command], { encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => resolve({ exitCode: error?.code ?? 0, stdout, stderr })));
    return { result: { case: "success", value: result } };
  } }; } };

  const first = await loaded.windows.runStartWindow({}, accessor, 2, "owner2");
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(inBox("stat -c '%a' /tmp/sand-novnc-tokens.d/2").trim(), "600");
  assert.equal(handshake(first), "101");
  assert.notEqual(handshake("0".repeat(64)), "101");
  console.log("PASS: random credential authenticates; wrong credential fails; token file is 0600");

  pauseBeforeStart = true;
  const secondPending = loaded.windows.runStartWindow({}, accessor, 2, "owner2");
  let revokedBeforeStart = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (inBox("if test ! -e /tmp/sand-novnc-tokens.d/2; then echo revoked; else echo present; fi").trim() === "revoked") { revokedBeforeStart = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(revokedBeforeStart, true, "old credential must be removed before the paused start-window invocation");
  assert.notEqual(handshake(first), "101", "old credential must fail while start-window has not yet run");
  const second = await secondPending;
  pauseBeforeStart = false;
  assert.notEqual(second, first);
  assert.equal(handshake(second), "101");
  assert.notEqual(handshake(first), "101");
  console.log("PASS: reentry revokes the old credential before the display restarts");

  await assert.rejects(loaded.windows.runStartWindow({}, accessor, 2, "other-owner"), /start-window/);
  assert.equal(handshake(second), "101", "a rejected owner must not revoke the live owner's view token");
  await loaded.windows.runStopWindow({}, accessor, 2);
  assert.equal(inBox("test ! -e /tmp/sand-novnc-tokens.d/2 && echo removed").trim(), "removed");
  assert.notEqual(handshake(second), "101");
  console.log("PASS: wrong owner leaves the live token intact; stop revokes it");

  failMint = true;
  await assert.rejects(loaded.windows.runStartWindow({}, accessor, 2, "owner2"), /start-window exited/);
  assert.equal(inBox("test ! -e /tmp/sand-novnc-tokens.d/2 && echo removed").trim(), "removed");
  assert.equal(inBox("DISPLAY=:2 xdpyinfo >/dev/null 2>&1 && echo alive || echo dead").trim(), "dead");
  console.log("PASS: failed mint removes the credential and newly started display");
} finally {
  try { docker("rm", "-f", container); } catch {}
  await loaded?.dispose();
}
