import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPackage } from "@electron/asar";

import { applyOriginalRendererRouterPatch } from "../scripts/lib/router-renderer-patch.mjs";
import { verifyChecksumPinnedRendererPackage } from "../scripts/lib/macos-package-verification.mjs";
import { officialMacReleaseAsarHash } from "../scripts/lib/macos-shell-invariant.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sha256 = value => createHash("sha256").update(value).digest("hex");

test("Command Code renderer extension preserves the original renderer hash chain", async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const workspace = await mkdtemp(path.join(root, ".cache/command-code-renderer-"));
  try {
    const stageRoot = path.join(workspace, "stage");
    const assets = path.join(stageRoot, "dist/renderer/assets");
    const sourceRendererRoot = path.join(workspace, "source-renderer");
    await mkdir(assets, { recursive: true });
    await writeFile(path.join(assets, "registry.js"), 'const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"usage",label:"Usage & Billing",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}]');
    await writeFile(path.join(assets, "panel.js"), 'function Sa(s){}Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):null;Z=x==="usage"?a.jsx(Te,{children:a.jsx(Na,{})}):null');
    await writeFile(path.join(assets, "entry.js"), 'function A_n(n){switch(n.kind){case"message":return n.content;case"send-message":return n.message.type==="text"?n.message.content:"";case"notice":return n.text;default:return""}}function Fpt(n){const e=[];for(const t of n.matchAll(I_n)){');
    await cp(path.join(stageRoot, "dist/renderer"), sourceRendererRoot, { recursive: true });
    const files = ["assets/entry.js", "assets/panel.js", "assets/registry.js"];
    const records = [];
    for (const relative of files) {
      const contents = await readFile(path.join(sourceRendererRoot, relative));
      records.push({ path: relative, bytes: contents.byteLength, sha256: sha256(contents) });
    }
    const provenancePath = path.join(stageRoot, "dist/renderer-artifact-provenance.json");
    await writeFile(provenancePath, JSON.stringify({ mode: "checksum-pinned-artifact-runtime", hashAlgorithm: "sha256", files: records, fileCount: records.length, inventorySha256: sha256(JSON.stringify(records)), upstreamAppAsarSha256: officialMacReleaseAsarHash }));
    await writeFile(path.join(stageRoot, "dist/reconstruction-build.json"), JSON.stringify({ runtimeComposition: [{ runtime: "renderer", mode: "checksum-pinned-artifact-runtime", provenance: "dist/renderer-artifact-provenance.json" }] }));
    const extension = await applyOriginalRendererRouterPatch({ stageRoot });
    assert.deepEqual(extension.chunks.map(chunk => chunk.role), ["registry", "panel", "entry-text-extractor"]);
    assert.ok(extension.features.includes("settings-command-code-model"));
    const panel = await readFile(path.join(assets, "panel.js"), "utf8");
    assert.match(panel, /COMMAND_CODE_API_KEY/);
    assert.match(panel, /getCommandCodeModels/);
    assert.match(panel, /setCommandCodeModel/);
    const archivePath = path.join(workspace, "app.asar");
    await createPackage(stageRoot, archivePath);
    const verified = await verifyChecksumPinnedRendererPackage({ archivePath, sourceRendererRoot });
    assert.equal(verified.extension.chunks.length, 3);
    const damage = JSON.parse(await readFile(provenancePath, "utf8"));
    damage.files[0].sha256 = "0".repeat(64);
    await writeFile(provenancePath, JSON.stringify(damage));
    await createPackage(stageRoot, archivePath);
    await assert.rejects(verifyChecksumPinnedRendererPackage({ archivePath, sourceRendererRoot }), /Shipped renderer source drift/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
