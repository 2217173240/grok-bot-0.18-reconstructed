// The local Docker runtime staging is content addressed, so each distinct host
// bundle leaves its own directory behind under ~/.grokbot-local/local-docker-runtime
// and repeated starts accumulate them without bound. Pruning keeps the newest
// few and drops the rest, including directories written by earlier layout
// versions. The rule has to be independent of when it runs, so this test asserts
// the same set survives whether it is applied once or repeatedly.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

// The connector resolves its siblings through the build's extension mapping, so
// bundle it before importing rather than relying on Node's TypeScript support.
async function loadPrune() {
  const buildRoot = await mkdtemp(path.join(tmpdir(), "grok-runtime-prune-module-"));
  const outfile = path.join(buildRoot, "connector.mjs");
  await build({
    entryPoints: [path.join(repositoryRoot, "source/electron-main/box/local-docker-host-connector.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  const module = await import(pathToFileURL(outfile).href);
  return { module, buildRoot };
}

const HOST_SHA = "a".repeat(64);
const DAEMON_SHA = "b".repeat(64);

async function makeStagedRuntime(root, name, modifiedAtMs) {
  const directory = path.join(root, name);
  await mkdir(path.join(directory, "sand-host"), { recursive: true });
  await writeFile(path.join(directory, "sand-host", "host-main.cjs"), `fixture:${name}\n`);
  await utimes(directory, modifiedAtMs / 1000, modifiedAtMs / 1000);
  return directory;
}

test("staged runtime pruning keeps the newest directories and converges", async () => {
  const { module, buildRoot } = await loadPrune();
  const { LOCAL_HOST_RUNTIME_RETAINED_DIRECTORIES, pruneLocalHostRuntimeStaging } = module;
  const root = await mkdtemp(path.join(tmpdir(), "grok-runtime-prune-"));
  try {
    const base = Date.parse("2026-09-21T00:00:00Z");
    const names = [
      `v3-${HOST_SHA}-${DAEMON_SHA}`,
      `v3-${"c".repeat(64)}-${DAEMON_SHA}`,
      `v3-${"d".repeat(64)}-${DAEMON_SHA}`,
      `v3-${"e".repeat(64)}-${DAEMON_SHA}`,
      `v3-${"f".repeat(64)}-${DAEMON_SHA}`,
    ];
    // Oldest first, one hour apart, so "newest" is unambiguous.
    for (const [index, name] of names.entries()) {
      await makeStagedRuntime(root, name, base + index * 3_600_000);
    }
    // Directories from an earlier layout version are pruned as well.
    await makeStagedRuntime(root, `v2-${"9".repeat(64)}-${DAEMON_SHA}`, base - 3_600_000);
    // Anything that is not a staged runtime directory is left alone.
    await mkdir(path.join(root, "notes"), { recursive: true });
    await writeFile(path.join(root, "renderer-router-extension.json"), "{}\n");

    const firstRun = await pruneLocalHostRuntimeStaging(root);
    const survivors = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const expectedSurvivors = [...names].slice(-LOCAL_HOST_RUNTIME_RETAINED_DIRECTORIES).sort();
    assert.deepEqual(survivors.filter((name) => name.startsWith("v")), expectedSurvivors);
    assert.ok(survivors.includes("notes"), "unrelated directories must survive");
    assert.equal(firstRun.length, names.length + 1 - LOCAL_HOST_RUNTIME_RETAINED_DIRECTORIES);

    // Idempotent: a second pass removes nothing and changes nothing.
    const secondRun = await pruneLocalHostRuntimeStaging(root);
    assert.deepEqual(secondRun, []);
    const afterSecondRun = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(afterSecondRun, survivors);

    // A missing runtime root is not an error.
    assert.deepEqual(await pruneLocalHostRuntimeStaging(path.join(root, "absent")), []);

    // A directory the running container still mounts is never a candidate, even
    // when it has aged out of the retained window. Recency is not the safety
    // argument: a container whose drift check missed a daemon-only rebuild can
    // still be reading an old directory.
    const second = await mkdtemp(path.join(tmpdir(), "grok-runtime-prune-protected-"));
    try {
      const protectedName = `v3-${"1".repeat(64)}-${DAEMON_SHA}`;
      const protectedPath = await makeStagedRuntime(second, protectedName, base);
      for (const [index, name] of names.entries()) {
        await makeStagedRuntime(second, name, base + 7_200_000 + index * 3_600_000);
      }
      const removedWithProtection = await pruneLocalHostRuntimeStaging(second, [protectedPath]);
      const survivorsWithProtection = (await readdir(second, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      assert.ok(
        survivorsWithProtection.includes(protectedName),
        "the mounted directory must survive even when it is the oldest",
      );
      assert.ok(!removedWithProtection.includes(protectedPath), "the mounted directory must not be reported as removed");
      // Protection does not stop the retention rule from working on the rest.
      assert.equal(
        survivorsWithProtection.length,
        LOCAL_HOST_RUNTIME_RETAINED_DIRECTORIES + 1,
        "the retained window still applies to unprotected directories",
      );
    } finally {
      await rm(second, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(buildRoot, { recursive: true, force: true });
  }
});
