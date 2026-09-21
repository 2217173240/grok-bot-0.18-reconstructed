// The coordinator resyncs desktop settings into the box on every transport
// connect. When the desktop has no account scope it used to push
// `mcpCustomInstructionsAccountScope: null`, and the host reads that as "the
// account left": `setHostSettings` calls `clearAccountScope()`, which drops
// `localToolPermission`, `localToolPermissionCeiling`, `computerUseModel`,
// `agentDefaultModel` and `autoReviewInstructions` and empties the three MCP
// tables. A deployment with no account at all therefore erased the box's own
// permission and model settings on every resync.
//
// The resync must leave the host scope alone when there is nothing to scope to.
// A real account departure still clears it through the explicit transition path.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function loadResyncChain() {
  const buildRoot = await mkdtemp(path.join(tmpdir(), "grok-resync-chain-"));
  const outfile = path.join(buildRoot, "coordinator-resync.mjs");
  await build({
    entryPoints: [path.join(repositoryRoot, "source/electron-main/coordinator/coordinator-resync.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  const module = await import(pathToFileURL(outfile).href);
  return { module, buildRoot };
}

// Mirrors sand-settings-store.clearAccountScope so the test fails for the same
// reason the shipped application did.
function applyHostSettings(host, update) {
  if (update.mcpCustomInstructionsAccountScope === null) {
    const cleared = { ...host };
    delete cleared.mcpCustomInstructionsAccountScope;
    delete cleared.localToolPermission;
    delete cleared.localToolPermissionCeiling;
    delete cleared.computerUseModel;
    delete cleared.agentDefaultModel;
    delete cleared.autoReviewInstructions;
    return { ...cleared, mcpCustomInstructions: {}, mcpCustomInstructionsByServerId: {}, mcpDisabledToolsByServerId: {} };
  }
  return { ...host, ...update };
}

function createChain(module, initialState) {
  let host = { ...initialState };
  const pushes = [];
  const deps = {
    legs: {
      getHostSettings: async () => ({ ...host }),
      setHostSettings: async (update) => {
        pushes.push(update);
        host = applyHostSettings(host, update);
        return { ...host };
      },
    },
    getMcpCustomInstructionsAccountScope: () => null,
    getMcpCustomInstructionsByServerId: () => ({}),
    getMcpDisabledToolsByServerId: () => ({}),
    setMcpCustomInstructionsByServerId: () => {},
    setMcpDisabledToolsByServerId: () => {},
    detectTimeZone: () => undefined,
    getUserTimeZoneOverride: () => undefined,
    // The resync pushes these derived values into the box. Report the state the
    // box already holds, so any change observed below comes from the host's
    // account-scope clearing rather than from the resync writing something else.
    getComputerUseModel: () => initialState.computerUseModel,
    getAutoReviewInstructions: () => initialState.autoReviewInstructions,
    getLocalToolPermission: () => initialState.localToolPermission,
    getWebauthnProxyEnabled: () => initialState.webauthnProxyEnabled,
    getFeatureFlagOverrides: () => undefined,
    pushBoxSecrets: async () => undefined,
    syncWindowFocused: async () => undefined,
  };
  return { chain: module.createCoordinatorResyncChain(deps), pushes, host: () => host };
}

test("a resync without an account scope leaves the box settings alone", async () => {
  const { module, buildRoot } = await loadResyncChain();
  try {
    const initial = {
      localToolPermission: "allow",
      computerUseModel: { modelId: "claude-opus-4-8", maxMode: false, parameters: [] },
      mcpCustomInstructionsByServerId: { demo: "keep me" },
      mcpDisabledToolsByServerId: { demo: ["dangerous"] },
      inferenceProvider: "claude-code",
    };
    const { chain, pushes, host } = createChain(module, initial);

    await chain.onTransportConnected();

    const clearedScopes = pushes.filter((update) => update.mcpCustomInstructionsAccountScope === null);
    assert.deepEqual(clearedScopes, [], "a scope-less resync must not ask the host to clear its account scope");

    const final = host();
    assert.equal(final.localToolPermission, "allow", "the box permission setting must survive");
    assert.deepEqual(final.computerUseModel, initial.computerUseModel, "the box computer-use model must survive");
    assert.deepEqual(final.mcpDisabledToolsByServerId, initial.mcpDisabledToolsByServerId, "the box MCP disabled table must survive");
    assert.equal(final.inferenceProvider, "claude-code", "unrelated settings must be untouched");
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
});

test("an explicit account departure still clears the box scope", async () => {
  const { module, buildRoot } = await loadResyncChain();
  try {
    const initial = {
      mcpCustomInstructionsAccountScope: "account-1",
      localToolPermission: "allow",
      computerUseModel: { modelId: "claude-opus-4-8", maxMode: false, parameters: [] },
    };
    const { chain, host } = createChain(module, initial);

    // This is what prepareAccountTransition pushes on a real departure.
    await chain.pushHostSettings({
      mcpCustomInstructionsAccountScope: null,
      mcpCustomInstructions: {},
      mcpCustomInstructionsByServerId: {},
      mcpDisabledToolsByServerId: {},
    });

    const final = host();
    assert.equal(final.mcpCustomInstructionsAccountScope, undefined);
    assert.equal(final.localToolPermission, undefined);
    assert.deepEqual(final.mcpCustomInstructionsByServerId, {});
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
});
