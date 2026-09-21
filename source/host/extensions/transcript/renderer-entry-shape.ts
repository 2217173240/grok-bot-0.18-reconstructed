// One spelling of "what the renderer reads" for every entry leaving the host.
//
// The renderer is a checksum-pinned 0.18 artifact (src/app/dist/renderer), so
// its expectations are fixed by that binary rather than by anything in this
// repository's source. It reads user text as `entry.text` on `kind:"message"`
// entries and as `message.content` on `send-message` entries.
//
// The host stores that same text as `content` (send-message-shaping writes it,
// quotableEntryText reads it). Handing a stored transcript to the renderer
// verbatim therefore made its PR-reference extractor call
// `String.prototype.matchAll` on `undefined`, which took down the whole chat:
//
//   TypeError: Cannot read properties of undefined (reading 'matchAll')
//
// Project the renderer spelling on the way out and keep `content`, so every
// in-host reader and every stored transcript keeps working unchanged.

export function projectEntryForRenderer<T>(entry: T): T {
  if (entry == null || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const record = entry as Record<string, unknown>;
  if (record.kind !== "message" || typeof record.content !== "string") return entry;
  if (typeof record.text === "string") return entry;
  return { ...record, text: record.content } as unknown as T;
}

export function projectEntriesForRenderer<T>(entries: readonly T[]): T[] {
  if (!Array.isArray(entries)) return entries as unknown as T[];
  return entries.map(projectEntryForRenderer);
}

// Applies the same projection to whichever envelope the host is about to send:
// a transcript window (`{entries}`), a bare entry array, or a live roster event
// (`{type:"appended", entry}`). Unknown shapes pass through untouched.
export function projectTranscriptPayloadForRenderer<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return projectEntriesForRenderer(value) as unknown as T;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.entries)) {
    return { ...record, entries: projectEntriesForRenderer(record.entries) } as unknown as T;
  }
  if (record.entry != null && typeof record.entry === "object") {
    return { ...record, entry: projectEntryForRenderer(record.entry) } as unknown as T;
  }
  return value;
}
