import assert from "node:assert/strict";
import { closeSync, fstatSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
await mkdir(join(repositoryRoot, ".cache"), { recursive: true });
const root = await mkdtemp(join(repositoryRoot, ".cache/codex-credential-file-"));
after(() => rm(root, { recursive: true, force: true }));
await build({
  entryPoints: ["codex-credentials-file", "inference-router-local"].map(name => join(repositoryRoot, `source/shared/node/${name}.ts`)),
  outdir: root, outExtension: { ".js": ".mjs" }, bundle: true,
  platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { openCodexCredentialsFile } = await import(pathToFileURL(join(root, "codex-credentials-file.mjs")).href);
const { getLocalInferenceCliStatus } = await import(pathToFileURL(join(root, "inference-router-local.mjs")).href);
const privateFileOptions = { skip: process.platform === "win32" ? "Windows chmod cannot express the existing owner-only mode requirement" : false };
const validLogin = JSON.stringify({ auth_mode: "chatgpt", tokens: {
  access_token: "test-access", refresh_token: "test-refresh", id_token: "test-id", account_id: "test-account",
} });

test("private credentials are read using the validated descriptor", privateFileOptions, async () => {
  const file = join(root, "private.json");
  await writeFile(file, validLogin, { mode: 0o600 });
  const fd = openCodexCredentialsFile(file);
  try {
    assert.equal(fstatSync(fd).mode & 0o077, 0);
    assert.equal(readFileSync(fd, "utf8"), validLogin);
  } finally { closeSync(fd); }
});

test("an opened credential retains its identity when its path is replaced", privateFileOptions, async () => {
  const file = join(root, "identity.json");
  const replacement = join(root, "replacement.json");
  await writeFile(file, validLogin, { mode: 0o600 });
  await writeFile(replacement, "replacement", { mode: 0o600 });
  const fd = openCodexCredentialsFile(file);
  try {
    const identity = fstatSync(fd).ino;
    await rename(replacement, file);
    assert.equal(readFileSync(file, "utf8"), "replacement");
    assert.equal(fstatSync(fd).ino, identity);
    assert.equal(readFileSync(fd, "utf8"), validLogin);
  } finally { closeSync(fd); }
});

test("credentials reject group or other access", privateFileOptions, async () => {
  const file = join(root, "public.json");
  await writeFile(file, validLogin, { mode: 0o600 });
  for (const mode of [0o640, 0o604, 0o666]) {
    await chmod(file, mode);
    assert.throws(() => openCodexCredentialsFile(file), /private direct regular file/);
  }
});

test("credentials reject a directory and retain missing-file errors", async () => {
  const directory = join(root, "directory.json");
  await mkdir(directory, { mode: 0o700 });
  assert.throws(() => openCodexCredentialsFile(directory), /private direct regular file/);
  assert.throws(() => openCodexCredentialsFile(join(root, "absent.json")), { code: "ENOENT" });
});

test("credentials reject symlinks to private files", async t => {
  const target = join(root, "target.json");
  const link = join(root, "link.json");
  await writeFile(target, validLogin, { mode: 0o600 });
  try { await symlink(target, link, "file"); }
  catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") return t.skip("Windows requires symlink creation privileges");
    throw error;
  }
  assert.throws(() => openCodexCredentialsFile(link), /private direct regular file/);
});

test("local status preserves login format and privacy checks", privateFileOptions, async () => {
  const home = join(root, "home");
  await mkdir(home);
  const path = join(home, "auth.json");
  const previousHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = home;
    await writeFile(path, validLogin, { mode: 0o600 });
    assert.equal(getLocalInferenceCliStatus().codex.authenticated, true);
    await chmod(path, 0o644);
    assert.equal(getLocalInferenceCliStatus().codex.authenticated, false);
    await chmod(path, 0o600);
    for (const document of ["{", "null", "{}", JSON.stringify({ auth_mode: "api_key", tokens: {} })]) {
      await writeFile(path, document);
      assert.equal(getLocalInferenceCliStatus().codex.authenticated, false);
    }
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
});
