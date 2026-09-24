import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The secrets store loads "electron" at runtime. Each bundle gets its own
// directory with a stand-in module whose safeStorage behaves like an unlocked
// Keychain, so the Keychain-mode paths run against real files.
const FAKE_ELECTRON = `
const prefix = "fake-keychain:";
module.exports = {
  app: { isPackaged: true, getPath: () => __dirname },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(prefix + value, "utf8"),
    decryptString: (buffer) => {
      const text = buffer.toString("utf8");
      if (!text.startsWith(prefix)) throw new Error("not encrypted by this keychain");
      return text.slice(prefix.length);
    },
    getSelectedStorageBackend: () => "keychain",
    setUsePlainTextEncryption: () => {},
  },
};
`;

async function loadModule(entry) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-secrets-restart-"));
  await mkdir(path.join(directory, "node_modules", "electron"), { recursive: true });
  await writeFile(path.join(directory, "node_modules", "electron", "index.js"), FAKE_ELECTRON);
  const output = path.join(directory, `${path.basename(entry, ".ts")}.cjs`);
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    external: ["electron"],
    logLevel: "error",
  });
  const module = createRequire(output)(output);
  return { module, directory, dispose: () => rm(directory, { recursive: true, force: true }) };
}

const encrypted = (value) => Buffer.from(`fake-keychain:${value}`, "utf8").toString("base64");

function withoutLocalAdmin(run) {
  return async () => {
    const saved = process.env.SAND_LOCAL_ADMIN;
    delete process.env.SAND_LOCAL_ADMIN;
    try { await run(); } finally { if (saved === undefined) delete process.env.SAND_LOCAL_ADMIN; else process.env.SAND_LOCAL_ADMIN = saved; }
  };
}

const DAMAGED_USER_SECRETS = {
  "v2 secret that is not a string": { version: 2, accounts: { "account-a": { EXAMPLE_KEY: 42 } } },
  "v2 secret next to a valid one": { version: 2, accounts: { "account-a": { GOOD_KEY: encrypted("good"), EXAMPLE_KEY: 42 } } },
  "v2 account that is an array": { version: 2, accounts: { "account-a": [encrypted("value")] } },
  "v2 account that is null": { version: 2, accounts: { "account-a": null } },
  "v2 account that is a string": { version: 2, accounts: { "account-a": "oops" } },
  "v2 damaged second account": { version: 2, accounts: { "account-a": { GOOD_KEY: encrypted("good") }, "account-b": { EXAMPLE_KEY: false } } },
  "v2 accounts that is not an object": { version: 2, accounts: ["account-a"] },
  "v1 secret that is not a string": { version: 1, secrets: { EXAMPLE_KEY: { nested: true } } },
  "unknown version": { version: 3, accounts: {} },
  "non-object root": ["version", 2],
};

for (const [name, content] of Object.entries(DAMAGED_USER_SECRETS)) {
  test(`damaged user-secrets.json (${name}) is never exported as a complete set or overwritten`, withoutLocalAdmin(async () => {
    const loaded = await loadModule("source/electron-main/secrets/user-secrets-store.ts");
    try {
      const storePath = path.join(loaded.directory, "user-secrets.json");
      const original = `${JSON.stringify(content, null, 2)}\n`;
      await writeFile(storePath, original, { mode: 0o600 });
      const store = new loaded.module.SandUserSecretsStore(storePath, () => "account-a");
      const snapshot = await store.exportSnapshot();
      assert.equal(snapshot.complete, false);
      await assert.rejects(() => store.upsert({ NEW_KEY: "new" }), loaded.module.SandUserSecretsUnreadableError);
      await store.remove(["GOOD_KEY"]).catch((error) => assert.ok(error instanceof loaded.module.SandUserSecretsUnreadableError));
      assert.equal(await readFile(storePath, "utf8"), original);
    } finally {
      await loaded.dispose();
    }
  }));
}

test("user-secrets.json that is not valid JSON is left byte-for-byte", withoutLocalAdmin(async () => {
  const loaded = await loadModule("source/electron-main/secrets/user-secrets-store.ts");
  try {
    const storePath = path.join(loaded.directory, "user-secrets.json");
    const original = '{"version":2,"accounts":{"account-a":{"KEY":"trunc';
    await writeFile(storePath, original, { mode: 0o600 });
    const store = new loaded.module.SandUserSecretsStore(storePath, () => "account-a");
    assert.equal((await store.exportSnapshot()).complete, false);
    await assert.rejects(() => store.upsert({ NEW_KEY: "new" }), loaded.module.SandUserSecretsUnreadableError);
    assert.equal(await readFile(storePath, "utf8"), original);
  } finally {
    await loaded.dispose();
  }
}));

