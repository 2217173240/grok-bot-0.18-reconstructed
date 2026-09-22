// Regression guard for the box-plane chat crash.
//
// The renderer is a checksum-pinned 0.18 artifact that reads user text as
// `entry.text` on `kind:"message"` entries, while the host stores that text as
// `content`. A stored transcript handed to the renderer verbatim made its
// PR-reference extractor call `String.prototype.matchAll` on `undefined`,
// taking the whole chat down with
// "TypeError: Cannot read properties of undefined (reading 'matchAll')".
//
// The projector is the host-side fix, so this test pins its exact behaviour on
// the entry shapes a live box session actually wrote to store.db.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function loadProjector() {
  const buildRoot = await mkdtemp(path.join(tmpdir(), "grok-entry-shape-"));
  const outfile = path.join(buildRoot, "entry-shape.mjs");
  await build({
    entryPoints: [path.join(repositoryRoot, "source/host/extensions/transcript/renderer-entry-shape.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  const module = await import(pathToFileURL(outfile).href);
  return { module, buildRoot };
}

test("host transcript payloads reach the renderer in the spelling it reads", async () => {
  const { module, buildRoot } = await loadProjector();
  const { projectEntryForRenderer, projectTranscriptPayloadForRenderer } = module;
  try {
    // Exactly what a live box agent's store.db held.
    const storedUserEntry = {
      kind: "message",
      id: "t0u",
      role: "user",
      content: "运行 uname -a 并贴出真实输出 探针deliver2",
      richText: "{}",
      isStreaming: false,
      timestampMs: 1789975342179,
    };
    const storedReplyEntry = {
      kind: "send-message",
      id: "t0s0",
      message: { type: "text", content: "Linux 5d9a3d00583c ... aarch64 GNU/Linux" },
      timestampMs: 1789975363456,
    };

    const projectedUser = projectEntryForRenderer(storedUserEntry);
    assert.equal(projectedUser.text, storedUserEntry.content, "message entries must carry the renderer's `text`");
    assert.equal(projectedUser.content, storedUserEntry.content, "the host's `content` must survive for in-host readers");
    assert.equal(projectedUser.role, "user");
    assert.equal(projectedUser.timestampMs, storedUserEntry.timestampMs);

    // send-message already uses the renderer's spelling and must be untouched.
    const projectedReply = projectEntryForRenderer(storedReplyEntry);
    assert.deepEqual(projectedReply, storedReplyEntry);

    // An entry that already has `text` is left exactly as it was.
    const alreadyProjected = { kind: "message", id: "x", role: "user", content: "a", text: "a" };
    assert.equal(projectEntryForRenderer(alreadyProjected), alreadyProjected);

    // Envelopes: transcript windows and live roster events.
    const window = projectTranscriptPayloadForRenderer({ entries: [storedUserEntry], other: 1 });
    assert.equal(window.entries[0].text, storedUserEntry.content);
    assert.equal(window.other, 1);
    const live = projectTranscriptPayloadForRenderer({ type: "appended", agentId: "a", entry: storedUserEntry });
    assert.equal(live.entry.text, storedUserEntry.content);
    assert.equal(live.type, "appended");

    // Hostile shapes degrade to a pass-through rather than throwing.
    for (const value of [null, undefined, 7, "text", [], {}, { entries: [] }, { kind: "message" }, { kind: "message", content: 42 }]) {
      assert.doesNotThrow(() => projectTranscriptPayloadForRenderer(value));
    }
    assert.deepEqual(projectTranscriptPayloadForRenderer([storedUserEntry]).length, 1);
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
});
