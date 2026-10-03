import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NtExecutable, NtExecutableResource, Resource } from "resedit";
import { snapshotFiles, verifyStagedPackageIntegrity } from "./asar-integrity.mjs";
import { verifyChecksumPinnedRendererPackage } from "./renderer-package-verification.mjs";
import { upstreamPlatform } from "./upstream-platforms.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export async function verifyWindowsPackage({ packageRoot, asarPath, stageRoot, sourceRendererRoot, officialArchivePath, metadataPath = "windows-package-metadata.json" } = {}) {
  if ([packageRoot, asarPath, stageRoot, sourceRendererRoot, officialArchivePath].some(value => typeof value !== "string" || !value)) throw new TypeError("Explicit Windows package paths are required");
  if (path.resolve(asarPath) !== path.resolve(packageRoot, "resources/app.asar")) throw new Error("Verification must target the packaged ASAR");
  const release = upstreamPlatform("win32-x64");
  const metadata = JSON.parse(await readFile(path.join(packageRoot, metadataPath), "utf8"));
  if (metadata.platform !== "win32" || metadata.arch !== "x64" || metadata.electronVersion !== "42.1.0" || metadata.asarSha256 !== sha256(await readFile(asarPath))) throw new Error("Windows package metadata identity mismatch");
  if (metadata.unsigned !== true || metadata.portable !== true) throw new Error("Windows package must be explicitly unsigned portable output");
  await verifyStagedPackageIntegrity({ stageRoot, archivePath: asarPath, unpackedRoot: `${asarPath}.unpacked`, before: await snapshotFiles(stageRoot) });
  const renderer = await verifyChecksumPinnedRendererPackage({ platform: "win32-x64", archivePath: asarPath, sourceRendererRoot, officialArchivePath });
  await stat(path.join(packageRoot, "resources", "app.asar"));
  const executable = NtExecutable.from(await readFile(path.join(packageRoot, "Grok Bot.exe")));
  if (executable.newHeader.fileHeader.machine !== 0x8664) throw new Error("Packaged executable is not Windows x64");
  const versions = Resource.VersionInfo.fromEntries(NtExecutableResource.from(executable).entries);
  if (!versions.some(version => version.getAvailableLanguages().some(language => {
    const values = version.getStringValues(language);
    return values.ProductName === "Grok Bot 0.18 Reconstructed" && values.CompanyName === "Independent reconstruction";
  }))) throw new Error("Packaged executable product identity mismatch");
  await stat(path.join(packageRoot, "resources", "app.asar.unpacked", "dist", "native", "sand-webauthn-signer.exe"));
  return { platform: "win32-x64", asarSha256: metadata.asarSha256, upstreamAsarSha256: release.asarSha256, renderer };
}
