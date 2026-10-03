import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { extractAll, extractFile } from "@electron/asar";
import sevenZip from "7zip-bin";
import { repoRoot } from "./config.mjs";
import { run } from "./process.mjs";
import { upstreamPlatform } from "./upstream-platforms.mjs";

const release = upstreamPlatform("win32-x64");
export const windowsRuntimeRoot = path.join(repoRoot, ".cache/windows-runtime/reference");
export const windowsInstallerPath = path.join(repoRoot, ".cache/downloads/Grok_Bot_0.18.0_Setup.exe");

async function exists(target) {
  try { await stat(target); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function fileSha256(target) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(target)) hash.update(bytes);
  return hash.digest("hex");
}

export async function windowsReferenceInventory(root = windowsRuntimeRoot) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files.push({ path: path.relative(root, target).split(path.sep).join("/"), bytes: (await stat(target)).size, sha256: await fileSha256(target) });
      else throw new Error("Unexpected Windows reference filesystem entry");
    }
  }
  await walk(root);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { files, sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
}

async function verifyInstaller(target) {
  if ((await stat(target)).size !== release.installerBytes || await fileSha256(target) !== release.installerSha256) {
    throw new Error("Windows 0.18.0 installer checksum or size mismatch");
  }
}

async function downloadInstaller(target) {
  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.${randomUUID()}.partial`;
  try {
    const response = await fetch(release.installerUrl, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || response.body === null || new URL(response.url).protocol !== "https:") throw new Error(`Windows installer download failed (${response.status})`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: "wx", mode: 0o600 }));
    await verifyInstaller(partial);
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
}

export async function verifyWindowsReference(root = windowsRuntimeRoot) {
  const resources = path.join(root, "resources");
  const archive = path.join(resources, "app.asar");
  if (await fileSha256(archive) !== release.asarSha256) throw new Error("Windows upstream ASAR checksum mismatch");
  const metadata = JSON.parse(extractFile(archive, "package.json"));
  if (metadata.version !== "0.18.0" || metadata.main !== "dist/electron-main/main.cjs") throw new Error("Unexpected Windows upstream package metadata");
  const inventory = await windowsReferenceInventory(root);
  if (inventory.sha256 !== release.referenceInventorySha256) throw new Error("Windows upstream complete file inventory mismatch");
  const nativeFiles = inventory.files.filter(file => file.path.startsWith("resources/app.asar.unpacked/")).length;
  if (nativeFiles === 0) throw new Error("Windows native payload is absent");
  await stat(path.join(`${archive}.unpacked`, "dist/native/sand-webauthn-signer.exe"));
  return { platform: release.platform, root, resources, archive, sourceRoot: release.sourceRoot, nativeFiles, asarSha256: release.asarSha256 };
}

export async function ensureWindowsRuntime({ installer = process.env.GROK_BOT_WINDOWS_INSTALLER?.trim() || windowsInstallerPath } = {}) {
  if (!await exists(installer)) {
    if (path.resolve(installer) !== windowsInstallerPath) throw new Error(`Configured Windows installer is missing: ${installer}`);
    await downloadInstaller(installer);
  }
  await verifyInstaller(installer);
  if (!await exists(path.join(windowsRuntimeRoot, "resources/app.asar"))) {
    const temporary = `${windowsRuntimeRoot}.${randomUUID()}`;
    await mkdir(temporary, { recursive: true });
    try {
      if (process.platform !== "win32") await chmod(sevenZip.path7za, 0o755);
      await run(sevenZip.path7za, ["x", "-y", `-o${temporary}`, path.resolve(installer)]);
      await verifyWindowsReference(temporary);
      await rm(windowsRuntimeRoot, { recursive: true, force: true });
      await rename(temporary, windowsRuntimeRoot);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const reference = await verifyWindowsReference();
  // 每次从已校验归档重新提取，构建不使用可变缓存作为身份来源。
  await rm(release.sourceRoot, { recursive: true, force: true });
  extractAll(reference.archive, release.sourceRoot);
  for (const required of ["dist/renderer/index.html", "dist/electron-main/main.cjs", "dist/host/host-main.cjs"]) await stat(path.join(release.sourceRoot, required));
  return reference;
}
