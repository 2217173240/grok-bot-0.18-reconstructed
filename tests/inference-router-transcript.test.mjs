import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-router-transcript-"));
  const buildEntry = async (entry, name) => {
    const output = path.join(temporary, name);
    await build({
      entryPoints: [path.join(repoRoot, entry)],
      outfile: output,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
    return await import(`${pathToFileURL(output).href}?${Date.now()}`);
  };
  const module = await buildEntry("source/node-agent-coordinator/inference-router.ts", "inference-router.mjs");
  const settings = await buildEntry("source/shared/node/settings/sand-settings-store.ts", "settings.mjs");
  return { module, settings, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("routed transcript preserves structured MCP mention rich text across reload", async () => {
  const loaded = await loadModule();
  try {
    const richText = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [
        { type: "mention", attrs: { id: "mcp:3213107", label: "Gmail" } },
        { type: "text", text: " what's new?" },
      ] }],
    });
    const store = loaded.module.parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        agent: [{
          provider: "codex",
          role: "user",
          content: "@Gmail what's new?",
          richText,
          id: "t1u",
          clientNonce: "nonce-1",
          timestampMs: 123,
        }],
      },
    });
    const projected = loaded.module.projectInferenceRouterTranscriptEntry(store.agents.agent[0]);
    assert.equal(projected.richText, richText);
    assert.deepEqual(JSON.parse(projected.richText).content[0].content[0], {
      type: "mention",
      attrs: { id: "mcp:3213107", label: "Gmail" },
    });
  } finally {
    await loaded.dispose();
  }
});

test("routed transcript rejects malformed rich text carriers", async () => {
  const loaded = await loadModule();
  try {
    const store = loaded.module.parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        agent: [{ provider: "codex", role: "user", content: "@Gmail", richText: {}, id: "t1u", timestampMs: 123 }],
      },
    });
    assert.deepEqual(store.agents.agent, []);
  } finally {
    await loaded.dispose();
  }
});

// The routed turn stores text only, so a send carrying an attachment, a reply
// target, or a fork marker cannot be represented. Claiming it would accept the
// prompt and silently lose the rest; declining hands the turn to the in-box
// plane, which implements all of them.
test("the routed turn declines sends it cannot represent", async () => {
  const loaded = await loadModule();
  try {
    const { routedSendIsRepresentable } = loaded.module;
    assert.equal(routedSendIsRepresentable({ prompt: "hi" }), true);
    assert.equal(routedSendIsRepresentable({ prompt: "hi", attachmentPaths: [] }), true);
    assert.equal(routedSendIsRepresentable({ prompt: "hi", attachmentPaths: ["/workspace/a.png"] }), false);
    assert.equal(routedSendIsRepresentable({ prompt: "hi", replyToId: "t0u" }), false);
    assert.equal(routedSendIsRepresentable({ prompt: "hi", replyToId: "" }), true);
    assert.equal(routedSendIsRepresentable({ prompt: "hi", isFork: true }), false);
    assert.equal(routedSendIsRepresentable({ prompt: "hi", isFork: false }), true);
  } finally {
    await loaded.dispose();
  }
});

async function startRouter(loaded, { transcriptTail }) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grok-inference-router-"));
  await writeFile(
    path.join(dataDir, "settings.json"),
    `${JSON.stringify({ version: loaded.settings.SETTINGS_VERSION, inferenceProvider: "codex" })}\n`,
  );
  const events = [];
  const dispatched = [];
  const router = loaded.module.createCoordinatorInferenceRouter({
    dataDir,
    postEvent: (family, payload) => events.push({ family, payload }),
    dispatchRemote: async (method, args) => {
      dispatched.push({ method, args });
      if (method === "getAgentTranscriptTail") return await transcriptTail();
      if (method === "listAgents") return [];
      throw new Error(`unexpected remote method ${method}`);
    },
  });
  return { dataDir, events, dispatched, router };
}

async function waitForTranscriptEvent(events, count) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const transcriptEvents = events.filter((event) => event.family === "transcript");
    if (transcriptEvents.length >= count) return transcriptEvents;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the router produced ${events.filter((event) => event.family === "transcript").length} transcript events, expected ${count}`);
}

// The retired Mac-plane arithmetic derived the turn from the ids it could parse
// and minted router errors as `t<epoch millis>s0`, which the parse regex then
// read back as a turn — one error pushed every later id to millisecond scale,
// and two errors in the same millisecond produced the same id. Both planes now
// mint through transcript-entry-ids.
test("router errors keep canonical entry ids", async () => {
  const loaded = await loadModule();
  try {
    const { router, events, dataDir } = await startRouter(loaded, {
      transcriptTail: async () => { throw new Error("box gateway unreachable"); },
    });
    try {
      await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hello" });
      const afterFirst = await waitForTranscriptEvent(events, 1);
      await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "again" });
      const afterSecond = await waitForTranscriptEvent(events, 2);
      const ids = afterSecond.map((event) => event.payload.entry.id);
      // With no user message yet the shared generator opens the boot turn, the
      // same ids the in-box plane would mint for the same two entries.
      assert.deepEqual(ids, ["tbs0", "tbs1"], "router errors must not mint ids from the wall clock");
      assert.equal(afterFirst[0].payload.entry.id, "tbs0");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  } finally {
    await loaded.dispose();
  }
});

// An unreadable tail used to be treated as an empty transcript, so the router
// re-minted `t0u` — an id the box already holds. The box store inserts with
// INSERT OR IGNORE, so the collision was discarded without a trace.
test("an unreadable box tail stops the send instead of re-minting ids", async () => {
  const loaded = await loadModule();
  try {
    const { router, events, dataDir } = await startRouter(loaded, {
      transcriptTail: async () => ({ unexpected: true }),
    });
    try {
      const result = await router.dispatch("sendPrompt", { agentId: "agent-1", prompt: "hello" });
      assert.equal(result.handled, true);
      const transcriptEvents = await waitForTranscriptEvent(events, 1);
      assert.match(transcriptEvents[0].payload.entry.message.content, /tail is unreadable/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  } finally {
    await loaded.dispose();
  }
});

// The in-box transcript is the transcript of record for an id, so a local entry
// whose id the remote tail already holds must not be appended a second time.
test("the transcript merge does not repeat an id the box already reported", async () => {
  const loaded = await loadModule();
  try {
    const { router, dataDir } = await startRouter(loaded, {
      transcriptTail: async () => ({ entries: [{ kind: "message", id: "t0u", role: "user", content: "from the box", timestampMs: 1 }] }),
    });
    try {
      await writeFile(
        path.join(dataDir, "inference-router-transcript.json"),
        `${JSON.stringify({ schemaVersion: 2, agents: { "agent-1": [{ provider: "codex", role: "user", content: "local copy", id: "t0u", timestampMs: 2 }] } })}\n`,
      );
      const result = await router.dispatch("getAgentTranscriptTail", { id: "agent-1" });
      const entries = result.value.entries;
      assert.equal(entries.filter((entry) => entry.id === "t0u").length, 1);
      assert.equal(entries[0].content, "from the box");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  } finally {
    await loaded.dispose();
  }
});
