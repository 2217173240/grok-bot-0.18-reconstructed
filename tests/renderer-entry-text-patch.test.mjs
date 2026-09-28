// Regression guard for the chat-wide crash caused by the shipped renderer's
// own entry-text extractor.
//
// The renderer's transcript projection writes `text` on ordinary message
// entries, while the extractor baked into the shipped bundle read `content` and
// passed the result straight to `String.prototype.matchAll`. One ordinary
// message therefore produced `undefined.matchAll(...)`:
//
//   TypeError: Cannot read properties of undefined (reading 'matchAll')
//
// The error boundary then replaced the whole chat with "Something went wrong".
// Packaging repairs the bundled extractor. This test exercises that transform
// on a fixture built from the transform's own anchors, so it also runs on a
// fresh checkout: `src/app/dist/renderer` is a bootstrap output and CI does not
// carry it. Whether the shipped artifact still contains those anchors is
// enforced at package time, where a moved anchor fails the build instead of
// being skipped.

import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import {
  RENDERER_ENTRY_TEXT_ANCHORS,
  patchOriginalEntryTextExtractor,
  patchOriginalComposerDraftRestore,
} from "../scripts/lib/router-renderer-patch.mjs";

const {
  entryTextBefore,
  entryTextAfter,
  prScanBefore,
  prScanAfter,
  draftRestoreBefore,
  draftRestoreAfter,
} = RENDERER_ENTRY_TEXT_ANCHORS;

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
  // A fixture carrying both anchors in the order the real chunk has them.
  const fixture = `const I_n=/https?:\\/\\/[^\\s<>()[\\]]+/g;${entryTextBefore}${prScanBefore}const s=t[0].replace(/[.,;:!?]+$/,""),r=Rpt(s);r!=null&&e.push({prNumber:r.prNumber,title:null,url:r.url})}return e}${draftRestoreBefore}`;
  const patched = patchOriginalComposerDraftRestore(patchOriginalEntryTextExtractor(fixture));

  assert.ok(patched.includes(entryTextAfter), "the extractor must gain the fallback");
  assert.ok(patched.includes(prScanAfter), "the scan must gain the string guard");
  assert.ok(patched.includes(draftRestoreAfter), "draft restoration must remeasure the editor layout");
  assert.ok(!patched.includes(entryTextBefore), "the original extractor must be gone");
  assert.equal(
    patched.length,
    fixture.length + (entryTextAfter.length - entryTextBefore.length) + (prScanAfter.length - prScanBefore.length) + (draftRestoreAfter.length - draftRestoreBefore.length),
  );

  const extractBefore = eval(`(${extractFunction(fixture, "A_n")})`);
  const extractAfter = eval(`(${extractFunction(patched, "A_n")})`);

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
  assert.equal(extractAfter(entries[0]), "hello");
  assert.equal(extractAfter(entries[1]), "hi");
  assert.equal(extractAfter(entries[2]), "from the host");
  assert.equal(extractAfter(entries[3]), "");

  // A moved anchor must fail loudly rather than quietly skip the repair.
  assert.throws(() => patchOriginalEntryTextExtractor("const nothing = 1;"), /anchor is missing or ambiguous/);
});

test("composer draft restore requests a fresh field measurement after setContent", async () => {
  const fixture = `function e9n(){${draftRestoreBefore}}`;
  const patched = patchOriginalComposerDraftRestore(fixture);
  assert.ok(patched.includes(draftRestoreAfter));
  assert.throws(() => patchOriginalComposerDraftRestore("function e9n(){}"), /anchor is missing or ambiguous/);
});

const stockRenderer = path.resolve(import.meta.dirname, "../src/app/dist/renderer/assets/index-UbX-y3il.js");
let stockRendererAvailable = true;
try { await access(stockRenderer); } catch { stockRendererAvailable = false; }

test("stock composer restore anchor is present in the pinned renderer", { skip: !stockRendererAvailable }, async () => {
  const source = await readFile(stockRenderer, "utf8");
  assert.equal(source.includes(draftRestoreBefore), true);
  const start = source.indexOf(draftRestoreBefore);
  const context = source.slice(Math.max(0, start - 7000), start + draftRestoreBefore.length + 300);
  assert.match(context, /onUpdate:\(\{editor:X\}\)=>\{[^}]*E\(\)\}/);
  assert.equal(patchOriginalComposerDraftRestore(source).includes(draftRestoreAfter), true);
});
