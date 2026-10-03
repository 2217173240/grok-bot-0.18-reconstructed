import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { extractFile, listPackage, statFile } from "@electron/asar";
import { upstreamPlatform } from "./upstream-platforms.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function walkFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, target));
    else if (entry.isFile()) files.push(path.relative(root, target).split(path.sep).join("/"));
  }
  return files.sort();
}

function assertSafeRelative(relative) {
  if (typeof relative !== "string" || !relative || path.posix.isAbsolute(relative) || relative.split("/").some(part => part === ".." || part === "")) {
    throw new Error(`Runtime manifest contains an unsafe relative path: ${JSON.stringify(relative)}`);
  }
}

export async function verifyChecksumPinnedRendererPackage({
  archivePath, sourceRendererRoot, officialArchivePath, platform = "darwin-arm64",
  provenancePath = "dist/renderer-artifact-provenance.json",
  buildManifestPath = "dist/reconstruction-build.json",
  rendererExtensionPath = "dist/renderer-router-extension.json",
} = {}) {
  if ([archivePath, sourceRendererRoot].some(value => typeof value !== "string" || !value)) throw new TypeError("Explicit archivePath and sourceRendererRoot paths are required");
  const upstream = upstreamPlatform(platform);
  const buildManifest = JSON.parse(extractFile(archivePath, path.normalize(buildManifestPath)).toString("utf8"));
  const renderer = buildManifest.runtimeComposition?.find(runtime => runtime.runtime === "renderer");
  if (renderer?.mode !== "checksum-pinned-artifact-runtime" || renderer.provenance !== provenancePath) throw new Error(`Fidelity renderer has an invalid runtime classification: ${renderer?.mode}`);
  const provenanceBytes = extractFile(archivePath, path.normalize(provenancePath));
  const provenance = JSON.parse(provenanceBytes.toString("utf8"));
  if (provenance.mode !== renderer.mode || provenance.hashAlgorithm !== "sha256" || !Array.isArray(provenance.files)) throw new Error("Fidelity renderer provenance contract is invalid");
  if (provenance.upstreamAppAsarSha256 !== upstream.asarSha256) throw new Error(`Fidelity renderer provenance is not bound to the canonical shipped ${platform} ASAR`);
  const expectedFiles = new Map();
  for (const record of provenance.files) {
    assertSafeRelative(record.path);
    if (expectedFiles.has(record.path) || typeof record.bytes !== "number" || !/^[0-9a-f]{64}$/.test(record.sha256)) throw new Error(`Invalid renderer provenance entry: ${JSON.stringify(record)}`);
    const source = await readFile(path.join(sourceRendererRoot, record.path));
    if (source.byteLength !== record.bytes || sha256(source) !== record.sha256) throw new Error(`Shipped renderer source drift at ${record.path}`);
    expectedFiles.set(record.path, record);
  }
  if (JSON.stringify(await walkFiles(sourceRendererRoot)) !== JSON.stringify([...expectedFiles.keys()])) throw new Error("Shipped renderer source inventory differs from embedded provenance");
  if (provenance.fileCount !== expectedFiles.size || provenance.inventorySha256 !== sha256(JSON.stringify([...expectedFiles.values()]))) throw new Error("Fidelity renderer aggregate inventory hash is invalid");
  if (officialArchivePath != null) {
    if (sha256(await readFile(officialArchivePath)) !== upstream.asarSha256) throw new Error(`Renderer verification received a non-canonical official ${platform} ASAR`);
    const officialFiles = [];
    for (const raw of listPackage(officialArchivePath)) {
      const relative = raw.replace(/^[/\\]+/, "").split("\\").join("/");
      const archiveRendererRoot = "dist/renderer";
      if (!relative.startsWith(`${archiveRendererRoot}/`)) continue;
      try { if (typeof statFile(officialArchivePath, path.normalize(relative)).size === "number") officialFiles.push(relative.slice(`${archiveRendererRoot}/`.length)); } catch {}
    }
    officialFiles.sort();
    if (JSON.stringify(officialFiles) !== JSON.stringify([...expectedFiles.keys()])) throw new Error(`Renderer provenance inventory differs from the canonical shipped ${platform} ASAR`);
    for (const [relative, expected] of expectedFiles) {
      const official = extractFile(officialArchivePath, path.join("dist/renderer", relative));
      if (official.byteLength !== expected.bytes || sha256(official) !== expected.sha256) throw new Error(`Renderer provenance differs from canonical shipped ${platform} ASAR at ${relative}`);
    }
  }
  let extension = null;
  try {
    const bytes = extractFile(archivePath, path.normalize(rendererExtensionPath)); const parsed = JSON.parse(bytes.toString("utf8"));
    if (parsed?.schemaVersion !== 1 || parsed?.mode !== "original-renderer-settings-extension" || !Array.isArray(parsed.chunks)) throw new Error("Renderer extension provenance contract is invalid");
    const chunks = new Map(); const roles = [];
    for (const row of parsed.chunks) {
      const relative = typeof row?.path === "string" && row.path.startsWith("dist/renderer/") ? row.path.slice("dist/renderer/".length) : null;
      if (relative == null || !expectedFiles.has(relative) || !["registry", "panel", "entry-text-extractor"].includes(row.role) || !Number.isInteger(row.original?.bytes) || !/^[0-9a-f]{64}$/.test(row.original?.sha256) || !Number.isInteger(row.patched?.bytes) || !/^[0-9a-f]{64}$/.test(row.patched?.sha256)) throw new Error("Renderer extension chunk provenance is invalid");
      const expected = chunks.get(relative)?.patched ?? expectedFiles.get(relative);
      if (row.original.bytes !== expected.bytes || row.original.sha256 !== expected.sha256) throw new Error(`Renderer extension source identity drift at ${relative}`);
      chunks.set(relative, row); roles.push(row.role);
    }
    if (JSON.stringify(roles) !== JSON.stringify(["registry", "panel", "entry-text-extractor"]) || chunks.size < 2 || chunks.size > 3 || parsed.chunks[1].path === parsed.chunks[0].path) throw new Error("Renderer extension chunk sequence is invalid");
    extension = { bytes, parsed, chunks };
  } catch (error) { if (!(error instanceof Error) || !/not found in archive|Cannot find/.test(error.message)) throw error; }
  const packagedFiles = [];
  for (const raw of listPackage(archivePath)) {
    const relative = raw.replace(/^[/\\]+/, "").split("\\").join("/"); if (!relative.startsWith("dist/renderer/")) continue;
    try { if (typeof statFile(archivePath, path.normalize(relative)).size === "number") packagedFiles.push(relative.slice("dist/renderer/".length)); } catch {}
  }
  packagedFiles.sort(); if (JSON.stringify(packagedFiles) !== JSON.stringify([...expectedFiles.keys()])) throw new Error("Packaged renderer file inventory differs from the exact shipped renderer");
  for (const [relative, expected] of expectedFiles) { const packaged = extractFile(archivePath, path.join("dist/renderer", relative)); const wanted = extension?.chunks.get(relative)?.patched ?? expected; if (packaged.byteLength !== wanted.bytes || sha256(packaged) !== wanted.sha256) throw new Error(`Packaged renderer drift at ${relative}`); }
  return { mode: renderer.mode, platform, provenancePath, provenanceSha256: sha256(provenanceBytes), fileCount: expectedFiles.size, inventorySha256: provenance.inventorySha256, upstreamAppAsarSha256: provenance.upstreamAppAsarSha256, ...(extension == null ? {} : { extension: { path: rendererExtensionPath, sha256: sha256(extension.bytes), chunks: extension.parsed.chunks } }) };
}
