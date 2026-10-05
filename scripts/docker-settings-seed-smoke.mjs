import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLocalDockerClient } from "../source/shared/node/local-docker-client.mjs";

const root = path.resolve(import.meta.dirname, "..");
const session = randomUUID();
const volume = `grok-seed-smoke-${session}`;
const ownerLabel = "com.grok-bot.seed-smoke";
const directory = path.join(root, ".cache", `docker-seed-smoke-${session}`);
const fixture = await readFile(path.join(import.meta.dirname, "fixtures/docker-settings-seed-check.cjs"), "utf8");
const client = createLocalDockerClient();
const names = new Set();
const report = { session, host: undefined, platform: undefined, image: undefined, passed: [], cleanup: false };
let volumeRequested = false;
let profile;
let failure;
await mkdir(directory, { recursive: true });

async function required(args, description) {
  const result = await client.run(args);
  assert.ok(result.ok, `${description}: ${result.output}`);
  return result.output;
}

async function run(args, { user = "root", readonly = false } = {}) {
  const name = `grok-seed-smoke-${session}-${names.size + 1}`;
  names.add(name);
  return client.run([
    "run", "--rm", "--name", name, "--label", `${ownerLabel}=${session}`,
    "--network", "none", "--user", user, "--platform", profile.container.platform,
    "--volume", `${volume}:/home/box/sand-data${readonly ? ":ro" : ""}`,
    "--entrypoint", "/usr/local/bin/node", profile.container.image, ...args,
  ]);
}

async function check(action, options, ...args) {
  const result = await run(["-e", fixture, action, ...args], options);
  assert.ok(result.ok, `${action}: ${result.output}`);
}

async function seed(provider, model, options) {
  return run(["/usr/local/bin/seed-local-settings.cjs", "--provider", provider,
    ...(model === undefined ? [] : ["--command-code-model", model])], options);
}

async function requireSeed(provider, model) {
  const result = await seed(provider, model);
  assert.ok(result.ok, `Settings initialization failed: ${result.output}`);
}

async function cleanup() {
  if (names.size > 0) {
    const output = await required(["container", "ls", "--all", "--quiet", "--filter", `label=${ownerLabel}=${session}`], "list owned containers");
    for (const id of output.split(/\r?\n/).filter(Boolean)) {
      const [container] = JSON.parse(await required(["container", "inspect", id], "inspect owned container"));
      assert.equal(container.Config?.Labels?.[ownerLabel], session, "container ownership label");
      assert.ok(names.has(container.Name?.replace(/^\//, "")), "container name belongs to this run");
      await required(["container", "rm", "--force", id], "remove owned container");
    }
  }
  if (volumeRequested) {
    const output = await required(["volume", "ls", "--quiet", "--filter", `label=${ownerLabel}=${session}`], "list owned volumes");
    for (const name of output.split(/\r?\n/).filter(Boolean)) {
      assert.equal(name, volume, "volume name belongs to this run");
      const [ownedVolume] = JSON.parse(await required(["volume", "inspect", name], "inspect owned volume"));
      assert.equal(ownedVolume.Name, volume, "inspected volume name");
      assert.equal(ownedVolume.Labels?.[ownerLabel], session, "volume ownership label");
      await required(["volume", "rm", name], "remove owned volume");
    }
  }
  report.cleanup = true;
}

try {
  profile = await client.inspect();
  report.host = profile.host;
  report.platform = profile.container.platform;
  report.image = profile.container.image;
  volumeRequested = true;
  await required(["volume", "create", "--label", `${ownerLabel}=${session}`, volume], "create owned volume");
  const [created] = JSON.parse(await required(["volume", "inspect", volume], "verify created volume"));
  assert.equal(created.Labels?.[ownerLabel], session, "created volume ownership label");

  await requireSeed("claude-code");
  await check("fresh");
  report.passed.push("new-volume");
  await check("box-write", { user: "box" });
  report.passed.push("box-writable");

  await check("existing");
  await requireSeed("command-code");
  await check("merged");
  await check("box-write", { user: "box" });
  report.passed.push("preserve-fields-and-model", "repair-owner", "unrelated-file-unchanged");
  await requireSeed("command-code");
  await check("unchanged");
  report.passed.push("idempotent");
  await requireSeed("command-code", "selected-model");
  await check("model");
  report.passed.push("explicit-model");

  const sensitiveMarker = `seed-private-${randomUUID()}`;
  await check("corrupt", undefined, sensitiveMarker);
  const corrupt = await seed("claude-code");
  assert.equal(corrupt.ok, false, "corrupt JSON must fail");
  assert.ok(!corrupt.output.includes(sensitiveMarker), "corrupt JSON output exposes file contents");
  assert.match(corrupt.output, /settings\.json 包含无效 JSON/, "corrupt JSON diagnostic");
  await check("unchanged");
  report.passed.push("corrupt-json-preserved", "no-content-in-error");

  await check("readonly");
  const readonly = await seed("command-code", undefined, { readonly: true });
  assert.equal(readonly.ok, false, "read-only volume must reject writes");
  assert.match(readonly.output, /EROFS|read-only file system/i, "read-only volume diagnostic");
  await check("unchanged");
  report.passed.push("readonly-preserved");
} catch (error) {
  failure = error;
  report.error = error.message;
} finally {
  try { await cleanup(); }
  catch (error) {
    report.cleanupError = error.message;
    failure = failure ? new AggregateError([failure, error], "Seed smoke and cleanup failed") : error;
  }
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(`Docker settings seed: ${report.passed.length} checks passed (${report.platform}); report: ${path.join(directory, "report.json")}`);