test("user-secrets.json that cannot be read keeps its bytes and mode", { skip: process.getuid?.() === 0 }, withoutLocalAdmin(async () => {
  const loaded = await loadModule("source/electron-main/secrets/user-secrets-store.ts");
  const storePath = path.join(loaded.directory, "user-secrets.json");
  try {
    const original = `${JSON.stringify({ version: 2, accounts: { "account-a": { KEY: encrypted("value") } } })}\n`;
    await writeFile(storePath, original, { mode: 0o600 });
    await chmod(storePath, 0o000);
    const store = new loaded.module.SandUserSecretsStore(storePath, () => "account-a");
    assert.equal((await store.exportSnapshot()).complete, false);
    await assert.rejects(() => store.upsert({ NEW_KEY: "new" }), loaded.module.SandUserSecretsUnreadableError);
    assert.equal((await stat(storePath)).mode & 0o777, 0o000);
    await chmod(storePath, 0o600);
    assert.equal(await readFile(storePath, "utf8"), original);
  } finally {
    await chmod(storePath, 0o600).catch(() => {});
    await loaded.dispose();
  }
}));

test("a missing user-secrets.json is a complete empty set and the first save creates it", withoutLocalAdmin(async () => {
  const loaded = await loadModule("source/electron-main/secrets/user-secrets-store.ts");
  try {
    const storePath = path.join(loaded.directory, "user-secrets.json");
    const store = new loaded.module.SandUserSecretsStore(storePath, () => "account-a");
    assert.deepEqual(await store.exportSnapshot(), { accountScope: "account-a", secrets: {}, complete: true, removed: [] });
    await store.upsert({ NEW_KEY: "new" });
    const saved = JSON.parse(await readFile(storePath, "utf8"));
    assert.deepEqual(Object.keys(saved.accounts["account-a"]), ["NEW_KEY"]);
    assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  } finally {
    await loaded.dispose();
  }
}));

test("valid v1 and v2 files still load, export and save", withoutLocalAdmin(async () => {
  const loaded = await loadModule("source/electron-main/secrets/user-secrets-store.ts");
  try {
    const v2Path = path.join(loaded.directory, "v2.json");
    await writeFile(v2Path, JSON.stringify({ version: 2, accounts: { "account-a": { KEY_A: encrypted("a") }, "account-b": {} } }));
    const v2 = new loaded.module.SandUserSecretsStore(v2Path, () => "account-a");
    assert.deepEqual(await v2.exportSnapshot(), { accountScope: "account-a", secrets: { KEY_A: "a" }, complete: true, removed: [] });
    await v2.upsert({ KEY_B: "b" });
    assert.deepEqual((await v2.exportSnapshot()).secrets, { KEY_A: "a", KEY_B: "b" });
    const reread = JSON.parse(await readFile(v2Path, "utf8"));
    assert.deepEqual(Object.keys(reread.accounts["account-a"]).sort(), ["KEY_A", "KEY_B"]);
    assert.deepEqual(reread.accounts["account-b"], {});

    const v1Path = path.join(loaded.directory, "v1.json");
    await writeFile(v1Path, JSON.stringify({ version: 1, secrets: { LEGACY_KEY: encrypted("legacy") } }));
    const v1 = new loaded.module.SandUserSecretsStore(v1Path, () => "account-a");
    assert.deepEqual(await v1.exportSnapshot(), { accountScope: "account-a", secrets: { LEGACY_KEY: "legacy" }, complete: true, removed: [] });
  } finally {
    await loaded.dispose();
  }
}));

// Host side: a new BoxSecretsApplier on the same file is what a box restart
// looks like. Merges must build on the saved file, never replace it blindly.
async function createApplier(loaded, storePath) {
  const scheduling = loaded.module.__scheduling;
  const applied = [];
  const applier = new loaded.module.BoxSecretsApplier({
    applyToBox: async (_ctx, update) => { applied.push(update); },
    retryPolicy: scheduling.createRetryPolicy(scheduling.realClock, { name: "test-apply", maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 }),
    applyDeadline: scheduling.createDeadlinePolicy(scheduling.realClock, { name: "test-save", timeoutMs: 1_000 }),
    storePath,
    log: () => {},
  });
  return { applier, applied };
}

async function loadHost() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-box-secrets-host-"));
  const entry = path.join(directory, "entry.ts");
  await writeFile(entry, [
    `export { BoxSecretsApplier, SandBoxSecretsUnreadableError } from ${JSON.stringify(path.join(repoRoot, "source/host/extensions/secrets/secrets-service.ts"))};`,
    `export * as __scheduling from ${JSON.stringify(path.join(repoRoot, "source/internal/scheduling.ts"))};`,
  ].join("\n"));
  const output = path.join(directory, "host.cjs");
  await build({ entryPoints: [entry], outfile: output, bundle: true, format: "cjs", platform: "node", target: "node22", logLevel: "error" });
  return { module: createRequire(output)(output), directory, dispose: () => rm(directory, { recursive: true, force: true }) };
}

const readSecrets = async (storePath) => JSON.parse(await readFile(storePath, "utf8")).secrets;

