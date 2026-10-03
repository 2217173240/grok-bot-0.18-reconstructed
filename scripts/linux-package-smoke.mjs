import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { readDepsPin } from "./lib/deps-pin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const image = "grok-bot-exec-box:amd64";
const ownerKey = "com.grok-bot.package-smoke";
const mount = (source, destination) => ["type=bind", `src=${source}`, `dst=${destination}`, "readonly"].map(value => /[,"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(",");

async function docker(args) {
  return (await execute("docker", args, { cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
}

export async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Linux package smoke requires Linux x64");
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/linux-package-smoke-"));
  const temporary = path.join(directory, "temporary");
  await mkdir(temporary);
  Object.assign(process.env, { TMPDIR: temporary, TMP: temporary, TEMP: temporary });
  console.log(`Linux package smoke artifacts: ${directory}`);
  const [imageInfo] = JSON.parse(await docker(["image", "inspect", image]));
  assert.equal(`${imageInfo.Os}/${imageInfo.Architecture}`, "linux/amd64");
  const depsPin = await readDepsPin(root, "linux/amd64");
  assert.equal(imageInfo.Config.Labels?.["com.grok-bot.local-vm.deps-pin"], depsPin);
  const outputRoot = path.join(directory, "runtime");
  const { buildCleanDistribution } = await import("./lib/clean-build.mjs");
  const { buildProductionHostIfSupplied } = await import("./host-production-activation.mjs");
  await buildCleanDistribution({ outputRoot });
  const activation = await buildProductionHostIfSupplied({ outputRoot, manifestPath: null, sourceOnly: true });
  assert.equal(activation.clean, true, activation.blocker);
  const checks = path.join(directory, "checks");
  const workspace = path.join(directory, "workspace");
  await mkdir(checks);
  await mkdir(workspace);
  await chmod(workspace, 0o777);
  await build({ entryPoints: [path.join(root, "scripts/fixtures/linux-package-rpc-smoke.mjs")], outfile: path.join(checks, "rpc.cjs"), bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "silent" });
  const session = randomUUID();
  const name = `grok-package-smoke-${session}`;
  const prepareName = `${name}-prepare`;
  const volume = `${name}-data`;
  const token = randomBytes(32).toString("hex");
  const marker = randomUUID();
  const label = `${ownerKey}=${session}`;
  const evidence = { image: imageInfo.Id, platform: "linux/amd64", depsPin, host: "clean-source", rounds: [] };
  let volumeCreated = false;

  async function removeContainer(target) {
    const ids = await docker(["ps", "-aq", "--filter", `name=^/${target}$`]);
    if (!ids) return;
    const [info] = JSON.parse(await docker(["inspect", target]));
    assert.equal(info.Config.Labels?.[ownerKey], session, "Container ownership changed");
    await docker(["rm", "--force", target]);
  }

  async function start() {
    const environment = {
      SAND_LOCAL_ADMIN: "1", SAND_HOST_IN_BOX: "1", SAND_LOCAL_ADMIN_TURN: "host", SAND_LOCAL_ADMIN_DESKTOP: "0",
      SAND_DISABLE_TELEMETRY: "1", SAND_DISABLE_SENTRY: "1", SAND_DISABLE_UPDATES: "1",
      SAND_GATEWAY_BIND_HOST: "0.0.0.0", SAND_HOST_PORT: "1340", SAND_GATEWAY_TOKEN: token, SAND_GATEWAY_REQUIRE_AUTH: "1",
      SAND_DATA_ROOT: "/home/box/sand-data", SAND_WORKSPACE_ROOT: "/workspace", SAND_AGENT_WORKSPACE: "/workspace",
      SAND_FEATURE_GATE_OVERRIDES: "sand_new_transcript_journal=0,sand_action_audit_logs=0,sand_auto_review=0,sand_agent_network=0",
      TMPDIR: "/home/box/sand-data/.cache", TMP: "/home/box/sand-data/.cache", TEMP: "/home/box/sand-data/.cache",
    };
    await docker(["run", "--detach", "--init", "--name", name, "--label", label, "--platform", "linux/amd64", "--memory", "2g", "--publish", "127.0.0.1::1340", "--mount", mount(path.join(outputRoot, "dist/host"), "/home/box/sand-host"), "--mount", mount(path.join(outputRoot, "dist/box-exec-daemon"), "/home/box/box-exec-daemon"), "--mount", mount(checks, "/home/box/.cache/package-smoke"), "--mount", mount(workspace, "/workspace").replace(/,readonly$/, ""), "--volume", `${volume}:/home/box/sand-data`, ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]), "--entrypoint", "/usr/local/bin/node", image, "/home/box/sand-host/host-main.cjs"]);
    const [info] = JSON.parse(await docker(["inspect", name]));
    assert.equal(info.Config.Labels[ownerKey], session);
    assert.equal(info.HostConfig.Init, true);
    const endpoint = `http://127.0.0.1:${info.NetworkSettings.Ports["1340/tcp"][0].HostPort}`;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const status = await docker(["inspect", "--format", "{{.State.Running}}", name]);
      assert.equal(status, "true", "Production host exited before gateway became ready");
      let health;
      try { health = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1500) }); }
      catch (error) { if (error.name !== "TimeoutError" && error.cause?.code !== "ECONNREFUSED" && error.cause?.code !== "UND_ERR_SOCKET") throw error; }
      if (health?.ok) {
        assert.equal((await health.json()).ok, true);
        return endpoint;
      }
      await delay(250);
    }
    throw new Error("Production host gateway health timed out");
  }

  try {
    await docker(["volume", "create", "--label", label, volume]);
    volumeCreated = true;
    const seed = "const fs=require('node:fs');fs.mkdirSync('/data/.cache',{recursive:true});fs.writeFileSync('/data/settings.json',JSON.stringify({version:1,inferenceProvider:'codex',boxRuntime:'local-docker'}));";
    await docker(["run", "--rm", "--name", prepareName, "--label", label, "--network", "none", "--platform", "linux/amd64", "--user", "root", "--volume", `${volume}:/data`, "--entrypoint", "/bin/sh", image, "-c", 'node -e "$1" && chown -R box:box /data', "seed", seed]);
    for (const mode of ["write", "verify"]) {
      const endpoint = await start();
      const request = headers => fetch(`${endpoint}/api/listAgents`, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(10000) });
      assert.equal((await request({})).status, 401);
      assert.equal((await request({ authorization: "Bearer invalid" })).status, 401);
      const authorized = await request({ authorization: `Bearer ${token}` });
      assert.equal(authorized.status, 200, await authorized.text());
      const rpc = JSON.parse(await docker(["exec", name, "/usr/local/bin/node", "/home/box/.cache/package-smoke/rpc.cjs", mode, marker]));
      assert.equal(await readFile(path.join(workspace, "package-smoke.txt"), "utf8"), marker);
      evidence.rounds.push({ ...rpc, gatewayHealth: true, gatewayAuthentication: true });
      const logs = await execute("docker", ["logs", name], { encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
      await writeFile(path.join(directory, `${mode}.log`), logs.stdout + logs.stderr);
      await docker(["stop", "--time", "15", name]);
      await removeContainer(name);
    }
    await writeFile(path.join(directory, "report.json"), JSON.stringify({ ...evidence, recreatedWithDataPreserved: true, modelRequests: "not submitted" }, null, 2));
    console.log(JSON.stringify({ artifacts: directory, rounds: evidence.rounds.length, recreatedWithDataPreserved: true }));
  } finally {
    const cleanupErrors = [];
    const attempt = async action => { try { await action(); } catch (error) { cleanupErrors.push(error); } };
    await attempt(async () => {
      const remaining = await docker(["ps", "-aq", "--filter", `name=^/${name}$`]);
      if (!remaining) return;
      const logs = await execute("docker", ["logs", name], { encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
      await writeFile(path.join(directory, "failure.log"), logs.stdout + logs.stderr);
    });
    await attempt(() => removeContainer(name));
    await attempt(() => removeContainer(prepareName));
    if (volumeCreated) {
      await attempt(async () => {
        const [info] = JSON.parse(await docker(["volume", "inspect", volume]));
        assert.equal(info.Labels?.[ownerKey], session, "Volume ownership changed");
        await docker(["volume", "rm", volume]);
      });
    }
    if (cleanupErrors.length === 0) for (const disposable of [workspace, checks, outputRoot, temporary]) await attempt(() => rm(disposable, { recursive: true, force: true }));
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Package smoke cleanup failed");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
