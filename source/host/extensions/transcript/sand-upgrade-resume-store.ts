import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SAND_UPGRADE_RESUME_FILE_NAME } from "../../durable-file-policy.js";
import { quarantineDurableFile, writeDurableDegradedMarker, writeDurableEntries } from "./durable-store-file.js";
export interface UpgradeResumeMarker {
  agentId: string;
  markedAtMs: number;
  source?: string;
  automationId?: string;
  automationRunId?: string;
}
export function coerceUpgradeResumeMarker(
  entry: unknown,
): UpgradeResumeMarker | null {
  if (typeof entry !== "object" || entry == null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.agentId !== "string" || !e.agentId) return null;
  return {
    agentId: e.agentId,
    markedAtMs:
      typeof e.markedAtMs === "number" && Number.isFinite(e.markedAtMs)
        ? e.markedAtMs
        : 0,
    ...(typeof e.source === "string" ? { source: e.source } : {}),
    ...(typeof e.automationId === "string"
      ? { automationId: e.automationId }
      : {}),
    ...(typeof e.automationRunId === "string"
      ? { automationRunId: e.automationRunId }
      : {}),
  };
}
export const coerceMarker2 = coerceUpgradeResumeMarker;
// Absent means "nothing pending"; unreadable or unparseable means damage. The
// two must not collapse, because every write here is read-modify-write: a write
// built on a damaged read would overwrite the pending markers the file still
// holds. prompt-acceptance-ledger.ts sets the same precedent.
export function parseUpgradeResumeFile(
  raw: string | null,
): { entries: UpgradeResumeMarker[]; damaged: boolean } {
  if (raw == null) return { entries: [], damaged: false };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { entries: [], damaged: true };
  }
  if (typeof value !== "object" || value == null || !Array.isArray((value as { pending?: unknown }).pending)) {
    return { entries: [], damaged: true };
  }
  let damaged = false;
  const entries = ((value as { pending: unknown[] }).pending).flatMap((entry) => {
    const marker = coerceUpgradeResumeMarker(entry);
    if (marker == null) damaged = true;
    return marker == null ? [] : [marker];
  });
  return { entries, damaged };
}
export function upsertResumeMarker(
  existing: readonly UpgradeResumeMarker[],
  marker: UpgradeResumeMarker,
): UpgradeResumeMarker[] {
  return [
    ...existing.filter((entry) => entry.agentId !== marker.agentId),
    marker,
  ];
}
export class SandUpgradeResumeStore {
  readonly filePath: string;
  constructor(rootDir: string) {
    this.filePath = join(rootDir, SAND_UPGRADE_RESUME_FILE_NAME);
  }
  markPending(marker: UpgradeResumeMarker): void {
    const state = this.readState();
    // A damaged queue is quarantined rather than overwritten: the pending
    // markers it still holds are the only record of work that must resume.
    if (state.damaged) { quarantineDurableFile(this.filePath, "upgrade-resume: unreadable pending file"); return; }
    try {
      this.write(upsertResumeMarker(state.entries, marker));
    } catch {}
  }
  listPending(): UpgradeResumeMarker[] {
    return this.readState().entries;
  }
  clear(agentId: string): void {
    const state = this.readState();
    if (state.damaged) { quarantineDurableFile(this.filePath, "upgrade-resume: unreadable pending file"); return; }
    try {
      const remaining = state.entries.filter(
        (entry) => entry.agentId !== agentId,
      );
      remaining.length === 0 ? this.deleteFile() : this.write(remaining);
    } catch {}
  }
  clearAll(): void {
    this.deleteFile();
  }
  readPending(): UpgradeResumeMarker[] {
    return this.readState().entries;
  }
  readState(): { entries: UpgradeResumeMarker[]; damaged: boolean } {
    let raw: string | null;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      // Missing is not damage; any other read failure is.
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT") return { entries: [], damaged: false };
      writeDurableDegradedMarker(this.filePath, `upgrade-resume: read failed (${String(code ?? error)})`);
      return { entries: [], damaged: true };
    }
    const parsed = parseUpgradeResumeFile(raw);
    if (parsed.damaged) writeDurableDegradedMarker(this.filePath, "upgrade-resume: unparseable pending file");
    return parsed;
  }
  write(pending: readonly UpgradeResumeMarker[]): void {
    writeDurableEntries(this.filePath, { version: 1, pending });
  }
  deleteFile(): void {
    try {
      rmSync(this.filePath, { force: true });
    } catch {}
  }
}
