import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
async function fixture(t, entry) {
  const tmp = path.join(root, ".cache", "ci-tmp");
  await mkdir(tmp, { recursive: true });
  const dir = await mkdtemp(path.join(tmp, "round2-media-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, "module.mjs");
  await build({ entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
  return { dir, api: await import(pathToFileURL(outfile).href) };
}

test("avatar migration and reads enforce bounded regular files and content cache freshness", async t => {
  const { dir, api } = await fixture(t, "source/host/agents/agent-avatar.ts");
  const agent = path.join(dir, "agent"); await mkdir(agent);
  const legacy = path.join(agent, "legacy.bin"); await writeFile(legacy, png);
  assert.equal(api.resolveDerivedAvatarFilename(agent, "legacy.bin"), "avatar.png");
  assert.deepEqual(await readFile(path.join(agent, "avatar.png")), png);
  const first = await api.readAvatarWithinDir(agent, "avatar.png");
  const secondBytes = Buffer.from(png); secondBytes[8] = 2;
  await writeFile(path.join(agent, "avatar.png"), secondBytes);
  const second = await api.readAvatarWithinDir(agent, "avatar.png");
  assert.notEqual(first.version, second.version);
  assert.deepEqual((await api.readValidatedAvatar(agent, "avatar.png")).bytes, secondBytes);
  const large = path.join(agent, "large.bin"); await writeFile(large, png); await truncate(large, api.AVATAR_MAX_BYTES + 1);
  assert.equal(await api.readValidatedAvatar(agent, "large.bin"), null);
  await rm(path.join(agent, "avatar.png"));
  assert.equal(api.resolveDerivedAvatarFilename(agent, "large.bin"), null);
  assert.equal(await api.readValidatedAvatar(agent, "."), null);
  const outside = path.join(dir, "outside.png"); await writeFile(outside, png);
  assert.equal(await api.readValidatedAvatar(agent, outside), null);
  if (process.platform !== "win32") {
    await symlink(outside, path.join(agent, "escape.png"));
    assert.equal(await api.readValidatedAvatar(agent, "escape.png"), null);
  }
});

test("cloud images preserve media root and box boundaries and reject oversized host files", async t => {
  const { dir, api } = await fixture(t, "source/host/cloud-agents/cloud-agent-images.ts");
  const attachments = path.join(dir, "attachments"); await mkdir(attachments);
  const file = path.join(attachments, "image.png"); await writeFile(file, png);
  const load = urls => api.loadCloudAgentImages({ ctx: {}, agentDir: dir, urls });
  const good = await load([pathToFileURL(file).href]); assert.equal(good.ok, true); assert.deepEqual(Buffer.from(good.images[0].data), png);
  const outside = path.join(dir, "outside.png"); await writeFile(outside, png);
  assert.match((await load([pathToFileURL(outside).href])).message, /Refused/);
  if (process.platform !== "win32") {
    const link = path.join(attachments, "escape.png"); await symlink(outside, link);
    assert.match((await load([pathToFileURL(link).href])).message, /Refused/);
  }
  await truncate(file, 100 * 1024 * 1024);
  assert.equal((await load([pathToFileURL(file).href])).ok, false);
  const box = await api.loadCloudAgentImages({ ctx: {}, agentDir: dir, urls: ["file:///workspace/image.png"], readBoxFile: async () => readFile(outside) });
  assert.equal(box.ok, true);
});

test("channel local upload reads regular bounded files and retains HTTP transport", async t => {
  const { dir, api } = await fixture(t, "source/host/connectors/channel-attachment.ts");
  const file = path.join(dir, "image.png"); await writeFile(file, png);
  const good = await api.resolveChannelAttachment(pathToFileURL(file).href);
  assert.equal(good.transport, "upload"); assert.equal(good.mime, "image/png"); assert.deepEqual(Buffer.from(good.bytes), png);
  assert.equal(await api.resolveChannelAttachment(dir), null);
  await truncate(file, api.CHANNEL_ATTACHMENT_MAX_UPLOAD_BYTES + 1);
  assert.equal(await api.resolveChannelAttachment(file), null);
  await truncate(file, 0); assert.equal(await api.resolveChannelAttachment(file), null);
  assert.deepEqual(await api.resolveChannelAttachment("https://example.test/image.png"), { transport: "url", isImage: true, url: "https://example.test/image.png" });
});

test("inline image creation is exclusive, deduplicates intact bytes and never overwrites collisions", async t => {
  const { dir, api } = await fixture(t, "source/host/extensions/transcript/inline-image-materialization.ts");
  const session = { dbPath: path.join(dir, "session.sqlite") };
  const input = [{ base64: png.toString("base64"), mediaType: "image/png", alt: "preview" }];
  const first = await api.materializeInlineImages(session, input); assert.equal(first.length, 1);
  assert.deepEqual(await api.materializeInlineImages(session, input), first);
  const file = new URL(first[0].url); await writeFile(file, "collision");
  assert.deepEqual(await api.materializeInlineImages(session, input), []);
  assert.equal(await readFile(file, "utf8"), "collision");
  if (process.platform !== "win32") {
    await rm(file);
    const outside = path.join(dir, "outside.png"); await writeFile(outside, png);
    await symlink(outside, file);
    assert.deepEqual(await api.materializeInlineImages(session, input), []);
    assert.deepEqual(await readFile(outside), png);
  }
});

test("shared bounded reader keeps the opened inode after pathname replacement and caps append growth", async t => {
  const { dir, api } = await fixture(t, "source/host/extensions/attachments/attachment-file.ts");
  const file = path.join(dir, "file"); await writeFile(file, "old");
  const result = await api.withAttachmentFile(file, null, async (handle, info) => {
    await rename(file, path.join(dir, "original"));
    await writeFile(file, "replacement");
    await writeFile(path.join(dir, "original"), "old appended");
    return api.readAttachmentBytes(handle, info.size, 3);
  });
  assert.equal(result.toString(), "old");
});
