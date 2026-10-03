import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPackageFromStreams, extractAll, extractFile, getRawHeader, statFile } from "@electron/asar";
import { NtExecutable, NtExecutableResource } from "resedit";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererPath = "dist/renderer/index.html";
const bareHtml = '<!doctype html><html><head><meta charset="UTF-8"><title>Grok Bot renderer isolation</title></head><body><div id="root"><h1>Grok Bot renderer isolation control</h1><p>Product main and preload remain active.</p><button type="button">Local control</button></div></body></html>\n';
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function archiveEntries(header, prefix = "") {
  const entries = [];
  for (const [name, entry] of Object.entries(header.files)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if ("link" in entry) throw new Error(`Renderer isolation does not support ASAR links: ${relative}`);
    if ("files" in entry) {
      entries.push({ path: relative, type: "directory", unpacked: entry.unpacked === true });
      entries.push(...archiveEntries(entry, relative));
    } else {
      assert.equal(typeof entry.size, "number", `Invalid ASAR entry: ${relative}`);
      entries.push({ path: relative, type: "file", unpacked: entry.unpacked === true, executable: entry.executable === true });
    }
  }
  return entries;
}

export async function repackRendererArchive({ originalArchive, outputArchive, extractRoot }) {
  originalArchive = path.resolve(originalArchive);
  outputArchive = path.resolve(outputArchive);
  extractRoot = path.resolve(extractRoot);
  assert.notEqual(path.resolve(originalArchive), path.resolve(outputArchive));
  const entries = archiveEntries(getRawHeader(originalArchive).header);
  assert(entries.some(entry => entry.type === "file" && entry.path === rendererPath), "Renderer index is absent from product ASAR");
  extractAll(originalArchive, extractRoot);
  await writeFile(path.join(extractRoot, rendererPath), bareHtml);
  const streams = [];
  for (const entry of entries) {
    if (entry.type === "directory") {
      streams.push({ path: entry.path, type: "directory", unpacked: entry.unpacked });
    } else {
      const source = path.join(extractRoot, entry.path);
      streams.push({ path: entry.path, type: "file", unpacked: entry.unpacked, stat: await stat(source), streamGenerator: () => createReadStream(source) });
    }
  }
  // ASAR streams 的相对路径同时用于文件哈希，工作目录必须指向提取目录。
  const previousDirectory = process.cwd();
  try {
    process.chdir(extractRoot);
    await createPackageFromStreams(outputArchive, streams);
  } finally { process.chdir(previousDirectory); }
  const actualEntries = archiveEntries(getRawHeader(outputArchive).header);
  assert.deepEqual(actualEntries, entries, "ASAR paths, types, unpack flags or executable flags changed");
  let verifiedFiles = 0;
  let verifiedUnpackedFiles = 0;
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const expected = entry.path === rendererPath ? Buffer.from(bareHtml) : extractFile(originalArchive, entry.path);
    const actual = extractFile(outputArchive, entry.path);
    assert.equal(actual.length, expected.length, `ASAR byte length changed: ${entry.path}`);
    assert.equal(sha256(actual), sha256(expected), `ASAR file content changed: ${entry.path}`);
    const metadata = statFile(outputArchive, entry.path, false);
    assert.equal(metadata.integrity.hash, sha256(expected), `ASAR integrity hash mismatch: ${entry.path}`);
    if (entry.unpacked) {
      const unpacked = await readFile(path.join(`${outputArchive}.unpacked`, entry.path));
      assert.equal(sha256(unpacked), sha256(expected), `Unpacked file content changed: ${entry.path}`);
      verifiedUnpackedFiles++;
    }
    verifiedFiles++;
  }
  return { modifiedArchiveFiles: [rendererPath], verifiedFiles, verifiedUnpackedFiles, originalAsarSha256: sha256(await readFile(originalArchive)), isolatedAsarSha256: sha256(await readFile(outputArchive)) };
}

async function refreshCopiedExecutableIntegrity(cloneExe, originalArchive, cloneArchive) {
  const executable = NtExecutable.from(await readFile(cloneExe), { ignoreCert: true });
  const resources = NtExecutableResource.from(executable);
  const entries = resources.entries.filter(entry => entry.type === "INTEGRITY" && entry.id === "ELECTRONASAR");
  assert.equal(entries.length, 1, "Expected the product executable's existing ELECTRONASAR integrity resource");
  const resource = entries[0];
  const records = JSON.parse(Buffer.from(resource.bin).toString("utf8"));
  assert(Array.isArray(records), "Invalid executable ASAR integrity records");
  const archiveRecords = records.filter(record => typeof record.file === "string" && record.file.replaceAll("\\", "/") === "resources/app.asar");
  assert.equal(archiveRecords.length, 1, "Expected one resources/app.asar integrity record");
  const originalHeaderSha256 = sha256(getRawHeader(originalArchive).headerString);
  const isolatedHeaderSha256 = sha256(getRawHeader(cloneArchive).headerString);
  assert.equal(archiveRecords[0].alg, "SHA256");
  assert.equal(archiveRecords[0].value, originalHeaderSha256, "Original executable integrity resource does not match original ASAR");
  const otherResources = resources.entries.filter(entry => entry !== resource).map(entry => ({ type: entry.type, id: entry.id, lang: entry.lang, codepage: entry.codepage, sha256: sha256(Buffer.from(entry.bin)) }));
  archiveRecords[0].value = isolatedHeaderSha256;
  const bytes = Buffer.from(JSON.stringify(records), "utf8");
  resource.bin = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  resources.outputResource(executable);
  await writeFile(cloneExe, Buffer.from(executable.generate()));
  const verified = NtExecutableResource.from(NtExecutable.from(await readFile(cloneExe))).entries;
  const updated = verified.filter(entry => entry.type === "INTEGRITY" && entry.id === "ELECTRONASAR");
  assert.equal(updated.length, 1);
  assert.deepEqual(JSON.parse(Buffer.from(updated[0].bin).toString("utf8")), records);
  assert.deepEqual(verified.filter(entry => entry !== updated[0]).map(entry => ({ type: entry.type, id: entry.id, lang: entry.lang, codepage: entry.codepage, sha256: sha256(Buffer.from(entry.bin)) })), otherResources, "Unrelated executable resources changed");
  return { resourceType: "INTEGRITY", resourceId: "ELECTRONASAR", originalHeaderSha256, isolatedHeaderSha256 };
}

