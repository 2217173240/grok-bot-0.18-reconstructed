import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { upstreamPlatform } from "./upstream-platforms.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export async function verifyWindowsPackage({ packageRoot, asarPath, sourceRendererRoot, officialArchivePath, metadataPath = "windows-package-metadata.json" } = {}) {
  if ([packageRoot, asarPath, sourceRendererRoot, officialArchivePath].some(value => typeof value !== "string" || !value)) throw new TypeError("Explicit Windows package paths are required");
  const release = upstreamPlatform("win32-x64");
  const metadata = JSON.parse(await readFile(path.join(packageRoot, metadataPath), "utf8"));
  if (metadata.platform !== "win32" || metadata.arch !== "x64" || metadata.electronVersion !== "42.1.0" || metadata.asarSha256 !== sha256(await readFile(asarPath))) throw new Error("Windows package metadata identity mismatch");
  if (metadata.unsigned !== true || metadata.portable !== true) throw new Error("Windows package must be explicitly unsigned portable output");
  const { verifyChecksumPinnedRendererPackage } = await import("./renderer-package-verification.mjs");
  const renderer = await verifyChecksumPinnedRendererPackage({ platform: "win32-x64", archivePath: asarPath, sourceRendererRoot, officialArchivePath });
  await stat(path.join(packageRoot, "resources", "app.asar"));
  await stat(path.join(packageRoot, "Grok Bot.exe"));
  await stat(path.join(packageRoot, "resources", "app.asar.unpacked", "dist", "native", "sand-webauthn-signer.exe"));
  return { platform: "win32-x64", asarSha256: metadata.asarSha256, upstreamAsarSha256: release.asarSha256, renderer };
}
