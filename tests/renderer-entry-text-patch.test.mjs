// Regression guard for the chat-wide crash caused by the shipped renderer's
// own entry-text extractor.
//
// The renderer's transcript projection (`frontend/src/production/model.ts`)
// writes `text` on ordinary message entries. The extractor baked into the
// shipped bundle read `content` and passed the result straight to
// `String.prototype.matchAll`, so one ordinary message produced
// `undefined.matchAll(...)`:
//
//   TypeError: Cannot read properties of undefined (reading 'matchAll')
//
// The error boundary then replaced the whole chat with "Something went wrong".
// The packaging step repairs the bundled extractor; this test pins the repair
// against the real artifact bytes so a future repack cannot silently drop it.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  patchOriginalEntryTextExtractor,
} from "../scripts/lib/router-renderer-patch.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const shippedRenderer = path.join(
  repositoryRoot,
  "src/app/dist/renderer/assets/index-UbX-y3il.js",
);

function extractFunction(source, name) {
  const key = `function ${name}(`;
  const start = source.indexOf(key);
  if (start < 0) return null;
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

test("the packaged renderer extractor tolerates every entry spelling the app produces", async () => {
  const original = await readFile(shippedRenderer, "utf8");
  const patched = patchOriginalEntryTextExtractor(original);

  // The patch must be additive and idempotent-safe: it rewrites the two exact
  // anchors and does not touch anything else structurally.
  assert.notEqual(patched, original);
  assert.ok(patched.length > original.length);
  assert.ok(patched.includes("n.content??n.text??\"\""), "the extractor must fall back to `text`");
  assert.ok(patched.includes("typeof n===\"string\"?n:\"\""), "the scan must never receive a non-string");

  const extractBefore = eval(`(${extractFunction(original, "A_n")})`);
  const extractAfter = eval(`(${extractFunction(patched, "A_n")})`);
  assert.equal(typeof extractBefore, "function");
  assert.equal(typeof extractAfter, "function");

  const entries = [
    // What frontend/src/production/model.ts actually emits.
    { kind: "message", id: "p1", role: "user", author: "You", text: "hello", timestampMs: 1 },
    { kind: "message", id: "p2", role: "assistant", author: "Grok", text: "hi", timestampMs: 2 },
    // What the host stores on disk.
    { kind: "message", id: "h1", role: "user", content: "from the host", timestampMs: 3 },
    // Degenerate shapes must still yield a string.
    { kind: "message", id: "d1", role: "user", timestampMs: 4 },
    { kind: "send-message", id: "d2", message: { type: "text" }, timestampMs: 5 },
    { kind: "notice", id: "d3", timestampMs: 6 },
  ];

  const beforeBad = entries.filter((entry) => typeof extractBefore(entry) !== "string");
  assert.ok(
    beforeBad.length > 0,
    "the guard is only meaningful if the unpatched extractor really returns a non-string for some entry spelling",
  );

  for (const entry of entries) {
    assert.equal(typeof extractAfter(entry), "string", `entry ${entry.id} must produce a string`);
  }
  // Real values still come through.
  assert.equal(extractAfter(entries[0]), "hello");
  assert.equal(extractAfter(entries[1]), "hi");
  assert.equal(extractAfter(entries[2]), "from the host");
  assert.equal(extractAfter(entries[3]), "");
});
