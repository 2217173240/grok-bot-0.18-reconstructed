import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("desktop attachment staging writes real image bytes with distinct file names", async () => {
  const scratch = path.join(root, ".cache");
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(path.join(scratch, "attachment-stage-"));
  try {
    const outfile = path.join(dir, "attachments.mjs");
    await build({
      entryPoints: [path.join(root, "source/electron-main/attachments/attachments.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      outfile,
      logLevel: "silent",
    });
    const { writeStagedAttachment } = await import(pathToFileURL(outfile).href);
    const bytes = await readFile(path.join(root, "docs/assets/router-settings.png"));
    const first = await writeStagedAttachment(path.join(dir, "staging"), "router-settings.png", bytes);
    const second = await writeStagedAttachment(path.join(dir, "staging"), "router-settings.png", bytes);
    assert.notEqual(first, second);
    assert.ok(first.endsWith(".png"));
    assert.deepEqual(await readFile(first), bytes);
    assert.deepEqual(await readFile(second), bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
