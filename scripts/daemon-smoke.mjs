#!/usr/bin/env node
// Drive the in-box daemon smoke against a running container.
//
//   node scripts/daemon-smoke.mjs <container> <command...>
//
// Bundles source/box-exec-daemon/smoke.ts into a self-contained CJS file
// (esbuild, no runtime deps inside the box), copies it in, and runs it with
// the image's node against the daemon's loopback 1337. Stdout passes through
// untouched for exact-match assertions; the exit code is the smoke's.
import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const container = process.argv[2];
const command = process.argv.slice(3).join(" ");
if (container == null || container.length === 0 || command.trim().length === 0) {
  console.error("usage: node scripts/daemon-smoke.mjs <container> <command...>");
  process.exit(2);
}

const output = path.join(repoRoot, ".cache", "daemon-smoke.cjs");
await mkdir(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(repoRoot, "source", "box-exec-daemon", "smoke.ts")],
  outfile: output,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});

const copied = spawnSync("docker", ["cp", output, `${container}:/tmp/daemon-smoke.cjs`], { stdio: "inherit" });
if (copied.status !== 0) process.exit(copied.status ?? 1);
const run = spawnSync("docker", ["exec", container, "/usr/local/bin/node", "/tmp/daemon-smoke.cjs", command], { stdio: "inherit" });
process.exit(run.status ?? 1);
