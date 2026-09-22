// Durable host-side queues share one failure rule: a file that is ABSENT means
// "nothing pending", while a file that cannot be read or parsed is DAMAGE. The
// distinction matters because the writes are read-modify-write: building the next
// state from an empty list that actually meant "unreadable" overwrites whatever
// the file still held, destroying the pending work and the evidence of the
// failure in one step. The prompt-acceptance ledger already follows this rule
// (it carries a `damaged` flag and refuses to reset silently); this module gives
// the other queues the same behaviour.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DURABLE_STORE_DEGRADED_SUFFIX = ".degraded";

// A cheap identity for the file's current contents. A cached read may only be
// reused while this is unchanged, so a file replaced underneath the process is
// noticed instead of being answered from stale state forever.
export function readDurableFileSignature(filePath: string): string | null {
  try {
    const info = statSync(filePath);
    return `${info.mtimeMs}:${info.size}:${info.ino}`;
  } catch {
    return null;
  }
}

// Record the damage next to the file instead of overwriting it, so the original
// bytes survive for inspection and an operator can see why a queue went quiet.
export function writeDurableDegradedMarker(filePath: string, reason: string): void {
  const markerPath = `${filePath}${DURABLE_STORE_DEGRADED_SUFFIX}`;
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify({ atMs: Date.now(), reason, file: filePath }, null, 2)}\n`, { mode: 0o600 });
  } catch {}
}

// Move unreadable bytes aside under a unique name. This is the state a caller
// needs when it must keep operating: the archive survives for inspection and the
// queue's own path becomes writable again, so a later write cannot destroy it.
// Returns the archive path, or undefined when there was nothing to archive.
export function quarantineDurableFile(filePath: string, reason: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  const atMs = Date.now();
  const base = `${filePath}.corrupt-${atMs}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const target = attempt === 0 ? base : `${base}-${attempt}`;
    if (existsSync(target)) continue;
    try {
      renameSync(filePath, target);
      writeDurableDegradedMarker(filePath, reason);
      return target;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// Atomic replace: write a sibling part file, flush it, then rename over the
// target. A reader therefore never observes a half-written queue.
export function writeDurableEntries(filePath: string, value: unknown): void {
  const part = `${filePath}.part`;
  mkdirSync(dirname(filePath), { recursive: true });
  const handle = openSync(part, "w", 0o600);
  try {
    writeFileSync(handle, `${JSON.stringify(value)}\n`);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(part, filePath);
  // The queue holds good data again, so the degraded note no longer applies.
  try {
    rmSync(`${filePath}${DURABLE_STORE_DEGRADED_SUFFIX}`, { force: true });
  } catch {}
}

export function removeDurableEntries(filePath: string): void {
  try {
    rmSync(filePath, { force: true });
  } catch {}
  try {
    rmSync(`${filePath}${DURABLE_STORE_DEGRADED_SUFFIX}`, { force: true });
  } catch {}
}