export async function main(args = process.argv.slice(2)) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Renderer isolation requires Windows x64");
  if (args.length !== 2 || args[0] !== "--app-path") throw new Error("Usage: node scripts/windows-renderer-isolation.mjs --app-path <Grok Bot.exe>");
  const originalExe = path.resolve(args[1]);
  const originalArchive = path.join(path.dirname(originalExe), "resources/app.asar");
  assert((await lstat(originalExe)).isFile());
  assert((await lstat(originalArchive)).isFile());
  const originalExeHash = sha256(await readFile(originalExe));
  const originalArchiveHash = sha256(await readFile(originalArchive));
  await mkdir(path.join(repoRoot, ".cache"), { recursive: true });
  const root = await mkdtemp(path.join(repoRoot, ".cache/windows-renderer-isolation-"));
  const cloneRoot = path.join(root, "product");
  const outputArchive = path.join(root, "repacked/app.asar");
  const report = { originalExe, originalExeSha256: originalExeHash, originalAsarSha256: originalArchiveHash, success: false };
  const errors = [];
  console.log(`Renderer isolation artifacts: ${root}`);
  try {
    await cp(path.dirname(originalExe), cloneRoot, { recursive: true, dereference: false, preserveTimestamps: true });
    report.archiveVerification = await repackRendererArchive({ originalArchive, outputArchive, extractRoot: path.join(root, "extracted") });
    const cloneArchive = path.join(cloneRoot, "resources/app.asar");
    await copyFile(outputArchive, cloneArchive);
    if (report.archiveVerification.verifiedUnpackedFiles > 0) await cp(`${outputArchive}.unpacked`, `${cloneArchive}.unpacked`, { recursive: true, dereference: false, preserveTimestamps: true });
    assert.equal(sha256(await readFile(cloneArchive)), report.archiveVerification.isolatedAsarSha256);
    for (const entry of archiveEntries(getRawHeader(cloneArchive).header)) {
      if (entry.type === "file" && entry.unpacked) assert.equal(sha256(extractFile(cloneArchive, entry.path)), statFile(cloneArchive, entry.path, false).integrity.hash, `Copied unpacked file changed: ${entry.path}`);
    }
    const cloneExe = path.join(cloneRoot, path.basename(originalExe));
    report.executableMetadata = await refreshCopiedExecutableIntegrity(cloneExe, originalArchive, cloneArchive);
    const { main: productSmoke } = await import("./windows-package-smoke.mjs");
    await productSmoke(["--app-path", cloneExe]);
    report.productSmoke = "passed";
  } catch (error) {
    errors.push(error);
    report.error = error.message;
    console.error("Renderer isolation failed:", error);
  }
  try {
    assert.equal(sha256(await readFile(originalExe)), originalExeHash, "Original executable changed");
    assert.equal(sha256(await readFile(originalArchive)), originalArchiveHash, "Original ASAR changed");
    let originalUnpackedFilesVerified = 0;
    for (const entry of archiveEntries(getRawHeader(originalArchive).header)) {
      if (entry.type !== "file" || !entry.unpacked) continue;
      assert.equal(sha256(extractFile(originalArchive, entry.path)), statFile(originalArchive, entry.path, false).integrity.hash, `Original unpacked file changed: ${entry.path}`);
      originalUnpackedFilesVerified++;
    }
    report.originalUnpackedFilesVerified = originalUnpackedFilesVerified;
    report.originalUnchanged = true;
  } catch (error) {
    errors.push(error);
    report.originalVerificationError = error.message;
    console.error("Original package verification failed:", error);
  }
  report.success = errors.length === 0;
  try { await writeFile(path.join(root, "isolation-report.json"), JSON.stringify(report, null, 2)); }
  catch (error) { errors.push(error); console.error("Renderer isolation report write failed:", error); }
  if (errors.length) throw new AggregateError(errors, "Renderer isolation experiment failed");
  console.log(JSON.stringify({ success: true, artifacts: root, verifiedFiles: report.archiveVerification.verifiedFiles }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
