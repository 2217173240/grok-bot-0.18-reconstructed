import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
async function withModule(source, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "round2-storage-"));
  try {
    const output = path.join(root, ".cache", `round2-storage-${path.basename(directory)}.mjs`);
    await mkdir(path.dirname(output), { recursive: true });
    try {
      const contents = (Array.isArray(source) ? source : [source]).map(file => `export * from ${JSON.stringify(path.join(root, file))};`).join("\n");
      await build({ stdin: { contents, resolveDir: root, loader: "ts" }, outfile: output, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
      await run(await import(pathToFileURL(output).href), directory);
    } finally { await rm(output, { force: true }); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("spill enforces the actual byte cap and leaves symlink referents untouched", async () => {
  await withModule("source/electron-main/telemetry/desktop-structured-log-spill.ts", async (api, dir) => {
    const file = path.join(dir, "spill");
    const spill = api.createDesktopStructuredLogSpill({ path: file });
    await writeFile(file, Buffer.alloc(api.DESKTOP_STRUCTURED_LOG_SPILL_MAX_BYTES + 1));
    assert.equal((await spill.load("account")).failure.errorClass, "SpillFileOversize");
    const target = path.join(dir, "target");
    await writeFile(target, "unchanged");
    if (process.platform !== "win32") {
      await symlink(target, file);
      assert.equal((await spill.load("account")).kind, "failed");
      assert.equal(await readFile(target, "utf8"), "unchanged");
    }
    await rm(file, { force: true });
    const state = { accountSlot: "account", checkpoint: { counterId: "counter", counters: api.emptyDesktopStructuredLogDropCounters(), records: [{ level: "info", message: "sand.send", metadata: {}, timestamp: Date.now() }] } };
    assert.equal((await spill.replace(state)).kind, "stored");
    assert.equal((await spill.load("account")).kind, "loaded");
  });
});

test("snapshot uploads pin a private copy for both buffered and streaming storage", async () => {
  await withModule(["source/host/extensions/box-store-sync/store-db-snapshot-upload.ts", "source/host/extensions/box-store-sync/box-object-store.ts", "source/host/extensions/box-store-sync/box-store-manifest.ts", "source/internal/scheduling.ts"], async (api, dir) => {
    for (const threshold of [1, 1024]) {
      const source = path.join(dir, `source-${threshold}`);
      const original = Buffer.from("original snapshot bytes");
      await writeFile(source, original);
      const objectStoreProvider = new api.LocalFsObjectStoreProvider(path.join(dir, `objects-${threshold}`));
      const manifestStore = new api.BoxStoreManifestStore({
        deps: { objectStoreProvider, resolveStoreId: async () => "store", manifestV2: true, manifestRetry: api.createRealRetryPolicy({ name: "test", maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 }) },
        now: Date.now, log: console.error, isDisposed: () => false,
      });
      const manifest = await manifestStore.loadManifest("store");
      const uploader = new api.StoreDbSnapshotUpload({
        now: Date.now, log: console.error, maxObjectBytes: 1024, largeObjectThreshold: threshold,
        manifestStore, objectStoreProvider,
      });
      assert.equal((await uploader.uploadAgentDbSnapshot("store", manifest, "db", source, 0o600)).outcome, "uploaded");
      await manifestStore.saveManifest("store");
      const persisted = JSON.parse(await readFile(path.join(dir, `objects-${threshold}`, "store", "manifest.json"), "utf8"));
      const entry = persisted.entries.db;
      const uploaded = await readFile(path.join(dir, `objects-${threshold}`, "store", "blobs", entry.sha));
      assert.deepEqual(uploaded, original);
      assert.equal(entry.size, uploaded.length);
      assert.equal(entry.sha, createHash("sha256").update(uploaded).digest("hex"));
      await writeFile(source, Buffer.alloc(1025));
      assert.equal((await uploader.uploadAgentDbSnapshot("store", manifest, "db", source, 0o600)).outcome, "oversize");
    }
  });
});

test("adopted real terminal retains one inode after its public path is replaced", { timeout: 30000 }, async () => {
  await withModule(["source/packages/local-exec/background-shell-observability.ts", "source/packages/local-exec/background-shell.ts", "source/packages/local-exec/shell-core.ts", "source/packages/shell-exec/naive.ts", "source/packages/context/core.ts"], async (api, dir) => {
    const terminal = path.join(dir, "terminals", "7.txt");
    await mkdir(path.dirname(terminal));
    await writeFile(terminal, "old foreground log");
    const factory = new api.FileLoggingShellFactory(new api.CoreShellFactory(), dir);
    const script = path.join(dir, "child.cjs");
    const gate = path.join(dir, "continue");
    await writeFile(script, `const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);console.log('new output');}},10);setTimeout(()=>process.exit(2),10000).unref();`);
    const executor = new api.BaseShellCoreExecutor(new api.NaiveTerminalExecutor(dir, { shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh" }));
    const ctx = api.createContext();
    const command = `"${process.execPath}" "${script}"`;
    const abortController = new AbortController();
    const eventIterator = executor.execute(ctx, { command: process.platform === "win32" ? `& ${command}` : command, workingDirectory: dir, signal: abortController.signal })[Symbol.asyncIterator]();
    let ready;
    while (!(ready = await eventIterator.next()).done && ready.value.type !== "stdin_ready") {}
    assert.equal(ready.value.type, "stdin_ready");
    const shell = await factory.adopt({ ctx, shellId: 7, workingDirectory: dir, command, startTime: Date.now(), initialOutput: "prior output\n", eventIterator, abortController, pid: ready.value.pid });
    const completion = new Promise(resolve => shell.onComplete(resolve));
    const pinned = path.join(dir, "pinned-log");
    await rename(terminal, pinned);
    await writeFile(terminal, "replacement must survive");
    await writeFile(gate, "go");
    assert.equal((await completion).code, 0);
    assert.equal(await readFile(terminal, "utf8"), "replacement must survive");
    const log = await readFile(pinned, "utf8");
    assert.match(log, /prior output\nnew output/);
    assert.match(log, /status: succeeded/);
  });
});

test("MCP migration preserves legacy data and ignores it after initialization", async () => {
  await withModule("source/shared/node/mcp/local-mcp-servers.ts", async (api, dir) => {
    const legacy = path.join(dir, api.LOCAL_MCP_SERVERS_FILENAME);
    const original = JSON.stringify({ mcpServers: { example: { command: "node" } } });
    await writeFile(legacy, original);
    api.prepareLocalMcpPluginsDir(dir);
    assert.equal(await readFile(legacy, "utf8"), original);
    await rm(legacy);
    await mkdir(legacy);
    api.prepareLocalMcpPluginsDir(dir);
    assert.equal((await api.readLocalMcpServersConfig(dir)).mcpServers.example.command, "node");
  });
});
