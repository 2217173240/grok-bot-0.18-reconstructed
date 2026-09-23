import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { builtAsar, builtAsarUnpacked, repoRoot, stagedAppDir } from "./config.mjs";
import { packStagedAppWithIntegrity } from "./asar-integrity.mjs";
import { run } from "./process.mjs";

export const electronShell = path.join(repoRoot, "node_modules", "electron", "dist", "Electron.app");
export const expectedElectronArchiveSha256 = "98d097299eb08094d0df3312b2d6e8677069d8defdab891143628d4f82f46117";

async function sha256(target) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(target)) hash.update(bytes);
  return hash.digest("hex");
}

async function shellInventory(root, current = root, found = new Map()) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    const relative = path.relative(root, target).split(path.sep).join("/");
    if (entry.isDirectory()) await shellInventory(root, target, found);
    else if (entry.isSymbolicLink()) found.set(relative, `link:${await readlink(target)}`);
    else if (entry.isFile()) found.set(relative, `file:${await sha256(target)}`);
    else throw new Error(`Unexpected installed Electron shell entry: ${relative}`);
  }
  return found;
}

export function installedElectronArchivePath(cacheRoot = process.env.electron_config_cache || path.join(homedir(), "Library/Caches/electron")) {
  const filename = "electron-v42.1.0-darwin-arm64.zip";
  const url = new URL(`https://github.com/electron/electron/releases/download/v42.1.0/${filename}`);
  url.pathname = path.posix.dirname(url.pathname);
  const cacheKey = createHash("sha256").update(url.toString()).digest("hex");
  return path.join(cacheRoot, cacheKey, filename);
}

export async function verifyElectronShellAgainstOfficialArchive(shell, { archivePath = installedElectronArchivePath(), extract = (archive, directory) => run("/usr/bin/ditto", ["-xk", archive, directory]) } = {}) {
  const checksums = JSON.parse(await readFile(path.join(repoRoot, "node_modules/electron/checksums.json"), "utf8"));
  const filename = "electron-v42.1.0-darwin-arm64.zip";
  if (checksums[filename] !== expectedElectronArchiveSha256) throw new Error("Installed Electron package checksum material drifted from the pinned official archive");
  try { await access(archivePath); }
  catch { throw new Error(`Verified Electron npm archive cache is missing at ${archivePath}; rerun npm ci with Electron install scripts enabled`); }
  if (await sha256(archivePath) !== expectedElectronArchiveSha256) throw new Error("Electron 42.1.0 archive failed its official SHA-256 check");
  const cacheRoot = path.join(repoRoot, ".cache");
  await mkdir(cacheRoot, { recursive: true });
  const referenceRoot = await mkdtemp(path.join(cacheRoot, "electron-shell-reference-"));
  try {
    await extract(archivePath, referenceRoot);
    const reference = await shellInventory(path.join(referenceRoot, "Electron.app"));
    const installed = await shellInventory(shell);
    if (reference.size !== installed.size) throw new Error(`Installed Electron shell file count drifted: ${reference.size} -> ${installed.size}`);
    for (const [relative, expected] of reference) {
      if (installed.get(relative) !== expected) throw new Error(`Installed Electron shell differs from the official archive at ${relative}`);
    }
    return { archiveSha256: expectedElectronArchiveSha256, fileCount: reference.size };
  } finally {
    await rm(referenceRoot, { recursive: true, force: true });
  }
}

export async function verifyInstalledElectronShell(shell = electronShell, options = {}) {
  const packageMetadata = JSON.parse(await readFile(path.join(repoRoot, "node_modules/electron/package.json"), "utf8"));
  if (packageMetadata.version !== "42.1.0") throw new Error(`Expected installed Electron 42.1.0, found ${packageMetadata.version}`);
  for (const relative of [
    "Contents/Info.plist",
    "Contents/MacOS/Electron",
    "Contents/Frameworks/Electron Framework.framework",
    "Contents/Resources/default_app.asar",
  ]) {
    try { await access(path.join(shell, relative)); }
    catch { throw new Error(`Installed Electron 42.1.0 shell is incomplete: ${relative}`); }
  }
  const helpers = (await readdir(path.join(shell, "Contents/Frameworks"))).filter(name => name.endsWith(" Helper.app"));
  if (helpers.length < 1) throw new Error("Installed Electron 42.1.0 shell has no helper apps");
  const official = await verifyElectronShellAgainstOfficialArchive(shell, options);
  return { shell, version: packageMetadata.version, helpers, ...official };
}

export async function assertSourceOnlyExecutableReady(distribution) {
  if (distribution?.buildManifest?.buildKind !== "source-only-components") {
    throw new Error("Packaging requires a source-only component distribution");
  }
  const composition = distribution.buildManifest.runtimeComposition;
  const blocked = composition.find(item => item.mode?.startsWith("blocked-"));
  if (blocked != null) {
    throw new Error(`Source-only macOS package blocked: ${blocked.runtime} is ${blocked.mode}; ${blocked.reason}`);
  }
  for (const runtime of ["electron-main", "host", "renderer"]) {
    const entry = composition.find(item => item.runtime === runtime);
    if (entry?.mode !== "clean-source") {
      throw new Error(`Source-only macOS package blocked: ${runtime} is ${entry?.mode ?? "missing"}; ${entry?.reason ?? "no runnable source entrypoint"}`);
    }
    try { await access(path.join(distribution.outputRoot, entry.path)); }
    catch { throw new Error(`Source-only macOS package blocked: ${runtime} executable is absent at ${entry.path}`); }
  }
  const native = composition.find(item => item.runtime === "electron-runtime-dependencies");
  if (native?.mode !== "generated-runtime" || native.verifiedElectronAbi !== 146) {
    throw new Error("Source-only macOS package blocked: Electron 42 ABI 146 native runtime is unverified");
  }
  for (const relative of [
    "dist/deps/tree-sitter/build/Release/tree_sitter_runtime_binding.node",
    "dist/deps/tree-sitter-bash/build/Release/tree_sitter_bash_binding.node",
  ]) {
    try { await access(path.join(distribution.outputRoot, relative)); }
    catch { throw new Error(`Source-only macOS package blocked: native executable is absent at ${relative}`); }
  }
}

export async function packSourceOnlyDistribution(distribution, {
  stageRoot = stagedAppDir,
  archivePath = builtAsar,
  unpackedRoot = builtAsarUnpacked,
} = {}) {
  await assertSourceOnlyExecutableReady(distribution);
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });
  for (const entry of await readdir(distribution.outputRoot)) {
    if (entry !== "dist" && entry !== "node_modules") continue;
    await cp(path.join(distribution.outputRoot, entry), path.join(stageRoot, entry), { recursive: true, dereference: false });
  }
  await writeFile(path.join(stageRoot, "package.json"), `${JSON.stringify({
    name: "grok-bot-reconstructed",
    version: "0.18.0-reconstructed.1",
    productName: "Grok Bot 0.18 Reconstructed",
    main: "dist/electron-main/main.cjs",
  }, null, 2)}\n`);
  await packStagedAppWithIntegrity({ stageRoot, archivePath, unpackedRoot });
  return { builtAsar: archivePath, builtAsarUnpacked: unpackedRoot };
}
