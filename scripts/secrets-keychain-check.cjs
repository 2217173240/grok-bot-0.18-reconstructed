const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const root = path.resolve(__dirname, "..");

async function electronCheck(phase, directory) {
  const { app, safeStorage } = require("electron");
  assert.equal(process.versions.electron, require(path.join(root, "package.json")).devDependencies.electron);
  app.setName("Sand disposable secrets validation");
  app.setPath("userData", path.join(directory, "user-data"));
  app.setPath("sessionData", path.join(directory, "session-data"));
  await app.whenReady();
  try {
    assert.equal(safeStorage.isEncryptionAvailable(), true, "OS secure storage unavailable");
    const { SandUserSecretsStore, SandUserSecretsUnreadableError } = require(path.join(directory, "store.cjs"));
    const storePath = path.join(directory, "user-secrets.json");
    const values = JSON.parse(await fs.readFile(path.join(directory, "disposable-values.json"), "utf8"));
    const store = new SandUserSecretsStore(storePath, () => "disposable-account");
    if (phase === "save") {
      assert.deepEqual((await store.exportSnapshot()).secrets, {});
      await store.upsert(values);
      const saved = await fs.readFile(storePath, "utf8");
      for (const value of Object.values(values)) assert.equal(saved.includes(value), false);
      assert.equal((await fs.stat(storePath)).mode & 0o777, 0o600);
    } else {
      assert.deepEqual((await store.exportSnapshot()).secrets, values);
      assert.deepEqual(await store.listKeys(), Object.keys(values).sort());
      assert.equal(await store.reveal("DISPOSABLE_KEY"), values.DISPOSABLE_KEY);
      const legacyPath = path.join(directory, "legacy.json");
      await fs.writeFile(legacyPath, JSON.stringify({ version: 1, secrets: { LEGACY_KEY: safeStorage.encryptString(values.DISPOSABLE_KEY).toString("base64") } }), { mode: 0o600 });
      const legacy = new SandUserSecretsStore(legacyPath, () => "disposable-account");
      assert.deepEqual((await legacy.exportSnapshot()).secrets, { LEGACY_KEY: values.DISPOSABLE_KEY });
      await store.remove(["DISPOSABLE_KEY"]);
      assert.deepEqual(await new SandUserSecretsStore(storePath, () => "disposable-account").listKeys(), ["OTHER_KEY"]);
      const damagedPath = path.join(directory, "damaged.json");
      const damaged = JSON.stringify({ version: 2, accounts: { "disposable-account": { KEY: 42 } } });
      await fs.writeFile(damagedPath, damaged, { mode: 0o600 });
      const unreadable = new SandUserSecretsStore(damagedPath, () => "disposable-account");
      await assert.rejects(() => unreadable.exportSnapshot(), SandUserSecretsUnreadableError);
      await assert.rejects(() => unreadable.upsert(values), SandUserSecretsUnreadableError);
      assert.equal(await fs.readFile(damagedPath, "utf8"), damaged);
    }
    console.log(JSON.stringify({ result: "pass", phase, electron: process.versions.electron, platform: process.platform }));
  } finally { app.quit(); }
}

async function main() {
  if (process.versions.electron) return electronCheck(process.argv[2], process.argv[3]);
  assert.equal(process.platform, "darwin", "This check requires macOS Keychain");
  const { build } = require("esbuild");
  const electronExecutable = process.env.SAND_TEST_ELECTRON_PATH || require("electron");
  await fs.access(electronExecutable);
  await fs.mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, ".cache/secrets-keychain-"));
  try {
    await fs.mkdir(path.join(directory, "user-data"));
    await fs.mkdir(path.join(directory, "session-data"));
    await fs.writeFile(path.join(directory, "disposable-values.json"), JSON.stringify({ DISPOSABLE_KEY: randomUUID(), OTHER_KEY: randomUUID() }), { mode: 0o600 });
    await build({ entryPoints: [path.join(root, "source/electron-main/secrets/user-secrets-store.ts")], outfile: path.join(directory, "store.cjs"), bundle: true, format: "cjs", platform: "node", external: ["electron"], logLevel: "error" });
    const env = { ...process.env, TMPDIR: directory };
    delete env.SAND_LOCAL_ADMIN;
    delete env.ELECTRON_RUN_AS_NODE;
    for (const phase of ["save", "restart"]) {
      const { stdout } = await promisify(execFile)(electronExecutable, [__filename, phase, directory], { env, timeout: 60_000 });
      process.stdout.write(stdout);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

main().catch((error) => {
  console.error(JSON.stringify({ result: "failed", errorClass: error.name, code: error.code ?? null }));
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
