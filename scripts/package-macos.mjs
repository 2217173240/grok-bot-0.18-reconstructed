import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { buildElectronTreeSitterRuntime } from "./build-tree-sitter-electron.mjs";
import { buildSourceOnlyDistribution } from "./lib/clean-build.mjs";
import { outputApp, outputDir, reconstructedBundleId, reconstructedName, repoRoot } from "./lib/config.mjs";
import { signAppBundleAdHoc } from "./lib/codesign.mjs";
import { readDepsPin } from "./lib/deps-pin.mjs";
import { assertSourceOnlyExecutableReady, packSourceOnlyDistribution, verifyInstalledElectronShell } from "./lib/source-only-package.mjs";
import { run } from "./lib/process.mjs";
import { SYSTEM_TOOLS } from "./lib/system-tools.mjs";

if (process.platform !== "darwin") throw new Error("macOS packaging requires macOS");

const packageTempDir = path.join(repoRoot, ".cache", "mac-package-tmp");
await mkdir(packageTempDir, { recursive: true });
process.env.TMPDIR = packageTempDir;
process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`;
const shell = await verifyInstalledElectronShell();
await buildElectronTreeSitterRuntime();
const distribution = await buildSourceOnlyDistribution();
await assertSourceOnlyExecutableReady(distribution);
const { builtAsar, builtAsarUnpacked } = await packSourceOnlyDistribution(distribution);

await mkdir(outputDir, { recursive: true });
await rm(outputApp, { recursive: true, force: true });
await run(SYSTEM_TOOLS.ditto, [shell.shell, outputApp]);
await run(SYSTEM_TOOLS.xattr, ["-cr", outputApp]);

const resources = path.join(outputApp, "Contents", "Resources");
const packagedAsar = path.join(resources, "app.asar");
await rm(path.join(resources, "default_app.asar"), { force: true });
await cp(builtAsar, packagedAsar);
await cp(builtAsarUnpacked, `${packagedAsar}.unpacked`, { recursive: true, dereference: false });

const infoPlist = path.join(outputApp, "Contents", "Info.plist");
await run(SYSTEM_TOOLS.plutil, ["-replace", "CFBundleIdentifier", "-string", reconstructedBundleId, infoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-replace", "CFBundleDisplayName", "-string", reconstructedName, infoPlist]);
await run(SYSTEM_TOOLS.plutil, ["-insert", "CFBundleURLTypes", "-xml", "<array><dict><key>CFBundleTypeRole</key><string>Viewer</string><key>CFBundleURLName</key><string>Grok Bot reconstructed auth callback</string><key>CFBundleURLSchemes</key><array><string>sand</string></array></dict></array>", infoPlist]);
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const depsPin = await readDepsPin(repoRoot);
const buildStamp = `${JSON.stringify({ sourceRevision, builtAt: new Date().toISOString(), bundleId: reconstructedBundleId, electron: shell.version, electronArchiveSha256: shell.archiveSha256, electronShellFileCount: shell.fileCount, depsPin, inputs: ["source", "frontend/src", "node_modules/electron"] }, null, 2)}\n`;
await writeFile(path.join(resources, "build-stamp.json"), buildStamp);
await signAppBundleAdHoc(outputApp);
await run(SYSTEM_TOOLS.codesign, ["--verify", "--deep", "--strict", outputApp]);
await writeFile(path.join(outputDir, "build-stamp.json"), buildStamp);
console.log(`Packaged source-only application: ${outputApp}`);
