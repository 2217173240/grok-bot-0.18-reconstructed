import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("local Docker desktop health requires one router and one session sync", async () => {
  await mkdir(path.join(repositoryRoot, ".cache"), { recursive: true });
  const buildRoot = await mkdtemp(path.join(repositoryRoot, ".cache", "grok-desktop-health-"));
  try {
    const outfile = path.join(buildRoot, "connector.mjs");
    await build({
      entryPoints: [path.join(repositoryRoot, "source/electron-main/box/local-docker-host-connector.ts")],
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      outfile,
      logLevel: "silent",
    });
    const { parseLocalDockerDesktopProcessCounts, desktopProcessRebuildReason, resolveLocalAdminBox } = await import(pathToFileURL(outfile).href);
    assert.equal(resolveLocalAdminBox({}, true), "docker");
    assert.throws(() => resolveLocalAdminBox({ SAND_LOCAL_ADMIN_BOX: "host" }, true), /Unsupported SAND_LOCAL_ADMIN_BOX/);
    const healthy = parseLocalDockerDesktopProcessCounts("1\n1");
    assert.deepEqual(healthy, { router: 1, sessionSync: 1 });
    assert.equal(desktopProcessRebuildReason(healthy), undefined);
    for (const [output, expected] of [["0\n1", /router: 0/], ["1\n0", /session-sync: 0/], ["1\n2", /session-sync: 2/]]) {
      assert.match(desktopProcessRebuildReason(parseLocalDockerDesktopProcessCounts(output)), expected);
    }
    assert.match(desktopProcessRebuildReason(parseLocalDockerDesktopProcessCounts("0\n1")), /Reset Grok Bot's Computer/);
    for (const output of ["", "1", "1\n", "1\nnot-a-count", "pgrep: not found\n0"]) {
      assert.throws(() => parseLocalDockerDesktopProcessCounts(output), /Could not inspect local Docker desktop processes/);
    }
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
});
