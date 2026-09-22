import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SAND_PENDING_WAKE_FILE_NAME } from "../../durable-file-policy.js";
import { quarantineDurableFile, writeDurableDegradedMarker, writeDurableEntries } from "./durable-store-file.js";
import type { PendingWakeKind, PendingWakeMarker } from "./async-task-union.js";
export const PENDING_WAKE_KINDS = ["cloud-agent", "subagent", "shell"] as const;
export interface QuietWakeOrigin {
  automation?: { id: string; name: string };
}
export interface DurablePendingWakeMarker extends PendingWakeMarker {
  quietOrigin?: QuietWakeOrigin;
  interruptedByRecreate?: boolean;
}
export function coerceQuietOrigin(
  value: unknown,
): DurablePendingWakeMarker["quietOrigin"] | null {
  if (typeof value !== "object" || value == null) return null;
  const automation = (value as { automation?: unknown }).automation;
  if (typeof automation !== "object" || automation == null) return {};
  const a = automation as Record<string, unknown>;
  return typeof a.id === "string" &&
    a.id.length > 0 &&
    typeof a.name === "string"
    ? { automation: { id: a.id, name: a.name } }
    : {};
}
export function coerceMarker(entry: unknown): DurablePendingWakeMarker | null {
  if (typeof entry !== "object" || entry == null) return null;
  const e = entry as Record<string, unknown>;
  if (
    typeof e.agentId !== "string" ||
    !e.agentId ||
    typeof e.workId !== "string" ||
    !e.workId ||
    !PENDING_WAKE_KINDS.includes(e.kind as PendingWakeKind)
  )
    return null;
  const quietOrigin = coerceQuietOrigin(e.quietOrigin);
  return {
    agentId: e.agentId,
    kind: e.kind as PendingWakeKind,
    workId: e.workId,
    markedAtMs:
      typeof e.markedAtMs === "number" && Number.isFinite(e.markedAtMs)
        ? e.markedAtMs
        : 0,
    ...(quietOrigin != null ? { quietOrigin } : {}),
    ...(typeof e.title === "string" && e.title.length > 0
      ? { title: e.title }
      : {}),
    ...(typeof e.subagentType === "string" && e.subagentType.length > 0
      ? { subagentType: e.subagentType }
      : {}),
    ...(e.interruptedByRecreate === true
      ? { interruptedByRecreate: true }
      : {}),
  };
}
export function coercePendingWakeMarkers(
  value: unknown,
): DurablePendingWakeMarker[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const marker = coerceMarker(entry);
        return marker == null ? [] : [marker];
      })
    : [];
}
// Absent means "nothing pending"; unreadable or unparseable means damage. Every
// write here is read-modify-write, so treating damage as an empty queue would
// overwrite the pending wakes the file still holds.
export function parsePendingWakeFile(
  raw: string | null,
): { entries: DurablePendingWakeMarker[]; damaged: boolean } {
  if (raw == null) return { entries: [], damaged: false };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { entries: [], damaged: true };
  }
  if (typeof value !== "object" || value == null) return { entries: [], damaged: true };
  const pending = (value as { pending?: unknown }).pending;
  // Well-formed JSON with the wrong shape is damage too: the file exists and
  // claims to be this queue, so it must not read as "nothing pending".
  if (!Array.isArray(pending)) return { entries: [], damaged: true };
  const entries = coercePendingWakeMarkers(pending);
  return { entries, damaged: entries.length !== pending.length };
}
export function markerKeyMatches(
  marker: DurablePendingWakeMarker,
  agentId: string,
  kind: PendingWakeKind,
  workId: string,
): boolean {
  return (
    marker.agentId === agentId &&
    marker.kind === kind &&
    marker.workId === workId
  );
}
export function upsertPendingWakeMarker(
  existing: readonly DurablePendingWakeMarker[],
  marker: DurablePendingWakeMarker,
): DurablePendingWakeMarker[] {
  return [
    ...existing.filter(
      (entry) =>
        !markerKeyMatches(entry, marker.agentId, marker.kind, marker.workId),
    ),
    marker,
  ];
}
export class SandPendingWakeStore {
  readonly filePath: string;
  constructor(rootDir: string) {
    this.filePath = join(rootDir, SAND_PENDING_WAKE_FILE_NAME);
  }
  markPending(marker: DurablePendingWakeMarker): boolean {
    const state = this.readState();
    // Quarantine rather than overwrite: the pending wakes the file still holds
    // are the only record that those completions owe a replay.
    if (state.damaged) { quarantineDurableFile(this.filePath, "pending-wake: unreadable pending file"); return false; }
    try {
      this.write(upsertPendingWakeMarker(state.entries, marker));
      return true;
    } catch {
      return false;
    }
  }
  listPending(): DurablePendingWakeMarker[] {
    return this.readState().entries;
  }
  hasPending(agentId: string, kind: PendingWakeKind, workId: string): boolean {
    return this.readState().entries.some((entry) =>
      markerKeyMatches(entry, agentId, kind, workId),
    );
  }
  clearOne(agentId: string, kind: PendingWakeKind, workId: string): boolean {
    const state = this.readState();
    if (state.damaged) { quarantineDurableFile(this.filePath, "pending-wake: unreadable pending file"); return false; }
    try {
      const existing = state.entries,
        remaining = existing.filter(
          (entry) => !markerKeyMatches(entry, agentId, kind, workId),
        );
      if (remaining.length === existing.length) return false;
      remaining.length === 0 ? this.deleteFile() : this.write(remaining);
      return true;
    } catch {
      return false;
    }
  }
  clearAgent(agentId: string): void {
    const state = this.readState();
    if (state.damaged) { quarantineDurableFile(this.filePath, "pending-wake: unreadable pending file"); return; }
    try {
      const existing = state.entries,
        remaining = existing.filter((entry) => entry.agentId !== agentId);
      if (remaining.length === existing.length) return;
      remaining.length === 0 ? this.deleteFile() : this.write(remaining);
    } catch {}
  }
  clearAll(): void {
    this.deleteFile();
  }
  pruneStale(maxAgeMs: number, nowMs = Date.now()): DurablePendingWakeMarker[] {
    const state = this.readState();
    if (state.damaged) { quarantineDurableFile(this.filePath, "pending-wake: unreadable pending file"); return []; }
    try {
      const existing = state.entries,
        pruned = existing.filter(
          (entry) => nowMs - entry.markedAtMs > maxAgeMs,
        );
      if (pruned.length === 0) return [];
      const remaining = existing.filter(
        (entry) => nowMs - entry.markedAtMs <= maxAgeMs,
      );
      remaining.length === 0 ? this.deleteFile() : this.write(remaining);
      return pruned;
    } catch {
      return [];
    }
  }
  readPending(): DurablePendingWakeMarker[] {
    return this.readState().entries;
  }
  readState(): { entries: DurablePendingWakeMarker[]; damaged: boolean } {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT") return { entries: [], damaged: false };
      writeDurableDegradedMarker(this.filePath, `pending-wake: read failed (${String(code ?? error)})`);
      return { entries: [], damaged: true };
    }
    const parsed = parsePendingWakeFile(raw);
    if (parsed.damaged) writeDurableDegradedMarker(this.filePath, "pending-wake: unparseable pending file");
    return parsed;
  }
  write(pending: readonly DurablePendingWakeMarker[]): void {
    writeDurableEntries(this.filePath, { version: 1, pending });
  }
  deleteFile(): void {
    try {
      rmSync(this.filePath, { force: true });
    } catch {}
  }
}
