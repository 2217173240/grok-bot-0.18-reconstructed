import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { packager } from "@electron/packager";
import { download } from "@electron/get";
import { NtExecutable, NtExecutableResource, Resource, Data } from "resedit";
import sevenZip from "7zip-bin";
import { buildFidelityReconstructedAsar } from "./clean-build.mjs";
import { ensureWindowsRuntime } from "./lib/windows-runtime.mjs";
import { repoRoot } from "./lib/config.mjs";
import { readDepsPin } from "./lib/deps-pin.mjs";
import { verifyChecksumPinnedRendererPackage } from "./lib/renderer-package-verification.mjs";
import { verifyWindowsPackage } from "./lib/windows-package-verification.mjs";
import { run } from "./lib/process.mjs";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows packaging requires a Windows x64 host");
const scratch = path.join(repoRoot, ".cache/windows-package-tmp");
await mkdir(scratch, { recursive: true });
const reference = await ensureWindowsRuntime();
const executable = NtExecutable.from(await readFile(path.join(reference.root, "Grok Bot.exe")), { ignoreCert: true });
const resources = NtExecutableResource.from(executable);
const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
if (groups.length !== 1) throw new Error("Expected one upstream Windows application icon group");
const icon = new Data.IconFile();
icon.icons = groups[0].getIconItemsFromEntries(resources.entries).map(data => ({ data }));
const iconPath = path.join(scratch, "grok-bot.ico");
await writeFile(iconPath, Buffer.from(icon.generate()));
const electronZip = await download("42.1.0", { platform: "win32", arch: "x64", cacheRoot: path.join(repoRoot, ".cache", "electron"), mirrorOptions: {} });
if (createHash("sha256").update(await readFile(electronZip)).digest("hex") !== "0b03582d0a68dce8473fcc090114dabef7eaafd52b6d8cd2c85b000358c6af31") throw new Error("Electron 42.1.0 win32-x64 ZIP checksum mismatch");
const built = await buildFidelityReconstructedAsar({ runtimeReference: { platform: reference.platform, root: reference.root, resources: reference.resources, sourceRoot: reference.sourceRoot } });
await verifyChecksumPinnedRendererPackage({ platform: "win32-x64", archivePath: built.builtAsar, sourceRendererRoot: path.join(reference.sourceRoot, "dist/renderer"), officialArchivePath: reference.archive });
const outputRoot = path.join(repoRoot, "dist", "Grok Bot 0.18 Reconstructed-win32-x64");
const packOut = path.join(repoRoot, ".cache", "windows-pack-out");
await rm(outputRoot, { recursive: true, force: true });
await rm(packOut, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const [stagedPackageRoot] = await packager({
  dir: path.dirname(built.builtAsar), out: packOut, tmpdir: scratch,
  platform: "win32", arch: "x64", name: "Grok Bot 0.18 Reconstructed", executableName: "Grok Bot",
  appVersion: "0.18.0", buildVersion: "0.18.0.1", icon: iconPath,
  electronVersion: "42.1.0", electronZipDir: path.dirname(electronZip), prebuiltAsar: built.builtAsar,
  overwrite: true, asar: false, prune: false,
  win32metadata: { ProductName: "Grok Bot 0.18 Reconstructed", FileDescription: "Grok Bot 0.18 Reconstructed", CompanyName: "Independent reconstruction", OriginalFilename: "Grok Bot.exe" },
});
const packageRoot = outputRoot;
await cp(stagedPackageRoot, packageRoot, { recursive: true });
const packagedAsar = path.join(packageRoot, "resources", "app.asar");
await rm(packagedAsar, { force: true });
await cp(built.builtAsar, packagedAsar);
await rm(`${packagedAsar}.unpacked`, { recursive: true, force: true });
await cp(built.builtAsarUnpacked, `${packagedAsar}.unpacked`, { recursive: true, dereference: false });
for (const file of ["start-local.ps1", "scripts/windows-local-launch.mjs", "scripts/lib/local-launch-config.mjs", "source/shared/node/local-runtime-profile.mjs", "source/shared/node/local-docker-client.mjs"]) {
  await mkdir(path.dirname(path.join(packageRoot, file)), { recursive: true });
  await cp(path.join(repoRoot, file), path.join(packageRoot, file));
}
const depsPin = await readDepsPin(repoRoot, "linux/amd64");
const buildStamp = { platform: "win32-x64", electronVersion: "42.1.0", sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(), depsPin, packagedAsarSha256: createHash("sha256").update(await readFile(packagedAsar)).digest("hex"), upstreamAsarSha256: reference.asarSha256, inputs: ["source", "Windows 0.18.0 renderer", "Windows Electron 42.1.0"] };
await writeFile(path.join(packageRoot, "resources", "build-stamp.json"), `${JSON.stringify(buildStamp, null, 2)}\n`);
await writeFile(path.join(packageRoot, "windows-package-metadata.json"), `${JSON.stringify({ platform: "win32", arch: "x64", electronVersion: "42.1.0", asarSha256: buildStamp.packagedAsarSha256, unsigned: true, portable: true }, null, 2)}\n`);
await verifyWindowsPackage({ packageRoot, asarPath: packagedAsar, stageRoot: built.stagedAppDir, sourceRendererRoot: path.join(reference.sourceRoot, "dist/renderer"), officialArchivePath: reference.archive });
const zipPath = `${packageRoot}.zip`;
await rm(zipPath, { force: true });
await run(sevenZip.path7za, ["a", "-tzip", "-mx=5", zipPath, path.basename(packageRoot)], { cwd: path.dirname(packageRoot) });
console.log(`Packaged unsigned Windows portable application: ${packageRoot}`);