test("after a box restart, merged additions and removals build on the saved file", async () => {
  const loaded = await loadHost();
  try {
    const storePath = path.join(loaded.directory, "box-secrets.json");
    await writeFile(storePath, `${JSON.stringify({ version: 1, secrets: { SAVED_KEY: "saved", OTHER_KEY: "other" } })}\n`, { mode: 0o600 });

    const first = await createApplier(loaded, storePath);
    await first.applier.mergeSecrets({}, { NEW_KEY: "new" }, []);
    assert.deepEqual(await readSecrets(storePath), { SAVED_KEY: "saved", OTHER_KEY: "other", NEW_KEY: "new" });
    assert.equal((await stat(storePath)).mode & 0o777, 0o600);
    first.applier.stop();

    const second = await createApplier(loaded, storePath);
    await second.applier.mergeSecrets({}, {}, ["SAVED_KEY"]);
    assert.deepEqual(await readSecrets(storePath), { OTHER_KEY: "other", NEW_KEY: "new" });
    assert.deepEqual(second.applier.getStatus().keys, ["NEW_KEY", "OTHER_KEY"]);
    second.applier.stop();
  } finally {
    await loaded.dispose();
  }
});

test("after a box restart, a merge with no saved file creates it", async () => {
  const loaded = await loadHost();
  try {
    const storePath = path.join(loaded.directory, "box-secrets.json");
    const { applier } = await createApplier(loaded, storePath);
    await applier.mergeSecrets({}, { NEW_KEY: "new" }, ["NOT_THERE"]);
    assert.deepEqual(await readSecrets(storePath), { NEW_KEY: "new" });
    applier.stop();
  } finally {
    await loaded.dispose();
  }
});

for (const [name, original] of Object.entries({
  "invalid JSON": '{"version":1,"secrets":{"SAVED_KEY":"sav',
  "a secret that is not a string": `${JSON.stringify({ version: 1, secrets: { SAVED_KEY: 42 } })}\n`,
  "an unknown version": `${JSON.stringify({ version: 2, secrets: {} })}\n`,
})) {
  test(`after a box restart, a merge refuses to overwrite a box-secrets.json with ${name}`, async () => {
    const loaded = await loadHost();
    try {
      const storePath = path.join(loaded.directory, "box-secrets.json");
      await writeFile(storePath, original, { mode: 0o600 });
      const { applier, applied } = await createApplier(loaded, storePath);
      await assert.rejects(() => applier.mergeSecrets({}, { NEW_KEY: "new" }, []), loaded.module.SandBoxSecretsUnreadableError);
      assert.equal(await readFile(storePath, "utf8"), original);
      assert.deepEqual(applied, []);
      applier.stop();
    } finally {
      await loaded.dispose();
    }
  });
}

test("a merge that goes over the secret limits is rejected before anything is saved", async () => {
  const loaded = await loadHost();
  try {
    const storePath = path.join(loaded.directory, "box-secrets.json");
    const original = `${JSON.stringify({ version: 1, secrets: { SAVED_KEY: "saved" } })}\n`;
    await writeFile(storePath, original, { mode: 0o600 });
    const { applier } = await createApplier(loaded, storePath);
    await assert.rejects(() => applier.mergeSecrets({}, { BIG_KEY: "x".repeat(40 * 1024) }, []));
    await assert.rejects(() => applier.mergeSecrets({}, { PATH: "/tmp" }, []));
    assert.equal(await readFile(storePath, "utf8"), original);
    applier.stop();
  } finally {
    await loaded.dispose();
  }
});

// Mac → box push: a partial Mac view sends only its edits and writes no mirror.
test("a partial Mac snapshot sends only its edits and writes no Mac mirror", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-secrets-push-"));
  const output = path.join(directory, "push.cjs");
  await build({ entryPoints: [path.join(repoRoot, "source/electron-main/secrets/secrets-ipc.ts")], outfile: output, bundle: true, format: "cjs", platform: "node", target: "node22", external: ["electron"], logLevel: "error" });
  const { createBoxSecretsPush } = createRequire(output)(output);
  try {
    const macSecretsPath = path.join(directory, "box-secrets.json");
    const requests = [];
    let snapshot = { accountScope: "account-a", secrets: {}, complete: false, removed: [] };
    const push = createBoxSecretsPush({
      userSecretsStore: { exportSnapshot: async () => snapshot },
      isAccountDeparting: () => false,
      setBoxSecrets: async (request) => { requests.push(request); return { isApplied: true }; },
      report: () => {},
      macSecretsPath,
    });
    assert.equal(await push.push("resync"), true);
    assert.deepEqual(requests, []);

    snapshot = { accountScope: "account-a", secrets: { NEW_KEY: "new" }, complete: false, removed: ["OLD_KEY"] };
    assert.equal(await push.push("edit"), true);
    assert.deepEqual(requests, [{ secrets: { NEW_KEY: "new" }, merge: true, removeKeys: ["OLD_KEY"] }]);
    await assert.rejects(() => stat(macSecretsPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
