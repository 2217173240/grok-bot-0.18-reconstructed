import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { buildFidelityReconstructedAsar } from "./clean-build.mjs";
import { outputApp, outputDir, reconstructedBundleId, reconstructedName, repoRoot, sourceAppDir } from "./lib/config.mjs";
import { signAppBundleAdHoc } from "./lib/codesign.mjs";
import { readDepsPin } from "./lib/deps-pin.mjs";
import { verifyChecksumPinnedRendererPackage, verifyOfficialMacReference, verifyReconstructedMacPackage } from "./lib/macos-package-verification.mjs";
import { run } from "./lib/process.mjs";
import { SYSTEM_TOOLS } from "./lib/system-tools.mjs";

if (process.platform !== "darwin") throw new Error("macOS packaging requires macOS");

const packageTempDir = path.join(repoRoot, ".cache", "mac-package-tmp");
await mkdir(packageTempDir, { recursive: true });
process.env.TMPDIR = packageTempDir;
process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`;

const built = await buildFidelityReconstructedAsar();
const official = await verifyOfficialMacReference({ runtimeApp: built.runtimeApp });
await verifyChecksumPinnedRendererPackage({
  archivePath: built.builtAsar,
  sourceRendererRoot: path.join(sourceAppDir, "dist", "renderer"),
  officialArchivePath: official.asarPath,
});

await mkdir(outputDir, { recursive: true });
await rm(outputApp, { recursive: true, force: true });
await run(SYSTEM_TOOLS.ditto, [built.runtimeApp, outputApp]);
await run(SYSTEM_TOOLS.xattr, ["-cr", outputApp]);

const resources = path.join(outputApp, "Contents", "Resources");
const packagedAsar = path.join(resources, "app.asar");
const packagedUnpacked = `${packagedAsar}.unpacked`;
await rm(packagedAsar, { force: true });
await rm(packagedUnpacked, { recursive: true, force: true });
await cp(built.builtAsar, packagedAsar);
await cp(built.builtAsarUnpacked, packagedUnpacked, { recursive: true, dereference: false, preserveTimestamps: true });

const infoPlist = path.join(outputApp, "Contents", "Info.plist");
await run(SYSTEM_TOOLS.plutil, ["-remove", "ElectronAsarIntegrity", infoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-replace", "CFBundleIdentifier", "-string", reconstructedBundleId, infoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-replace", "CFBundleDisplayName", "-string", reconstructedName, infoPlist]);
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const depsPin = await readDepsPin(repoRoot);
const buildStamp = `${JSON.stringify({
  sourceRevision,
  builtAt: new Date().toISOString(),
  bundleId: reconstructedBundleId,
  depsPin,
  officialShellSha256: official.shellHash,
  officialAsarSha256: official.asarHash,
  packagedAsarSha256: createHash("sha256").update(await readFile(packagedAsar)).digest("hex"),
  inputs: ["source", "src/app/dist/renderer", "src/app/dist/deps", "src/app/dist/native", "official Grok Bot 0.18.0 macOS app"],
}, null, 2)}\n`;
await writeFile(path.join(resources, "build-stamp.json"), buildStamp);
await signAppBundleAdHoc(outputApp);
await run(SYSTEM_TOOLS.codesign, ["--verify", "--deep", "--strict", outputApp]);
await verifyReconstructedMacPackage({
  officialApp: built.runtimeApp,
  reconstructedApp: outputApp,
  sourceUnpackedRoot: built.builtAsarUnpacked,
  packagedUnpackedRoot: packagedUnpacked,
});
await writeFile(path.join(outputDir, "build-stamp.json"), buildStamp);
console.log(`Packaged checksum-pinned renderer application: ${outputApp}`);
