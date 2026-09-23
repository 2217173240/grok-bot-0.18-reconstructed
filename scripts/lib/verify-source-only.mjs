import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { extractFile, listPackage } from "@electron/asar";

import { reconstructedBundleId, reconstructedName } from "./config.mjs";
import { resolvePackagedAppArtifacts } from "./packaged-app.mjs";
import { capture, run } from "./process.mjs";
import { expectedElectronArchiveSha256 } from "./source-only-package.mjs";
import { SYSTEM_TOOLS } from "./system-tools.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export async function verifySourceOnlyPackage(appPath) {
  const { asarPath, unpackedPath } = resolvePackagedAppArtifacts(appPath);
  const listing = new Set(listPackage(asarPath));
  const requireEntry = relative => {
    if (!listing.has(`/${relative}`)) throw new Error(`Source-only ASAR is missing ${relative}`);
    return extractFile(asarPath, relative);
  };
  const manifest = JSON.parse(requireEntry("dist/reconstruction-build.json").toString("utf8"));
  if (manifest.buildKind !== "source-only-components") throw new Error(`Unexpected packaged build kind: ${manifest.buildKind}`);
  const composition = manifest.runtimeComposition;
  if (!Array.isArray(composition) || composition.some(item => item.mode.startsWith("blocked-") || item.mode.includes("artifact"))) {
    throw new Error("Source-only package contains an unresolved or artifact runtime");
  }
  for (const runtime of ["electron-main", "host", "renderer"]) {
    if (composition.find(item => item.runtime === runtime)?.mode !== "clean-source") throw new Error(`Source-only package lacks clean ${runtime}`);
  }
  const native = composition.find(item => item.runtime === "electron-runtime-dependencies");
  if (native?.mode !== "generated-runtime" || native.verifiedElectronAbi !== 146) throw new Error("Source-only package lacks verified Electron ABI 146 native dependencies");
  for (const relative of [
    "package.json",
    "dist/electron-main/main.cjs",
    "dist/electron-main-production-bindings.json",
    "dist/host/host-main.cjs",
    "dist/host-production-bindings.json",
    "dist/electron-preload/preload.cjs",
    "dist/node-agent-coordinator/main.cjs",
    "dist/box-exec-daemon/main.cjs",
    "dist/local-exec-daemon/main.cjs",
    "dist/renderer/index.html",
    "node_modules/undici/package.json",
    "node_modules/ws/package.json",
  ]) requireEntry(relative);
  const packageJson = JSON.parse(requireEntry("package.json").toString("utf8"));
  if (packageJson.main !== "dist/electron-main/main.cjs" || packageJson.sandLab === true) throw new Error("Source-only package has the wrong production entrypoint or lab mode");
  for (const output of manifest.outputs) {
    const bytes = requireEntry(output.path);
    if (bytes.byteLength !== output.bytes || sha256(bytes) !== output.sha256) throw new Error(`Source-only output drifted: ${output.path}`);
  }
  for (const runtime of ["electron-main", "host"]) {
    const provenance = JSON.parse(requireEntry(`dist/${runtime === "host" ? "host" : "electron-main"}-production-bindings.json`).toString("utf8"));
    if (provenance.status !== "validated-clean-source" || provenance.sourceOnly !== true || provenance.executableGraph.forbiddenInputs.length > 0) {
      throw new Error(`Source-only ${runtime} binding provenance is invalid`);
    }
  }
  const renderer = composition.find(item => item.runtime === "renderer");
  const rendererProvenance = JSON.parse(requireEntry(renderer.provenance).toString("utf8"));
  if (rendererProvenance.mode !== "clean-source" || rendererProvenance.graph?.forbiddenInputs?.length !== 0) {
    throw new Error("Source-only renderer provenance is invalid");
  }
  for (const relative of [
    "dist/deps/tree-sitter/build/Release/tree_sitter_runtime_binding.node",
    "dist/deps/tree-sitter-bash/build/Release/tree_sitter_bash_binding.node",
    "dist/node-deps/tree-sitter/build/Release/tree_sitter_runtime_binding.node",
    "dist/node-deps/tree-sitter-bash/build/Release/tree_sitter_bash_binding.node",
  ]) await access(path.join(unpackedPath, relative));
  const stamp = JSON.parse(await readFile(path.join(appPath, "Contents/Resources/build-stamp.json"), "utf8"));
  if (stamp.electron !== "42.1.0" || stamp.bundleId !== reconstructedBundleId) throw new Error("Source-only build stamp has the wrong Electron or bundle identity");
  if (stamp.electronArchiveSha256 !== expectedElectronArchiveSha256 || stamp.electronShellFileCount !== 272) {
    throw new Error("Source-only build stamp has an unverified Electron shell identity");
  }
  const infoPlist = path.join(appPath, "Contents/Info.plist");
  const [bundleId, displayName, urlTypes] = await Promise.all([
    capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleIdentifier", "raw", infoPlist]),
    capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleDisplayName", "raw", infoPlist]),
    capture(SYSTEM_TOOLS.plutil, ["-extract", "CFBundleURLTypes", "xml1", "-o", "-", infoPlist]),
  ]);
  if (bundleId !== reconstructedBundleId || displayName !== reconstructedName || !urlTypes.includes("<string>sand</string>")) {
    throw new Error("Source-only application identity or auth callback registration is invalid");
  }
  await run(SYSTEM_TOOLS.codesign, ["--verify", "--deep", "--strict", appPath]);
  return { appPath, outputCount: manifest.outputs.length, electron: stamp.electron, runtimeCount: composition.length };
}
