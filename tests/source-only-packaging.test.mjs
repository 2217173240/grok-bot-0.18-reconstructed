import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { repoRoot } from "../scripts/lib/config.mjs";
import { assembleElectronMainProductionBindingManifest, buildProductionElectronMainIfSupplied } from "../scripts/electron-main-production-activation.mjs";
import { assembleHostProductionBindingManifest, buildProductionHostIfSupplied } from "../scripts/host-production-activation.mjs";
import { electronNodeGypArguments } from "../scripts/build-tree-sitter-electron.mjs";
import { expectedElectronArchiveSha256, installedElectronArchivePath, verifyElectronShellAgainstOfficialArchive } from "../scripts/lib/source-only-package.mjs";

test("Electron native build and shell identity are pinned to the official arm64 release", async () => {
  const checksums = JSON.parse(await readFile(path.join(repoRoot, "node_modules/electron/checksums.json"), "utf8"));
  assert.equal(checksums["electron-v42.1.0-darwin-arm64.zip"], expectedElectronArchiveSha256);
  assert.match(installedElectronArchivePath("/cache"), /\/cache\/[0-9a-f]{64}\/electron-v42\.1\.0-darwin-arm64\.zip$/);
  for (const name of ["tree-sitter", "tree-sitter-bash"]) {
    const args = electronNodeGypArguments(name, "/cache/headers");
    assert.ok(args.includes(`--target=42.1.0`));
    assert.ok(args.includes("--runtime=electron"));
    assert.ok(args.includes("--dist-url=https://artifacts.electronjs.org/headers/dist"));
    assert.ok(args.includes("--devdir=/cache/headers"));
  }
  assert.throws(() => electronNodeGypArguments("better-sqlite3"), /Unsupported Electron native package/);
});

test("Electron shell verification rejects a modified npm archive before extraction", async () => {
  const testRoot = path.join(repoRoot, ".cache");
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(path.join(testRoot, "electron-archive-test-"));
  try {
    const archivePath = path.join(directory, "electron-v42.1.0-darwin-arm64.zip");
    await writeFile(archivePath, "modified archive");
    await assert.rejects(
      verifyElectronShellAgainstOfficialArchive("/unused-shell", { archivePath }),
      /failed its official SHA-256 check/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source-only main and host production bindings resolve to reviewed source", async () => {
  const [main, host] = await Promise.all([
    assembleElectronMainProductionBindingManifest(null, { sourceOnly: true }),
    assembleHostProductionBindingManifest(null, { sourceOnly: true }),
  ]);
  for (const result of [main, host]) {
    assert.deepEqual(result.unboundBindings, []);
    for (const binding of result.bindings) {
      assert.ok(binding.resolvedModule.startsWith(path.join(repoRoot, "source") + path.sep));
      assert.ok(existsSync(binding.resolvedModule));
    }
  }
  assert.equal(host.activationEvidence.runnerRealTurn.status, "supported");
});

test("source-only production bundles contain runnable entrypoints and provenance", async () => {
  const testRoot = path.join(repoRoot, ".cache", "source-only-test");
  await mkdir(path.dirname(testRoot), { recursive: true });
  const outputRoot = await mkdtemp(`${testRoot}-`);
  try {
    const [main, host] = await Promise.all([
      buildProductionElectronMainIfSupplied({ outputRoot, manifestPath: null, sourceOnly: true, reconstructedPackage: true }),
      buildProductionHostIfSupplied({ outputRoot, manifestPath: null, sourceOnly: true }),
    ]);
    assert.equal(main.clean, true);
    assert.equal(host.clean, true);
    assert.ok(host.provenance.executableGraph.externalImports.includes("pdfjs-dist/legacy/build/pdf.mjs"));
    for (const [runtime, result] of [["electron-main", main], ["host", host]]) {
      const executable = await readFile(result.outputPath, "utf8");
      const provenance = JSON.parse(await readFile(result.provenancePath, "utf8"));
      assert.ok(executable.includes("Deterministic clean-source"));
      assert.equal(provenance.sourceOnly, true);
      assert.equal(provenance.status, "validated-clean-source");
      assert.deepEqual(provenance.executableGraph.forbiddenInputs, []);
      assert.doesNotMatch(executable, /src\/app\/|recovered\/source-capsules\//, runtime);
    }
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
