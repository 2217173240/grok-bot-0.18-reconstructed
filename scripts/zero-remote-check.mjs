#!/usr/bin/env node
// Bundle and run the zero-remote ledger check against a live ledger.
//
//   node scripts/zero-remote-check.mjs <ledger.jsonl> [first-line-1-based]
//
// One implementation (source/shared/node/zero-remote.ts) serves the hermetic
// CI tests and this live command; the classifier is the same one the tests
// exercise. See scripts/zero-remote-live.sh for the full scenario wrapper.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(repoRoot, ".cache", "zero-remote-check.cjs");
await mkdir(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(repoRoot, "source", "shared", "node", "zero-remote-cli.ts")],
  outfile: output,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  logLevel: "silent",
});
const run = spawnSync(process.execPath, [output, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(run.status ?? 1);
