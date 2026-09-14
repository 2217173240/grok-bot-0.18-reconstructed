import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(repoRoot, ".cache", "local-admin-"));
  const output = path.join(temporary, `${path.basename(entry, ".ts")}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function memorySecrets() {
  const values = new Map();
  return {
    async readSecret(key) { return values.get(key); },
    async writeSecret(key, value) { values.set(key, value); },
    async deleteSecret(key) { values.delete(key); },
    isEncryptedStorageAvailable() { return true; },
  };
}

test("local admin is logged in without opening authenticator or refreshing Cursor", async () => {
  const loaded = await loadModule("source/electron-main/account/cursor-auth.ts");
  try {
    let opened = 0;
    let fetched = 0;
    const service = new loaded.module.SandCursorAuthService({
      env: { SAND_LOCAL_ADMIN: "1", SAND_LOCAL_ADMIN_EMAIL: "ops@local" },
      openExternal: async () => { opened += 1; },
      secrets: memorySecrets(),
      fetchOAuthToken: async () => { fetched += 1; throw new Error("must not refresh"); },
      fetchProfile: async () => { fetched += 1; throw new Error("must not fetch profile"); },
      waitForEncryptedStorage: async () => {},
    });
    const status = await service.getStatus();
    assert.equal(status.kind, "logged-in");
    assert.equal(status.authId, "local-admin");
    assert.equal(status.email, "ops@local");
    assert.equal(status.displayName, "Local admin");
    const token = await service.getValidAccessToken({ backendUrl: "https://api2.cursor.sh" });
    assert.match(token, /^eyJ/);
    const afterLogin = await service.login();
    assert.equal(afterLogin.kind, "logged-in");
    assert.equal(opened, 0);
    assert.equal(fetched, 0);
  } finally {
    await loaded.dispose();
  }
});

test("local admin forbids production Cursor RPC and remote box", async () => {
  const admin = await loadModule("source/shared/node/local-admin.ts");
  const settingsLoaded = await loadModule("source/shared/node/settings/sand-settings-store.ts");
  const broker = await loadModule("source/electron-main/box/box-host-connector.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-local-admin-settings-"));
  const previous = process.env.SAND_LOCAL_ADMIN;
  process.env.SAND_LOCAL_ADMIN = "1";
  try {
    assert.equal(admin.module.isCursorProductionBackendUrl("https://api2.cursor.sh"), true);
    assert.equal(admin.module.isCursorProductionBackendUrl("https://authenticator.cursor.sh"), true);
    assert.equal(admin.module.isCursorProductionBackendUrl("http://127.0.0.1:1340"), false);
    assert.throws(
      () => admin.module.assertLocalAdminNotProductionRpc("https://api2.cursor.sh", "EnsureSandBox"),
      /forbids EnsureSandBox/,
    );
    const settingsPath = path.join(root, "settings.json");
    await writeFile(settingsPath, `${JSON.stringify({ version: 1, mcpBoxServers: [], autoUpdateWhenIdleOptIn: false, egressTunnelEnabled: false, webauthnProxyEnabled: true, mcpCustomInstructions: {}, mcpCustomInstructionsByServerId: {}, mcpDisabledToolsByServerId: {}, conciergeConsent: "unset", settingsMigrations: [] })}\n`);
    const store = new settingsLoaded.module.SandSettingsStore(settingsPath);
    assert.equal(store.getBoxRuntime(), "local-docker");
    assert.throws(() => store.setBoxRuntime("remote"), /cannot use Cursor's remote computer/);
    const connector = new broker.module.BrokeredHostConnector({
      getAccessToken: async () => { throw new Error("must not mint a Cursor token"); },
      getMachineId: async () => "machine",
    }, {
      ensureSandBox: async () => { throw new Error("must not EnsureSandBox"); },
      recreateSandBox: async () => { throw new Error("must not recreate"); },
      forceRecreateSandBox: async () => { throw new Error("must not force recreate"); },
    });
    await assert.rejects(() => connector.connect(), /forbids EnsureSandBox/);
  } finally {
    if (previous == null) delete process.env.SAND_LOCAL_ADMIN;
    else process.env.SAND_LOCAL_ADMIN = previous;
    await admin.dispose();
    await settingsLoaded.dispose();
    await broker.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("docker CLI uses an existing Colima socket when DOCKER_HOST is unset", async () => {
  const loaded = await loadModule("source/electron-main/box/local-docker-host-connector.ts");
  try {
    const home = await mkdtemp(path.join(os.tmpdir(), "grok-colima-home-"));
    const socket = path.join(home, ".colima", "finonelib", "docker.sock");
    await mkdir(path.dirname(socket), { recursive: true });
    await writeFile(socket, "");
    const resolved = loaded.module.resolveDockerHost({}, home);
    assert.equal(resolved, `unix://${socket}`);
    const explicit = loaded.module.resolveDockerHost({ DOCKER_HOST: "unix:///tmp/explicit.sock" }, home);
    assert.equal(explicit, "unix:///tmp/explicit.sock");
    await rm(home, { recursive: true, force: true });
  } finally {
    await loaded.dispose();
  }
});


