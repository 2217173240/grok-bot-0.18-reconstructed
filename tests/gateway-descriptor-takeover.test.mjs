// Regression guard for the persisted gateway descriptor.
//
// The store exists so a restart reconnects without another EnsureSandBox, and
// the base URL plus token survive that. The takeover URL does not: the pod mints
// it per box together with its network token, so a copy kept for the descriptor's
// own lifetime (up to seven days) points at a surface that has been re-minted.
// The fast path served it straight to the UI, which put a dead link in front of
// the operator with nothing to say so.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function loadStore() {
  const buildRoot = await mkdtemp(path.join(tmpdir(), "grok-gateway-descriptor-"));
  const outfile = path.join(buildRoot, "gateway-descriptor-cache.mjs");
  await build({
    entryPoints: [path.join(repositoryRoot, "source/electron-main/box/gateway-descriptor-cache.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  return { module: await import(pathToFileURL(outfile).href), buildRoot };
}

const SAVED_AT_MS = 1_700_000_000_000;

function connection(module) {
  return {
    baseUrl: "https://box.example.invalid",
    token: "gateway-token",
    vncProxy: {
      primaryUrl: "https://pod.example.invalid/vnc.html?token=minted",
      forkBaseUrl: "https://pod.example.invalid/fork",
      networkToken: "network-token",
    },
  };
}

async function storeIn(directory, module) {
  return module.createPersistedGatewayDescriptorStore({
    filePath: path.join(directory, "descriptor.json"),
    codec: { isAvailable: () => true, encrypt: (plaintext) => plaintext, decrypt: (stored) => stored },
    now: () => SAVED_AT_MS,
  });
}

test("a persisted descriptor reconnects the gateway without serving a stale takeover url", async () => {
  const { module, buildRoot } = await loadStore();
  const directory = await mkdtemp(path.join(tmpdir(), "grok-gateway-descriptor-store-"));
  try {
    const store = await storeIn(directory, module);
    await store.write("scope-1", connection(module));

    // The stored bytes do carry the takeover URL; the read is what withholds it.
    const onDisk = await readFile(path.join(directory, "descriptor.json"), "utf8");
    assert.match(onDisk, /pod\.example\.invalid/, "the descriptor is written whole");

    const restored = await store.read("scope-1");
    assert.equal(restored.baseUrl, "https://box.example.invalid");
    assert.equal(restored.token, "gateway-token");
    assert.equal(restored.vncProxy, undefined, "a takeover url from a previous process must not be served");

    // A descriptor written under the earlier version is not read at all: the
    // meaning of the stored fields changed, so reconnecting once more is the
    // honest price.
    await writeFile(
      path.join(directory, "descriptor.json"),
      JSON.stringify({ version: 1, accountScope: "scope-1", savedAtMs: SAVED_AT_MS, encrypted: JSON.stringify(connection(module)) }),
    );
    assert.equal(await store.read("scope-1"), null);

    // A missing file is not damage: the store answers nothing and the caller
    // does a full connect.
    await store.clear();
    assert.equal(await store.read("scope-1"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(buildRoot, { recursive: true, force: true });
  }
});
