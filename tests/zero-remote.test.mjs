import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  await mkdir(path.join(repoRoot, ".cache"), { recursive: true });
  const temporary = await mkdtemp(path.join(repoRoot, ".cache", "zero-remote-"));
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

test("the zero-remote classifier accepts blocked attempts and rejects every other cursor/xai url field", async () => {
  const loaded = await loadModule("source/shared/node/zero-remote.ts");
  try {
    const { checkZeroRemoteLedger, classifyZeroRemoteLedgerLine, cursorRemoteUrlFieldsOf } = loaded.module;
    // A blocked-fetch mention is the guard WORKING: the interceptor caught
    // the attempt and zero bytes left the machine.
    assert.equal(classifyZeroRemoteLedgerLine(1, JSON.stringify({ kind: "blocked-fetch", url: "https://api2.cursor.sh/aiserver.v1.AnalyticsService/BootstrapStatsig", method: "POST" })), null);
    assert.deepEqual(cursorRemoteUrlFieldsOf({ baseUrl: "https://api3.cursor.sh", endpoint: "http://127.0.0.1:1340" }), ["baseUrl=https://api3.cursor.sh"]);
    // A URL field pointing at a remote family in any other kind is an
    // egress observation — a violation, whichever family it belongs to.
    for (const record of [
      { kind: "tool-use", url: "https://api2.cursor.sh/exec" },
      { kind: "docker", backendUrl: "https://marketplace.cursor.com" },
      { kind: "local-host", baseUrl: "https://inference.x.ai/v1" },
      { kind: "docker", endpoint: "https://api.grok.com/v1" },
    ]) {
      const violation = classifyZeroRemoteLedgerLine(7, JSON.stringify(record));
      assert.notEqual(violation, null, JSON.stringify(record));
      assert.equal(violation.kind, record.kind);
    }
    // Text mentions are NOT egress claims: agent shell-command audit strings
    // and container-log excerpts inside error text name these domains
    // routinely (both shapes exist in the live ledger); flagging them would
    // make the gate noisy enough to ignore. Independence from them is proven
    // at the network layer in the graduation run.
    assert.equal(classifyZeroRemoteLedgerLine(9, JSON.stringify({ kind: "tool-use", tool: "Bash", input: "curl -sS https://api.x.ai/v1" })), null);
    assert.equal(classifyZeroRemoteLedgerLine(10, JSON.stringify({ kind: "docker", event: "connect-failed", error: "lookup failed privacy.cursor.sh in logs" })), null);
    assert.equal(classifyZeroRemoteLedgerLine(11, JSON.stringify({ kind: "workspace-bind-mount", hostPath: "/Users/me/.grokbot-local/box-workspace" })), null);
    assert.equal(classifyZeroRemoteLedgerLine(12, "not json at all"), null);
    const violations = checkZeroRemoteLedger([
      JSON.stringify({ kind: "blocked-fetch", url: "https://api2.cursor.sh/x" }),
      JSON.stringify({ kind: "workspace-bind-mount", hostPath: "/Users/me/.grokbot-local/box-workspace" }),
      JSON.stringify({ kind: "tool-use", url: "https://evil.x.ai/" }),
    ]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, "tool-use");
  } finally {
    await loaded.dispose();
  }
});

test("the remote-domain matcher covers both families the goal names", async () => {
  const loaded = await loadModule("source/shared/node/local-admin.ts");
  try {
    const { isCursorProductionBackendUrl } = loaded.module;
    for (const url of ["https://api2.cursor.sh", "https://marketplace.cursor.com/x", "https://inference.x.ai/v1", "https://api.grok.com/v1"]) {
      assert.equal(isCursorProductionBackendUrl(url), true, url);
    }
    for (const url of ["http://127.0.0.1:1340", "http://localhost:9", "https://open.bigmodel.cn/api/anthropic", "https://api.openrouter.ai/api/v1"]) {
      assert.equal(isCursorProductionBackendUrl(url), false, url);
    }
  } finally {
    await loaded.dispose();
  }
});

test("the egress call-site inventory is pinned to reviewed, guarded sites", async () => {
  // The inventory is derived from actual transport imports, not from "we
  // intercept fetch": connect-node bypasses the fetch layer, so every file
  // importing @connectrpc/connect-node must be a reviewed site with a local
  // guard or a provably local endpoint. A new file appearing here fails this
  // test and forces a conscious inventory decision.
  const expected = [
    "source/box-exec-daemon/server.ts",             // local: in-box daemon listener (127.0.0.1)
    "source/box-exec-daemon/smoke.ts",              // local: in-box 127.0.0.1:1337 client
    "source/host/box/generated-production.ts",      // local: box endpoint transport factory (http://host:port)
    "source/shared/node/cursor-backend/cursor-inference.ts", // remote: cursor backend
    "source/shared/node/marketplace/cursor-marketplace-client.ts", // remote: marketplace dashboard
  ];
  const found = new Set();
  for (const directory of ["source/shared", "source/host", "source/electron-main", "source/box-exec-daemon", "source/node-agent-coordinator"]) {
    for (const file of await listTypeScriptFiles(path.join(repoRoot, directory))) {
      const source = await readFile(file, "utf8");
      if (source.includes('from "@connectrpc/connect-node"')) found.add(path.relative(repoRoot, file).split(path.sep).join("/"));
    }
  }
  assert.deepEqual([...found].sort(), expected);
  // The two remote-facing sites carry their fail-closed guards…
  const inference = await readFile(path.join(repoRoot, "source/shared/node/cursor-backend/cursor-inference.ts"), "utf8");
  assert.match(inference, /Cursor inference is unavailable in local admin mode/);
  assert.match(inference, /routedProvider !== "cursor"/);
  const desktop = await readFile(path.join(repoRoot, "source/electron-main/mcp/mcp-desktop.ts"), "utf8");
  assert.match(desktop, /marketplaceUnavailable \? \[\]/);
  // …and the global fetch layer is installed with the blocking recorder.
  const main = await readFile(path.join(repoRoot, "source/electron-main/main.ts"), "utf8");
  assert.match(main, /installLocalAdminNetworkIntercept\(env\)/);
  const interceptor = await readFile(path.join(repoRoot, "source/shared/node/local-admin-intercept.ts"), "utf8");
  assert.match(interceptor, /throw new Error\(`SAND_LOCAL_ADMIN blocked fetch \$\{url\}`\)/);
});

async function listTypeScriptFiles(directory) {
  const { readdir } = await import("node:fs/promises");
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(full));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}
