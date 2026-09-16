import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("docker CLI uses an existing Colima socket when DOCKER_HOST is unset", async () => {
  const loaded = await loadModule("source/electron-main/box/local-docker-host-connector.ts");
  try {
    const home = await mkdtemp(path.join(os.tmpdir(), "grok-colima-home-"));
    const socket = path.join(home, ".colima", "finonelib", "docker.sock");
    await mkdir(path.dirname(socket), { recursive: true });
    await writeFile(socket, "");
    // CI runners ship /var/run/docker.sock; the default socket wins by
    // precedence and Colima discovery is the fallback.
    const resolved = loaded.module.resolveDockerHost({}, home);
    if (existsSync("/var/run/docker.sock")) assert.equal(resolved, "unix:///var/run/docker.sock");
    else assert.equal(resolved, `unix://${socket}`);
    const explicit = loaded.module.resolveDockerHost({ DOCKER_HOST: "unix:///tmp/explicit.sock" }, home);
    assert.equal(explicit, "unix:///tmp/explicit.sock");
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

test("docker image selection annotates the QEMU fallback instead of hiding it", async () => {
  const loaded = await loadModule("source/electron-main/box/local-docker-host-connector.ts");
  try {
    const { decideDockerImage, officialImageQemuFallbackRecord, SELF_BUILT_EXEC_BOX_IMAGE, LOCAL_DOCKER_BOX_IMAGE, SAND_LOCAL_ADMIN_IMAGE_ENV } = loaded.module;
    const pin = "a".repeat(64);
    // An explicit pin wins whatever it points at and is never annotated.
    const explicit = decideDockerImage({ [SAND_LOCAL_ADMIN_IMAGE_ENV]: "my-image:dev" }, { present: false, depsPin: undefined }, pin);
    assert.equal(explicit.selection, "explicit");
    assert.equal(explicit.image, "my-image:dev");
    assert.equal(officialImageQemuFallbackRecord(explicit), undefined);
    // Self-built image present with a matching pin (or no expectation) → the
    // native image, no annotation.
    for (const expectation of [pin, undefined]) {
      const native = decideDockerImage({}, { present: true, depsPin: pin }, expectation);
      assert.equal(native.selection, "self-built");
      assert.equal(native.image, SELF_BUILT_EXEC_BOX_IMAGE);
      assert.equal(officialImageQemuFallbackRecord(native), undefined);
    }
    // Default path with the image missing → the official image MUST carry an
    // annotation record: the fallback stays available, it just stops being
    // silent. Reachability, not an error string.
    const fallback = decideDockerImage({}, { present: false, depsPin: undefined }, pin);
    assert.equal(fallback.selection, "official-fallback");
    assert.equal(fallback.image, LOCAL_DOCKER_BOX_IMAGE);
    const record = officialImageQemuFallbackRecord(fallback);
    assert.notEqual(record, undefined, "a default-path QEMU fallback must map to an intercept record");
    assert.equal(record.event, "official-image-qemu-fallback");
    assert.equal(record.image, LOCAL_DOCKER_BOX_IMAGE);
    assert.match(String(record.hint), /build-arm64-box\.sh/);
    // The ordering trap: stale is NOT missing. A present image whose pin
    // disagrees (including unlabelled pre-pin images) must select the stale
    // error — it must never fall through to the QEMU fallback, which would
    // trade an actionable rebuild hint for a silent downgrade.
    for (const imagePin of ["b".repeat(64), undefined]) {
      const stale = decideDockerImage({}, { present: true, depsPin: imagePin }, pin);
      assert.equal(stale.selection, "self-built-stale", `image pin ${imagePin ?? "(unlabelled)"} with expectation must be stale, never a fallback`);
      assert.equal(stale.imageDepsPin, imagePin);
      assert.equal(stale.expectedDepsPin, pin);
      assert.equal(officialImageQemuFallbackRecord(stale), undefined, "stale is an error to surface, not a fallback to annotate");
    }
  } finally {
    await loaded.dispose();
  }
});

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
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the computer plan converges every file surface on one bind-mounted workspace", async () => {
  const loaded = await loadModule("source/electron-main/box/local-docker-host-connector.ts");
  try {
    const base = {
      hostMainPath: "/staged/sand-host/host-main.cjs",
      boxExecDaemonDir: "/staged/box-exec-daemon",
      token: "t".repeat(40),
      hostSha256: "a".repeat(64),
      boxExecDaemonSha256: "b".repeat(64),
    };
    const pin = "c".repeat(64);
    const cases = [
      ["custom", loaded.module.localDockerRunPlan({ ...base, image: "grok-bot-exec-box:arm64", workspaceHostPath: "/Users/me/.grokbot-local/box-workspace", depsPin: pin })],
      ["official", loaded.module.localDockerRunPlan({ ...base, workspaceHostPath: "/Users/me/.grokbot-local/box-workspace", depsPin: pin })],
    ];
    for (const [label, plan] of cases) {
      const args = plan.args.join(" ");
      // One workspace, bind-mounted from the Mac side (Finder-visible) — the
      // fallback image converges on the same contract instead of keeping a
      // second file face on a named volume.
      assert.match(args, /type=bind,src=\/Users\/me\/\.grokbot-local\/box-workspace,dst=\/workspace(?!\S)/, `${label} plan must bind-mount /workspace`);
      assert.doesNotMatch(args, /--volume [^ ]+:\/workspace/, `${label} plan must not use a workspace volume`);
      // The daemon's workspaceRoot, the agent cwd, and the Mac-side alias are
      // all pinned to the same directory — no second volume, no dual track.
      assert.ok(plan.args.includes("SAND_WORKSPACE_ROOT=/workspace"), label);
      assert.ok(plan.args.includes("SAND_AGENT_WORKSPACE=/workspace"), label);
      assert.ok(plan.args.includes("SAND_WORKSPACE_HOST=/Users/me/.grokbot-local/box-workspace"), label);
      // The expected deps pin rides along as a container label for drift.
      assert.ok(plan.args.includes(`com.grok-bot.local-vm.deps-pin=${pin}`), label);
    }
    assert.equal(cases[0][1].custom, true);
    assert.equal(cases[1][1].custom, false);
    // Desktop opt-in (B1 topology): the entrypoint becomes box-init-exec so
    // the desktop plane runs in the background and the host is the foreground
    // via exec; the mode rides as a label for drift replacement. The default
    // plan keeps the plain node entrypoint and the headless discipline.
    const desktop = loaded.module.localDockerRunPlan({ ...base, image: "grok-bot-exec-box:arm64", workspaceHostPath: "/Users/me/.grokbot-local/box-workspace", desktop: true });
    assert.ok(desktop.args.includes("/usr/local/bin/box-init-exec"));
    assert.ok(desktop.args.includes("com.grok-bot.local-vm.desktop=1"));
    // The noVNC entries publish to the Mac loopback only in desktop mode —
    // the human handover surface; the exec plan must not publish them.
    assert.ok(desktop.args.includes("127.0.0.1:6080:6080"));
    assert.ok(desktop.args.includes("127.0.0.1:6081:6081"));
    assert.equal(cases[0][1].args.includes("127.0.0.1:6080:6080"), false);
    assert.equal(cases[0][1].args.includes("/usr/local/bin/box-init-exec"), false);
    assert.ok(cases[0][1].args.includes("com.grok-bot.local-vm.desktop=0"));
    // Relaxed seccomp is desktop-only: under the default profile Chromium's
    // own sandbox cannot start (it dies instantly); relaxed, the browser
    // sandbox works and a hostile page never gets the container.
    assert.ok(desktop.args.includes("seccomp=unconfined"));
    assert.equal(cases[0][1].args.includes("seccomp=unconfined"), false);
    // Memory caps: desktop headroom for several browsers, exec stays lean.
    assert.ok(desktop.args.includes("--memory") && desktop.args.includes("4g"));
    assert.ok(cases[0][1].args.includes("--memory") && cases[0][1].args.includes("2g"));
    // The desktop plane is the default for the self-built image (dual gate
    // profiles green); SAND_LOCAL_ADMIN_DESKTOP=0 opts back to headless, and
    // the official image never gets a desktop it does not know.
    const { resolveDesktopMode, SAND_LOCAL_ADMIN_DESKTOP_ENV } = loaded.module;
    assert.equal(resolveDesktopMode({}, true), true);
    assert.equal(resolveDesktopMode({ [SAND_LOCAL_ADMIN_DESKTOP_ENV]: "1" }, true), true);
    assert.equal(resolveDesktopMode({ [SAND_LOCAL_ADMIN_DESKTOP_ENV]: "0" }, true), false);
    assert.equal(resolveDesktopMode({ [SAND_LOCAL_ADMIN_DESKTOP_ENV]: "1" }, false), false);
    // No Mac-side directory, no plan — for either image: silently falling
    // back to a named volume would reinstate the dual track the contract
    // exists to remove.
    assert.throws(() => loaded.module.localDockerRunPlan({ ...base, image: "grok-bot-exec-box:arm64" }), /requires a Mac-side workspace directory/);
    assert.throws(() => loaded.module.localDockerRunPlan(base), /requires a Mac-side workspace directory/);
  } finally {
    await loaded.dispose();
  }
});

test("the self-built deps pin is canonical, deterministic, and order-sensitive", async () => {
  const depsPinModule = await import(`${pathToFileURL(path.join(repoRoot, "scripts", "lib", "deps-pin.mjs")).href}?${Date.now()}`);
  assert.deepEqual(depsPinModule.DEPS_PIN_FILES, ["package-lock.json", "scripts/apply-third-party-patches.mjs", "docker/arm64-exec-box.Dockerfile", "docker/bin/box-init-exec", "docker/bin/xtest-input-local.py"]);
  const contents = ["alpha", "beta", "gamma"];
  assert.equal(depsPinModule.computeDepsPin(contents), depsPinModule.computeDepsPin([...contents]));
  // Concatenation order is part of the pin: reordering inputs must change it,
  // or the bash/node consumers could drift apart unnoticed.
  assert.notEqual(depsPinModule.computeDepsPin(contents), depsPinModule.computeDepsPin([contents[1], contents[0], contents[2]]));
  const fromRepo = await depsPinModule.readDepsPin(repoRoot);
  assert.match(fromRepo, /^[0-9a-f]{64}$/);
});

test("the local computer-use executor enforces desktop geometry before touching input", async () => {
  const loaded = await loadModule("source/host/box/local-computer-use.ts");
  try {
    const { localComputerUseExecutor, LOCAL_DESKTOP_GEOMETRY, localDesktopComputerUseEnabled } = loaded.module;
    // Out-of-bounds coordinates fail before any input helper runs — the
    // geometry mirror of box-common.sh SCREEN_GEOM is the boundary.
    const result = await localComputerUseExecutor.execute({}, { toolCallId: "t", actions: [{ action: { case: "mouseMove", value: { coordinate: { x: LOCAL_DESKTOP_GEOMETRY.width, y: 10 } } } }] });
    assert.equal(result.result.case, "error");
    assert.match(result.result.value.error, /out of bounds/);
    assert.match(result.result.value.error, /after 0 action/);
    // The executor only mounts under the desktop opt-in.
    assert.equal(localDesktopComputerUseEnabled({}), false);
    assert.equal(localDesktopComputerUseEnabled({ SAND_LOCAL_ADMIN_DESKTOP: "1" }), true);
  } finally {
    await loaded.dispose();
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
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("claude child env resolves the token from env or the 0600 file", async () => {
  const loaded = await loadModule("source/host/extensions/inference/provider-session.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-token-file-"));
  const previousRoot = process.env.SAND_DATA_ROOT;
  const previousAuth = process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.SAND_DATA_ROOT = root;

    const untouched = loaded.module.claudeChildEnv({ PATH: "/usr/bin" });
    assert.equal(untouched.ANTHROPIC_AUTH_TOKEN, undefined, "no token anywhere injects nothing");

    await writeFile(path.join(root, "anthropic-token"), "file-token-123");
    const fromRoot = loaded.module.claudeChildEnv({ PATH: "/usr/bin" });
    assert.equal(fromRoot.ANTHROPIC_AUTH_TOKEN, "file-token-123");
    assert.equal(fromRoot.ANTHROPIC_API_KEY, "file-token-123");

    const boxData = path.join(root, "box-data");
    await mkdir(boxData, { recursive: true });
    process.env.SAND_DATA_ROOT = boxData;
    const fromParent = loaded.module.claudeChildEnv({ PATH: "/usr/bin" });
    assert.equal(fromParent.ANTHROPIC_AUTH_TOKEN, "file-token-123", "token found beside the host sand root");

    const envWins = loaded.module.claudeChildEnv({ ANTHROPIC_AUTH_TOKEN: "env-token" });
    assert.equal(envWins.ANTHROPIC_AUTH_TOKEN, "env-token", "an existing env token wins over the file");
  } finally {
    if (previousAuth == null) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = previousAuth;
    if (previousRoot == null) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousRoot;
    await loaded.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("SAND_LOCAL_ADMIN_TURN=host bypasses the coordinator sendPrompt interception", async () => {  const loaded = await loadModule("source/node-agent-coordinator/inference-router.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-host-turn-"));
  const previousAdmin = process.env.SAND_LOCAL_ADMIN;
  const previousTurn = process.env.SAND_LOCAL_ADMIN_TURN;
  try {
    await writeFile(path.join(root, "settings.json"), JSON.stringify({ version: 1, mcpBoxServers: [], autoUpdateWhenIdleOptIn: false, egressTunnelEnabled: false, webauthnProxyEnabled: true, mcpCustomInstructions: {}, mcpCustomInstructionsByServerId: {}, mcpDisabledToolsByServerId: {}, conciergeConsent: "unset", settingsMigrations: [], inferenceProvider: "claude-code" }));
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir: root,
      postEvent: () => {},
      dispatchRemote: async () => { throw new Error("unexpected remote dispatch"); },
    });

    process.env.SAND_LOCAL_ADMIN = "1";
    delete process.env.SAND_LOCAL_ADMIN_TURN;
    const intercepted = await router.dispatch("sendPrompt", { agentId: "a", prompt: "x" });
    assert.equal(intercepted.handled, true, "default: the Mac coordinator owns routed turns");

    process.env.SAND_LOCAL_ADMIN_TURN = "host";
    const bypassed = await router.dispatch("sendPrompt", { agentId: "a", prompt: "x" });
    assert.equal(bypassed.handled, false, "host-turn mode passes the turn to the host");
    const fallsThrough = await router.dispatch("reactToMessage", { agentId: "a", entryId: "t0u", emoji: "👍" });
    assert.equal(fallsThrough.handled, false, "cursor-path methods still fall through");
  } finally {
    if (previousAdmin == null) delete process.env.SAND_LOCAL_ADMIN;
    else process.env.SAND_LOCAL_ADMIN = previousAdmin;
    if (previousTurn == null) delete process.env.SAND_LOCAL_ADMIN_TURN;
    else process.env.SAND_LOCAL_ADMIN_TURN = previousTurn;
    await loaded.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});








test("exec daemon auth has no default credential and resolves from env in lockstep", async () => {
  const loaded = await loadModule("source/host/box/loopback-sand-box.ts");
  try {
    const { requireExecDaemonAuthToken, resolveExecDaemonAuthTokenFromEnv } = loaded.module;
    assert.throws(() => requireExecDaemonAuthToken(undefined), /requires an explicit auth token/);
    assert.throws(() => requireExecDaemonAuthToken("  "), /requires an explicit auth token/);
    assert.equal(requireExecDaemonAuthToken("real-token"), "real-token");

    assert.throws(() => resolveExecDaemonAuthTokenFromEnv({}), /requires an explicit auth token/);
    assert.equal(resolveExecDaemonAuthTokenFromEnv({ SAND_GATEWAY_TOKEN: "gateway-token" }), "gateway-token");
    assert.equal(
      resolveExecDaemonAuthTokenFromEnv({ SAND_GATEWAY_TOKEN: "gateway-token", SAND_BOX_EXEC_DAEMON_AUTH_TOKEN: "daemon-token" }),
      "daemon-token",
      "an explicit daemon token wins over the gateway token",
    );
  } finally {
    await loaded.dispose();
  }
});
