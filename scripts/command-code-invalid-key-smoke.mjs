import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv.includes("--inside-container")) {
  assert.equal(process.platform, "linux");
  const { createProviderPromptSession } = await import(pathToFileURL(process.env.COMMAND_CODE_BUNDLE).href);
  const session = createProviderPromptSession("command-code");
  const executor = session.getExecutor([{ role: "user", content: "Reply with one short sentence." }]);
  const result = executor.stream({ signal: AbortSignal.timeout(15_000) }, "command-code-invalid-key", []);
  const consume = (async () => { for await (const _part of result.fullStream) {} })();
  let timeout;
  try {
    const settled = await Promise.race([
      Promise.allSettled([consume, result.response, result.usage, result.extendedUsage, result.providerMetadata]),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Command Code error did not settle the stream and result promises.")), 20_000); }),
    ]);
    for (const outcome of settled) {
      assert.equal(outcome.status, "rejected");
      assert.match(outcome.reason.message, /Command Code rejected the API key \(HTTP 401\)/);
      assert.doesNotMatch(outcome.reason.message, /grokbot-invalid-key-probe/);
    }
    process.stdout.write(JSON.stringify({ ok: true, rejectedResults: settled.length, status: 401 }) + "\n");
  } finally {
    clearTimeout(timeout);
  }
} else {
  if (!process.env.DOCKER_HOST) throw new Error("Set DOCKER_HOST to the isolated Docker runtime socket.");
  const cache = path.join(root, ".cache");
  await mkdir(cache, { recursive: true });
  const workspace = await mkdtemp(path.join(cache, "command-code-invalid-key-"));
  try {
    const { build } = await import("esbuild");
    const outfile = path.join(workspace, "provider-session.mjs");
    await build({ entryPoints: [path.join(root, "source/host/extensions/inference/provider-session.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    const insideBundle = `/repo/${path.relative(root, outfile)}`;
    const { stdout, stderr } = await promisify(execFile)("docker", [
      "run", "--rm", "--network", "bridge", "--read-only",
      "--mount", `type=bind,src=${root},dst=/repo,readonly`,
      "-e", "COMMAND_CODE_API_KEY=grokbot-invalid-key-probe",
      "-e", "SAND_DATA_ROOT=/repo/.cache/command-code-isolated-data",
      "-e", `COMMAND_CODE_BUNDLE=${insideBundle}`,
      "--entrypoint", "node", process.env.GROKBOT_BOX_IMAGE || "grok-bot-exec-box:arm64",
      "/repo/scripts/command-code-invalid-key-smoke.mjs", "--inside-container",
    ], { timeout: 35_000, maxBuffer: 1_000_000 });
    process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
