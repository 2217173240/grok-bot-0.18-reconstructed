import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  // .cache is gitignored; it exists on dev machines but not on a fresh CI checkout.
  await mkdir(path.join(repoRoot, ".cache"), { recursive: true });
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

test("local admin intercept blocks Cursor production fetches and records them", async () => {
  const loaded = await loadModule("source/shared/node/local-admin-intercept.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-intercept-"));
  const previous = process.env.SAND_LOCAL_ADMIN;
  const previousRoot = process.env.SAND_DATA_ROOT;
  const originalFetch = globalThis.fetch;
  process.env.SAND_LOCAL_ADMIN = "1";
  process.env.SAND_DATA_ROOT = root;
  try {
    loaded.module.installLocalAdminNetworkIntercept(process.env);
    await assert.rejects(() => fetch("https://api2.cursor.sh/aiserver.v1.PrivacyService/GetPrivacyMode"), /blocked fetch/);
    const log = await readFile(path.join(root, "local-intercept.jsonl"), "utf8");
    assert.match(log, /blocked-fetch/);
    assert.match(log, /api2\.cursor\.sh/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous == null) delete process.env.SAND_LOCAL_ADMIN;
    else process.env.SAND_LOCAL_ADMIN = previous;
    if (previousRoot == null) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousRoot;
    await loaded.dispose();
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

async function loopbackPortBusy(port) {
  const net = await import("node:net");
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

test("local admin host failure carries the child exit code and output tail", async (t) => {
  if (await loopbackPortBusy(1340)) return t.skip("port 1340 is already bound");
  const loaded = await loadModule("source/electron-main/box/local-admin-host.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-local-host-fail-"));
  try {
    const hostScript = path.join(root, "host-fail.cjs");
    await writeFile(hostScript, 'console.log("BOOT_LINE"); console.error("ERR_LINE"); process.exit(7);\n');
    const settingsPath = path.join(root, "settings.json");
    await writeFile(settingsPath, "{}\n");
    await assert.rejects(
      () => loaded.module.ensureLocalAdminHost({
        settingsPath,
        hostMainPath: hostScript,
        token: "t".repeat(40),
        execPath: process.execPath,
        env: { SAND_DATA_ROOT: root },
        deps: {},
      }),
      (error) => {
        assert.match(error.message, /exited before the gateway was ready \(code 7\)/);
        assert.match(error.message, /BOOT_LINE/);
        assert.match(error.message, /ERR_LINE/);
        assert.match(error.message, new RegExp(root.replaceAll("/", "\\/")));
        return true;
      },
    );
  } finally {
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("local admin host resolves when the gateway answers and passes deps + inert backend env", async (t) => {
  if (await loopbackPortBusy(1340)) return t.skip("port 1340 is already bound");
  const loaded = await loadModule("source/electron-main/box/local-admin-host.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-local-host-ready-"));
  try {
    const hostScript = path.join(root, "host-gateway.cjs");
    await writeFile(hostScript, [
      'const http = require("node:http");',
      'const server = http.createServer((req, res) => {',
      '  if (req.url === "/health" && req.headers.authorization === "Bearer " + process.env.SAND_GATEWAY_TOKEN) { res.writeHead(200); res.end("ok"); }',
      '  else { res.writeHead(401); res.end(); }',
      "});",
      'server.listen(1340, "127.0.0.1", () => {',
      '  console.log("FAKE_GATEWAY_READY nodePath=" + (process.env.NODE_PATH || "") + " ts=" + (process.env.SAND_TREE_SITTER_NODE_DEPS || "") + " backend=" + (process.env.SAND_BACKEND_URL || ""));',
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const settingsPath = path.join(root, "settings.json");
    await writeFile(settingsPath, "{}\n");
    const token = "ready".padEnd(40, "x");
    const connection = await loaded.module.ensureLocalAdminHost({
      settingsPath,
      hostMainPath: hostScript,
      token,
      execPath: process.execPath,
      env: { SAND_DATA_ROOT: root },
      deps: { nodePath: "/fake/deps:/fake/node-deps", treeSitterDeps: "/fake/deps" },
    });
    assert.equal(connection.baseUrl, "http://127.0.0.1:1340");
    assert.equal(connection.token, token);
    loaded.module.stopLocalAdminHost();
    const log = await readFile(path.join(root, "box-logs", "sand-host.log"), "utf8");
    assert.match(log, /FAKE_GATEWAY_READY nodePath=\/fake\/deps:\/fake\/node-deps ts=\/fake\/deps backend=http:\/\/127\.0\.0\.1:9/);
  } finally {
    loaded?.module?.stopLocalAdminHost?.();
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("local host connector opens a breaker after repeated failures and resets on recreate", async () => {
  const connectorLoaded = await loadModule("source/electron-main/box/local-docker-host-connector.ts");
  const settingsLoaded = await loadModule("source/shared/node/settings/sand-settings-store.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-local-breaker-"));
  const previous = process.env.SAND_LOCAL_ADMIN;
  process.env.SAND_LOCAL_ADMIN = "1";
  try {
    const settingsPath = path.join(root, "settings.json");
    await writeFile(settingsPath, `${JSON.stringify({ version: 1, mcpBoxServers: [], autoUpdateWhenIdleOptIn: false, egressTunnelEnabled: false, webauthnProxyEnabled: true, mcpCustomInstructions: {}, mcpCustomInstructionsByServerId: {}, mcpDisabledToolsByServerId: {}, conciergeConsent: "unset", settingsMigrations: [] })}\n`);
    const connector = connectorLoaded.module.createSettingsRoutedHostConnector(
      { connect: async () => { throw new Error("no remote in local admin"); } },
      new settingsLoaded.module.SandSettingsStore(settingsPath),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(() => connector.connect(), /reconstructed runtime is unavailable/);
    }
    await assert.rejects(() => connector.connect(), /circuit breaker is open after 3 consecutive failures/);
    await assert.rejects(() => connector.recreate({}), /reconstructed runtime is unavailable/);
    await assert.rejects(() => connector.connect(), /reconstructed runtime is unavailable/);
  } finally {
    if (previous == null) delete process.env.SAND_LOCAL_ADMIN;
    else process.env.SAND_LOCAL_ADMIN = previous;
    await connectorLoaded.dispose();
    await settingsLoaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("local admin never queries the Cursor privacy mode backend", async () => {
  const loaded = await loadModule("source/shared/node/cursor-backend/cursor-inference.ts");
  const previous = process.env.SAND_LOCAL_ADMIN;
  process.env.SAND_LOCAL_ADMIN = "1";
  try {
    const result = await loaded.module.resolveCachedSandPrivacyMode(
      { backendUrl: "https://api2.cursor.sh", accessToken: "token", machineId: "machine" },
      async () => { throw new Error("must not look up privacy mode in local admin"); },
    );
    assert.equal(result, undefined);
  } finally {
    if (previous == null) delete process.env.SAND_LOCAL_ADMIN;
    else process.env.SAND_LOCAL_ADMIN = previous;
    await loaded.dispose();
  }
});

test("claude tool permission allows everything in local admin and read-only outside", async () => {
  const loaded = await loadModule("source/host/extensions/inference/provider-session.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-tool-policy-"));
  const previousAdmin = process.env.SAND_LOCAL_ADMIN;
  const previousRoot = process.env.SAND_DATA_ROOT;
  process.env.SAND_DATA_ROOT = root;
  try {
    process.env.SAND_LOCAL_ADMIN = "1";
    const allowed = loaded.module.claudeToolPermission("Bash");
    assert.equal(allowed.behavior, "allow");
    const readAllowed = loaded.module.claudeToolPermission("Read");
    assert.equal(readAllowed.behavior, "allow");

    delete process.env.SAND_LOCAL_ADMIN;
    const readStill = loaded.module.claudeToolPermission("Read");
    assert.equal(readStill.behavior, "allow");
    const bashDenied = loaded.module.claudeToolPermission("Bash");
    assert.equal(bashDenied.behavior, "deny");
    assert.match(bashDenied.message, /SAND_LOCAL_ADMIN=1/);
    const writeDenied = loaded.module.claudeToolPermission("Write");
    assert.equal(writeDenied.behavior, "deny");

    const interceptLog = path.join(root, "local-intercept.jsonl");
    const log = await readFile(interceptLog, "utf8");
    assert.match(log, /permission-denied/);
    assert.match(log, /"tool":"Bash"/);
  } finally {
    if (previousAdmin == null) delete process.env.SAND_LOCAL_ADMIN;
    else process.env.SAND_LOCAL_ADMIN = previousAdmin;
    if (previousRoot == null) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousRoot;
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("agent workspace prefers the shared box workspace over the data root", async () => {
  const loaded = await loadModule("source/host/extensions/inference/provider-session.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-workspace-"));
  const previousRoot = process.env.SAND_DATA_ROOT;
  const previousWorkspace = process.env.SAND_AGENT_WORKSPACE;
  try {
    process.env.SAND_DATA_ROOT = root;
    delete process.env.SAND_AGENT_WORKSPACE;
    assert.equal(loaded.module.resolveAgentWorkspace(), root, "falls back to the data root when no workspace exists");

    const workspace = path.join(root, "box-data", "box-workspace");
    await mkdir(workspace, { recursive: true });
    assert.equal(loaded.module.resolveAgentWorkspace(), workspace, "prefers box-data/box-workspace");

    process.env.SAND_AGENT_WORKSPACE = path.join(root, "override");
    assert.equal(loaded.module.resolveAgentWorkspace(), path.join(root, "override"), "honours the env override");
  } finally {
    if (previousRoot == null) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousRoot;
    if (previousWorkspace == null) delete process.env.SAND_AGENT_WORKSPACE;
    else process.env.SAND_AGENT_WORKSPACE = previousWorkspace;
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("orphaned box-exec-daemon port is reaped; foreign owners are refused", async () => {
  const loaded = await loadModule("source/electron-main/box/local-admin-host.ts");
  const terminated = [];
  const deps = (command) => ({
    listPortOwner: async () => 4242,
    readCommand: async () => command,
    terminate: async (pid) => { terminated.push(pid); },
  });
  try {
    const freed = await loaded.module.healOrphanedBoxExecDaemon(1337, {
      listPortOwner: async () => undefined,
      readCommand: async () => { throw new Error("must not read"); },
      terminate: async () => { throw new Error("must not terminate"); },
    });
    assert.equal(freed, "free");

    const reaped = await loaded.module.healOrphanedBoxExecDaemon(1337, deps("/Applications/Grok Bot.app/.../box-exec-daemon/main.cjs"));
    assert.equal(reaped, "reaped-orphan");
    assert.deepEqual(terminated, [4242]);

    await assert.rejects(
      () => loaded.module.healOrphanedBoxExecDaemon(1337, deps("/usr/local/bin/nginx -p 80")),
      /not a Grok Bot box-exec-daemon/,
    );
    assert.equal(terminated.length, 1, "foreign owner is never terminated");
  } finally {
    await loaded.dispose();
  }
});

test("local mcp-servers.json parses the standard mcpServers shape", async () => {
  const loaded = await loadModule("source/shared/node/mcp/local-mcp-servers.ts");
  try {
    const { parseLocalMcpServersConfig } = loaded.module;
    const wrapped = parseLocalMcpServersConfig(JSON.stringify({
      mcpServers: {
        demo: { command: "node", args: ["server.cjs"], env: { KEY: "value" } },
        remote: { url: "https://example.com/mcp" },
        broken: { neither: true },
        "": { command: "x" },
      },
    }));
    assert.deepEqual(Object.keys(wrapped.mcpServers), ["demo", "remote"]);
    assert.deepEqual(wrapped.mcpServers.demo, { command: "node", args: ["server.cjs"], env: { KEY: "value" } });

    const flat = parseLocalMcpServersConfig(JSON.stringify({ echo: { command: "/usr/local/bin/echo-mcp" } }));
    assert.deepEqual(flat.mcpServers, { echo: { command: "/usr/local/bin/echo-mcp" } });

    assert.throws(() => parseLocalMcpServersConfig("{not json"), /not valid JSON/);
    assert.throws(() => parseLocalMcpServersConfig("[1,2]"), /must contain an object/);
  } finally {
    await loaded.dispose();
  }
});

test("local admin swaps MCP provider sources; the file writer round-trips configs", async () => {
  const loaded = await loadModule("source/shared/node/mcp/local-mcp-servers.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-local-mcp-writer-"));
  const previousAdmin = process.env.SAND_LOCAL_ADMIN;
  const previousRoot = process.env.SAND_DATA_ROOT;
  try {
    const dashboardProvider = async () => { throw new Error("must not read the dashboard in local admin"); };
    process.env.SAND_LOCAL_ADMIN = "1";
    process.env.SAND_DATA_ROOT = root;
    await writeFile(path.join(root, "mcp-servers.json"), JSON.stringify({ mcpServers: { demo: { command: "node" } } }));

    const swapped = loaded.module.applyLocalAdminMcpSources({ accountServersProvider: dashboardProvider });
    assert.equal(swapped.accountServersProvider, undefined);
    assert.deepEqual(await swapped.accountConfigProvider(), { mcpServers: { demo: { command: "node" } } });

    delete process.env.SAND_LOCAL_ADMIN;
    const untouched = loaded.module.applyLocalAdminMcpSources({ accountServersProvider: dashboardProvider });
    assert.equal(untouched.accountServersProvider, dashboardProvider, "non-admin sources pass through untouched");

    const writer = loaded.module.createLocalMcpServersFileWriter(root);
    const edited = await writer.getConfigForEdit();
    assert.deepEqual(edited.config.mcpServers, { demo: { command: "node" } });
    await writer.setConfig({ mcpServers: { demo: { command: "node" }, extra: { command: "/bin/extra", args: ["-v"] } } });
    const reread = await writer.getConfigForEdit();
    assert.deepEqual(Object.keys(reread.config.mcpServers), ["demo", "extra"]);
    await assert.rejects(() => writer.installPlugin({ pluginId: 1n }), /Marketplace plugins need a Cursor account/);
  } finally {
    if (previousAdmin == null) delete process.env.SAND_LOCAL_ADMIN;
    else process.env.SAND_LOCAL_ADMIN = previousAdmin;
    if (previousRoot == null) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousRoot;
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop MCP IPC answers marketplace questions locally in local admin", async () => {
  const loaded = await loadModule("source/electron-main/mcp/mcp-desktop.ts");
  const previousAdmin = process.env.SAND_LOCAL_ADMIN;
  const handlers = new Map();
  const ipc = { handle: (channel, handler) => handlers.set(channel, handler) };
  let managerCalls = 0;
  const deps = () => ({
    ipc,
    shell: { openExternal: async () => {} },
    parseAllowedExternalUrl: () => null,
    createOAuthLoopback: async () => ({ registerPendingAuthFromUrl: async () => {}, dispose: () => {} }),
    getManager: async () => { managerCalls += 1; return {
      listServers: async () => [],
      listEffectivePlugins: async () => { throw new Error("dashboard"); },
      getCatalog: async () => { throw new Error("dashboard"); },
      resolvePluginLogo: async () => null,
    }; },
    peekAccessToken: async () => "token",
    fetchTeamPopularity: async () => { throw new Error("dashboard"); },
    refreshMcp: async () => {},
    syncHostSettings: async () => null,
    settings: { getMcpCustomInstructionsAccountScope: () => null, getMcpCustomInstructionsByServerId: () => ({}), getMcpCustomInstructions: () => ({}), getMcpDisabledToolsByServerId: () => ({}) },
    wait: async () => {},
    onEdgeFailure: () => {},
  });
  try {
    process.env.SAND_LOCAL_ADMIN = "1";
    loaded.module.registerMcpDesktopIpc(deps());
    assert.deepEqual(await handlers.get("sand:mcp-catalog")({}, undefined), []);
    assert.deepEqual(await handlers.get("sand:mcp-effective-plugins")({}, undefined), []);
    assert.deepEqual(await handlers.get("sand:mcp-team-popularity")({}, undefined), {});
    assert.equal(managerCalls, 0, "marketplace handlers never reach the manager in local admin");

    delete process.env.SAND_LOCAL_ADMIN;
    handlers.clear();
    loaded.module.registerMcpDesktopIpc(deps());
    await assert.rejects(() => handlers.get("sand:mcp-catalog")({}, undefined), /dashboard/);
    assert.ok(managerCalls >= 1, "non-admin still consults the manager");
  } finally {
    if (previousAdmin == null) delete process.env.SAND_LOCAL_ADMIN;
    else process.env.SAND_LOCAL_ADMIN = previousAdmin;
    await loaded.dispose();
  }
});

test("intercept ledger samples heartbeats and rotates when it outgrows the cap", async () => {
  const loaded = await loadModule("source/shared/node/local-admin-intercept.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-intercept-rotate-"));
  const previousRoot = process.env.SAND_DATA_ROOT;
  process.env.SAND_DATA_ROOT = root;
  const ledger = path.join(root, "local-intercept.jsonl");
  try {
    loaded.module.appendLocalIntercept({ kind: "local-host", event: "already-ready", logPath: "/x" });
    loaded.module.appendLocalIntercept({ kind: "local-host", event: "already-ready", logPath: "/x" });
    let lines = (await readFile(ledger, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1, "heartbeat within the window is sampled to one line");

    const pad = "A".repeat(8_000);
    for (let index = 0; index < 300; index += 1) {
      loaded.module.appendLocalIntercept({ kind: "blocked-fetch", url: "https://api2.cursor.sh/x", sequence: index, pad });
    }
    const rotated = await readFile(ledger, "utf8");
    assert.ok(rotated.length < 1_000_000, `ledger rotated below cap (got ${rotated.length} bytes)`);
    const kept = rotated.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(kept.length > 1 && kept.length < 300, "rotation kept a tail, not everything");
    const last = kept[kept.length - 1];
    assert.equal(last.sequence, 299, "the newest record survives rotation");
    assert.equal(last.kind, "blocked-fetch");
  } finally {
    if (previousRoot == null) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousRoot;
    await loaded.dispose();
    await rm(root, { recursive: true, force: true });
  }
});






