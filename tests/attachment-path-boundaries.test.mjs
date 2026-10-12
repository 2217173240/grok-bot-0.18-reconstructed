import assert from "node:assert/strict";
import { build } from "esbuild";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH2kAAAAASUVORK5CYII=", "base64");

function mp4Box(tag, body) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(tag, 4, "ascii");
  return Buffer.concat([header, body]);
}
const trackHeader = Buffer.alloc(84);
trackHeader.writeUInt32BE(640 << 16, 76);
trackHeader.writeUInt32BE(360 << 16, 80);
const mp4 = mp4Box("moov", mp4Box("trak", mp4Box("tkhd", trackHeader)));

// Real files and symlinks exercise the public service entry points. No fs mocks.
test("attachment storage boundaries reject pre-existing symlink escapes", async (t) => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const dir = await mkdtemp(path.join(root, ".cache", "attachment-boundaries-"));
  const oldRoot = process.env.SAND_DATA_ROOT;
  const sandRoot = path.join(dir, "data");
  const agentDir = path.join(sandRoot, "agents", "test-agent");
  const attachments = path.join(agentDir, "attachments");
  const assets = path.join(agentDir, "assets");
  const outside = path.join(dir, "data-neighbor");
  process.env.SAND_DATA_ROOT = sandRoot;
  try {
    await Promise.all([attachments, assets, outside].map((directory) => mkdir(directory, { recursive: true })));
    const outfile = path.join(dir, "attachments.mjs");
    await build({
      stdin: {
        contents: 'export * from "./source/host/extensions/attachments/attachments-service.ts"; export * from "./source/host/extensions/attachments/box-staging.ts"; export * from "./source/host/extensions/attachments/attachment-file.ts";',
        resolveDir: root,
      },
      bundle: true, platform: "node", format: "esm", packages: "external", outfile, logLevel: "silent",
    });
    const service = await import(pathToFileURL(outfile).href);
    for (const directory of [attachments, assets, outside]) {
      await writeFile(path.join(directory, "image.png"), png);
      await writeFile(path.join(directory, "video.mp4"), mp4);
      await writeFile(path.join(directory, "notes.txt"), "attachment text");
    }
    // Directory links and direct file links cover both ways to cross the boundary.
    await symlink(outside, path.join(attachments, "escape"), "junction");
    await symlink(path.join(outside, "image.png"), path.join(attachments, "escape.png"), "file");
    await symlink(path.join(attachments, "image.png"), path.join(attachments, "alias.png"), "file");
    await symlink(attachments, path.join(attachments, "inside"), "junction");

    await t.test("image, video, text, and chunk reads reject escapes and adjacent prefixes", async () => {
      for (const directory of [outside, path.join(attachments, "escape")]) {
        assert.equal(await service.readHostAttachmentImage(path.join(directory, "image.png")), null);
        assert.equal(await service.readHostAttachmentVideoBytes(path.join(directory, "video.mp4")), null);
        assert.equal(await service.readMediaDimensions(path.join(directory, "image.png")), null);
        assert.equal(await service.readVideoDimensions(path.join(directory, "video.mp4")), null);
        assert.equal(await service.readAttachmentText(agentDir, path.join(directory, "notes.txt")), null);
        assert.equal(await service.readHostAttachmentChunk(agentDir, path.join(directory, "notes.txt"), 0, 32), null);
        assert.equal(await service.readHostAttachmentChunk(agentDir, path.join(directory, "video.mp4"), 0, 32, true), null);
      }
      assert.equal(await service.readHostAttachmentImage(path.join(attachments, "escape.png")), null);
      const sibling = path.join(agentDir, "attachments-neighbor");
      await mkdir(sibling);
      await writeFile(path.join(sibling, "notes.txt"), "sibling");
      assert.equal(await service.readAttachmentText(agentDir, path.join(sibling, "notes.txt")), null);
      assert.equal(await service.readHostAttachmentChunk(agentDir, path.join(sibling, "notes.txt"), 0, 32), null);
    });

    await t.test("ordinary files and symlinks within the allowed roots remain readable", async () => {
      for (const directory of [attachments, path.join(attachments, "inside")]) {
        assert.equal((await service.readHostAttachmentImage(path.join(directory, "image.png"))).dataUrl, `data:image/png;base64,${png.toString("base64")}`);
        assert.deepEqual(await service.readMediaDimensions(path.join(directory, "image.png")), { width: 1, height: 1 });
        assert.deepEqual(Buffer.from(await service.readHostAttachmentVideoBytes(path.join(directory, "video.mp4"))), mp4);
        assert.deepEqual(await service.readVideoDimensions(path.join(directory, "video.mp4")), { width: 640, height: 360 });
        assert.deepEqual(await service.readMediaDimensions(path.join(directory, "video.mp4")), { width: 640, height: 360 });
        assert.equal((await service.readAttachmentText(agentDir, path.join(directory, "notes.txt"))).text, "attachment text");
        assert.equal(Buffer.from((await service.readHostAttachmentChunk(agentDir, path.join(directory, "notes.txt"), 0, 10)).bytesBase64, "base64").toString(), "attachment");
      }
      assert.ok(await service.readHostAttachmentImage(path.join(attachments, "alias.png")));
      assert.ok(await service.readHostAttachmentChunk(agentDir, path.join(assets, "notes.txt"), 0, 10));
    });

    await t.test("open descriptor binds metadata and bytes despite pathname replacement or growth", async () => {
      const changing = path.join(attachments, "changing.txt");
      await writeFile(changing, "original");
      const data = await service.withAttachmentFile(changing, [attachments], async (handle, info) => {
        await rename(changing, `${changing}.old`);
        await writeFile(changing, "replacement");
        await appendFile(`${changing}.old`, "-appended-after-stat");
        return service.readAttachmentBytes(handle, info.size, 8);
      });
      assert.equal(data.toString(), "original");
      assert.equal(await readFile(changing, "utf8"), "replacement");
      assert.equal(await service.withAttachmentFile(changing, [attachments], (handle, info) => service.readAttachmentBytes(handle, info.size, 8)), null);
    });

    await t.test("POSIX open refuses a final symlink inserted after canonical resolution", { skip: process.platform === "win32" }, async () => {
      const target = path.join(attachments, "replace-before-open.txt");
      await writeFile(target, "inside");
      const canonical = await service.resolveAttachmentFile(target, [attachments]);
      await rm(target);
      await symlink(path.join(outside, "notes.txt"), target, "file");
      await assert.rejects(service.openCanonicalAttachmentFile(canonical), { code: "ELOOP" });
    });

    await t.test("canonical configured roots and a missing optional assets root remain supported", async () => {
      const aliasRoot = path.join(dir, "aliased-agent");
      await symlink(agentDir, aliasRoot, "junction");
      assert.ok(await service.readHostAttachmentChunk(aliasRoot, path.join(aliasRoot, "attachments", "notes.txt"), 0, 10));
      await rename(assets, `${assets}-absent`);
      try { assert.ok(await service.readHostAttachmentChunk(agentDir, path.join(attachments, "notes.txt"), 0, 10)); }
      finally { await rename(`${assets}-absent`, assets); }
    });

    await t.test("size limits reject oversized files and cap text/chunk reads", async () => {
      const oversizedVideo = path.join(attachments, "oversized.mp4");
      await writeFile(oversizedVideo, "");
      await truncate(oversizedVideo, 200 * 1024 * 1024 + 1);
      assert.equal(await service.readHostAttachmentVideoBytes(oversizedVideo), null);
      const largeText = path.join(attachments, "large.txt");
      await writeFile(largeText, Buffer.alloc(service.ATTACHMENT_TEXT_PREVIEW_BYTE_CAP + 1, 65));
      const preview = await service.readAttachmentText(agentDir, largeText);
      assert.equal(preview.text.length, service.ATTACHMENT_TEXT_PREVIEW_BYTE_CAP);
      assert.equal(preview.truncated, true);
      await truncate(largeText, service.ATTACHMENT_CHUNK_MAX_BYTES + 1);
      const chunk = await service.readHostAttachmentChunk(agentDir, largeText, 0, Number.MAX_SAFE_INTEGER);
      assert.equal(Buffer.from(chunk.bytesBase64, "base64").length, service.ATTACHMENT_CHUNK_MAX_BYTES);
      assert.equal(await service.readAttachmentText(agentDir, attachments), null);
    });

    await t.test("explicit ingestion still copies external sources into storage", async () => {
      const result = await service.ingestAttachment(agentDir, path.join(outside, "notes.txt"));
      assert.equal(path.dirname(result.absolutePath), attachments);
      assert.equal(await readFile(result.absolutePath, "utf8"), "attachment text");
      const linked = await service.ingestAttachment(agentDir, path.join(attachments, "escape", "notes.txt"));
      assert.equal(linked.absolutePath, result.absolutePath);
      assert.notEqual(linked.hash, "preserved");
    });

    await t.test("box staging reads only contained files before transfer", async () => {
      const uploadedDir = path.join(dir, "uploaded");
      await mkdir(uploadedDir);
      const direct = path.join(attachments, "image.png");
      const alias = path.join(attachments, "alias.png");
      const escaped = path.join(attachments, "escape.png");
      const escapedDirectory = path.join(attachments, "escape", "notes.txt");
      const external = path.join(outside, "notes.txt");
      const oversized = path.join(attachments, "oversized-stage.bin");
      await writeFile(oversized, "");
      await truncate(oversized, service.SAND_BOX_STAGE_MAX_BYTES + 1);
      // Transfer through a filesystem-backed adapter so accepted bytes are checked
      // at the receiving side; the storage reads themselves run unmodified.
      const staged = await service.stageAttachmentsIntoBox({
        ctx: uploadedDir,
        box: { async runState() { return "running"; } },
        resolveOwnerDir: service.resolveAttachmentOwnerDir,
        async upload(destination, _box, _agentId, files) {
          for (const file of files) await writeFile(path.join(destination, path.basename(file.boxPath)), file.data);
        },
      }, "test-agent", [direct, alias, escaped, escapedDirectory, external, oversized]);
      assert.deepEqual([...staged.keys()], [direct, alias]);
      assert.deepEqual(await readFile(path.join(uploadedDir, "image.png")), png);
      assert.deepEqual(await readFile(path.join(uploadedDir, "alias.png")), png);
      await assert.rejects(readFile(path.join(uploadedDir, "escape.png")), { code: "ENOENT" });
    });
  } finally {
    if (oldRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = oldRoot;
    await rm(dir, { recursive: true, force: true });
  }
});
