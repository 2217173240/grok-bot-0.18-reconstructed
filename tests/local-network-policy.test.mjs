import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entry) {
  await mkdir(path.join(repoRoot, ".cache"), { recursive: true });
  const dir = await mkdtemp(path.join(repoRoot, ".cache", "local-network-policy-"));
  const output = path.join(dir, `${path.basename(entry, ".ts")}.mjs`);
  await build({ entryPoints: [path.join(repoRoot, entry)], outfile: output, bundle: true, format: "esm", platform: "node", target: "node22", packages: "external" });
  return { output, module: await import(`${pathToFileURL(output).href}?${Date.now()}`), dispose: () => rm(dir, { recursive: true, force: true }) };
}

function runIsolated(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("local-admin network policy is idempotent and blocks before DNS", async () => {
  const loaded = await bundle("source/shared/node/local-admin-intercept.ts");
  try {
    const script = `import { installLocalAdminNetworkIntercept } from ${JSON.stringify(pathToFileURL(loaded.output).href)};
installLocalAdminNetworkIntercept({ SAND_LOCAL_ADMIN: "1" });
const first = globalThis.fetch;
installLocalAdminNetworkIntercept({ SAND_LOCAL_ADMIN: "1" });
if (first !== globalThis.fetch) throw new Error("interceptor wrapped fetch twice");
try { await fetch("https://api2.cursor.sh/zero-remote-test"); process.exit(3); } catch (error) { if (!String(error).includes("SAND_LOCAL_ADMIN blocked fetch")) throw error; }
console.log("ok");`;
    const result = await runIsolated(script, { SAND_LOCAL_ADMIN: "1" });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ok/);
  } finally { await loaded.dispose(); }
});

test("local-admin bootstrap returns before token and network work", async () => {
  const loaded = await bundle("source/shared/node/experiments/statsig-bootstrap.ts");
  const scheduling = await bundle("source/internal/scheduling.ts");
  try {
    const script = `import { fetchStatsigBootstrap } from ${JSON.stringify(pathToFileURL(loaded.output).href)};
import { createDeadlinePolicy, realClock } from ${JSON.stringify(pathToFileURL(scheduling.output).href)};
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
const result = await fetchStatsigBootstrap({ backendUrl: "https://api2.cursor.sh", deadline: createDeadlinePolicy(realClock, { name: "bootstrap-test", timeoutMs: 1000 }), getAccessToken: () => readFile(${JSON.stringify(`${loaded.output}.token`)}, "utf8"), getMachineId: async () => hostname() });
if (JSON.stringify(result) !== "{}") throw new Error(JSON.stringify(result));
console.log("ok");`;
    const result = await runIsolated(script, { SAND_LOCAL_ADMIN: "1" });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ok/);
  } finally { await loaded.dispose(); await scheduling.dispose(); }
});

test("local-admin keeps explicit feature-gate overrides available without polling", async () => {
  const loaded = await bundle("source/shared/node/experiments/cursor-experiments.ts");
  try {
    const script = `import { SandExperimentService } from ${JSON.stringify(pathToFileURL(loaded.output).href)};
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
const service = new SandExperimentService({ getAccessToken: () => readFile(${JSON.stringify(`${loaded.output}.token`)}, "utf8"), getMachineId: async () => hostname(), getCacheDir: () => ${JSON.stringify(path.join(path.dirname(loaded.output), "cache"))}, env: { SAND_LOCAL_ADMIN: "1", SAND_FEATURE_GATE_OVERRIDES: "sand_special_settings=true" }, pollIntervalMs: 1 });
service.start();
if (!service.getSnapshot().isInitialized) throw new Error("local defaults not initialized");
if (service.checkFeatureGate("sand_special_settings") !== true) throw new Error("override unavailable");
await service.refreshNow();
await service.dispose();
console.log("ok");`;
    const result = await runIsolated(script, { SAND_LOCAL_ADMIN: "1", SAND_FEATURE_GATE_OVERRIDES: "sand_special_settings=true" });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ok/);
  } finally { await loaded.dispose(); }
});
