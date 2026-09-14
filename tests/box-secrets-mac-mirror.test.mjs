import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-box-secrets-"));
  const output = path.join(temporary, `${path.basename(entry, ".ts")}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("routed host-owned turns advertise tools for one model step only", async () => {
  const loaded = await loadModule("source/shared/inference-router.ts");
  try {
    assert.equal(loaded.module.routedProviderToolSteps(false), 1);
    assert.equal(loaded.module.routedProviderToolSteps(true), 8);
  } finally {
    await loaded.dispose();
  }
});

test("Mac-side box-secrets snapshot round-trips with mode 0600", async () => {
  const loaded = await loadModule("source/shared/node/box-secrets-store.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-mac-secrets-"));
  try {
    const storePath = path.join(root, "box-secrets.json");
    await loaded.module.persistBoxSecretsSnapshot(storePath, { OPENROUTER_API_KEY: "or-test-key" });
    const parsed = loaded.module.parseBoxSecretsSnapshot(JSON.parse(await readFile(storePath, "utf8")));
    assert.deepEqual(parsed, { OPENROUTER_API_KEY: "or-test-key" });
    assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  } finally {
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("successful box secret push mirrors the snapshot onto the Mac sand root", async () => {
  const loaded = await loadModule("source/electron-main/secrets/secrets-ipc.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-mac-mirror-"));
  try {
    const macSecretsPath = path.join(root, "box-secrets.json");
    const reports = [];
    const boxSnapshots = [];
    const push = loaded.module.createBoxSecretsPush({
      userSecretsStore: {
        async exportSnapshot() {
          return { accountScope: "acct", secrets: { OPENROUTER_API_KEY: "or-live-key" } };
        },
      },
      isAccountDeparting: () => false,
      setBoxSecrets: async (request) => {
        const mirrored = JSON.parse(await readFile(macSecretsPath, "utf8"));
        assert.deepEqual(mirrored, { version: 1, secrets: { OPENROUTER_API_KEY: "or-live-key" } });
        boxSnapshots.push(request.secrets);
        return { isApplied: true };
      },
      report: (report) => reports.push(report),
      macSecretsPath,
    });
    assert.equal(await push.push("edit"), true);
    assert.deepEqual(boxSnapshots, [{ OPENROUTER_API_KEY: "or-live-key" }]);
    assert.equal(reports[0]?.outcome, "ok");
    const mirrored = JSON.parse(await readFile(macSecretsPath, "utf8"));
    assert.deepEqual(mirrored, { version: 1, secrets: { OPENROUTER_API_KEY: "or-live-key" } });
  } finally {
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed box secret push still writes a Mac-side snapshot", async () => {
  const loaded = await loadModule("source/electron-main/secrets/secrets-ipc.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-mac-mirror-fail-"));
  try {
    const macSecretsPath = path.join(root, "box-secrets.json");
    const push = loaded.module.createBoxSecretsPush({
      userSecretsStore: {
        async exportSnapshot() {
          return { accountScope: "acct", secrets: { OPENROUTER_API_KEY: "or-live-key" } };
        },
      },
      isAccountDeparting: () => false,
      setBoxSecrets: async () => {
        throw new Error("host unreachable");
      },
      report: () => {},
      macSecretsPath,
    });
    assert.equal(await push.push("edit"), false);
    const mirrored = JSON.parse(await readFile(macSecretsPath, "utf8"));
    assert.deepEqual(mirrored, { version: 1, secrets: { OPENROUTER_API_KEY: "or-live-key" } });
  } finally {
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("empty box secret snapshot persists an empty Mac-side object", async () => {
  const loaded = await loadModule("source/electron-main/secrets/secrets-ipc.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-mac-mirror-empty-"));
  try {
    const macSecretsPath = path.join(root, "box-secrets.json");
    const push = loaded.module.createBoxSecretsPush({
      userSecretsStore: {
        async exportSnapshot() {
          return { accountScope: "acct", secrets: {} };
        },
      },
      isAccountDeparting: () => false,
      setBoxSecrets: async () => ({ isApplied: true }),
      report: () => {},
      macSecretsPath,
    });
    assert.equal(await push.push("edit"), true);
    assert.deepEqual(JSON.parse(await readFile(macSecretsPath, "utf8")), { version: 1, secrets: {} });
  } finally {
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mac persist failure does not push a disagreeing box snapshot", async () => {
  const loaded = await loadModule("source/electron-main/secrets/secrets-ipc.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-mac-mirror-persist-fail-"));
  try {
    const blockedParent = path.join(root, "not-a-directory");
    await writeFile(blockedParent, "file");
    const macSecretsPath = path.join(blockedParent, "box-secrets.json");
    let boxCalled = false;
    const reports = [];
    const push = loaded.module.createBoxSecretsPush({
      userSecretsStore: {
        async exportSnapshot() {
          return { accountScope: "acct", secrets: { OPENROUTER_API_KEY: "or-live-key" } };
        },
      },
      isAccountDeparting: () => false,
      setBoxSecrets: async () => {
        boxCalled = true;
        return { isApplied: true };
      },
      report: (report) => reports.push(report),
      macSecretsPath,
    });
    assert.equal(await push.push("edit"), false);
    assert.equal(boxCalled, false);
    assert.equal(reports[0]?.errorClass, "other");
  } finally {
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("persistBoxSecretsSnapshot unlinks the tmp file if the atomic replace fails", async () => {
  const loaded = await loadModule("source/shared/node/box-secrets-store.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-mac-secrets-tmp-"));
  try {
    const storePath = path.join(root, "box-secrets.json");
    await mkdir(storePath);
    await assert.rejects(() => loaded.module.persistBoxSecretsSnapshot(storePath, { OPENROUTER_API_KEY: "or-test-key" }));
    const leftovers = await readdir(root);
    assert.deepEqual(leftovers.filter((name) => name.includes(".tmp")), []);
  } finally {
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
