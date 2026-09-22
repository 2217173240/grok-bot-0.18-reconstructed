import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SAND_ACK_OBLIGATIONS_FILE_NAME } from "../../durable-file-policy.js";
import { quarantineDurableFile, readDurableFileSignature, writeDurableDegradedMarker, writeDurableEntries } from "./durable-store-file.js";
export interface AckObligation {
  agentId: string;
  createdAtMs: number;
  lastSendAtMs: number;
  lastInterruptAtMs?: number;
  coalescedCount: number;
  redriveAttempts: number;
}
export function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
export function coerceObligation(entry: unknown): AckObligation | null {
  if (typeof entry !== "object" || entry == null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.agentId !== "string" || !e.agentId) return null;
  const createdAtMs = finiteNumber(e.createdAtMs, 0);
  return {
    agentId: e.agentId,
    createdAtMs,
    lastSendAtMs: finiteNumber(e.lastSendAtMs, createdAtMs),
    ...(typeof e.lastInterruptAtMs === "number" &&
    Number.isFinite(e.lastInterruptAtMs)
      ? { lastInterruptAtMs: e.lastInterruptAtMs }
      : {}),
    coalescedCount: Math.max(1, finiteNumber(e.coalescedCount, 1)),
    redriveAttempts: Math.max(0, finiteNumber(e.redriveAttempts, 0)),
  };
}
// Absent means "nothing owed"; unreadable or unparseable means damage. Every
// write here is read-modify-write, so a damaged read treated as an empty list
// would overwrite the un-acked obligations the file still holds.
export function parseAckObligationsFile(
  raw: string | null,
): { entries: AckObligation[]; damaged: boolean } {
  if (raw == null) return { entries: [], damaged: false };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { entries: [], damaged: true };
  }
  if (typeof value !== "object" || value == null || !Array.isArray((value as { pending?: unknown }).pending)) {
    // Well-formed JSON with the wrong shape is damage too: the file exists and
    // claims to be this queue, so it must not read as "nothing owed".
    return { entries: [], damaged: true };
  }
  let damaged = false;
  const entries = ((value as { pending: unknown[] }).pending).flatMap((entry) => {
    const obligation = coerceObligation(entry);
    if (obligation == null) damaged = true;
    return obligation == null ? [] : [obligation];
  });
  return { entries, damaged };
}
export class SandAckObligationStore {
  readonly filePath: string;
  private cache: { entries: AckObligation[]; damaged: boolean } | null = null;
  private cacheSignature: string | null = null;
  constructor(rootDir: string) {
    this.filePath = join(rootDir, SAND_ACK_OBLIGATIONS_FILE_NAME);
  }
  get(agentId: string): AckObligation | undefined {
    return this.readPending().find((entry) => entry.agentId === agentId);
  }
  list(): AckObligation[] {
    return this.readPending();
  }
  recordSend(
    agentId: string,
    send: { atMs: number },
  ): { obligation: AckObligation; created: boolean } {
    const existing = this.get(agentId),
      obligation =
        existing == null
          ? {
              agentId,
              createdAtMs: send.atMs,
              lastSendAtMs: send.atMs,
              coalescedCount: 1,
              redriveAttempts: 0,
            }
          : {
              ...existing,
              lastSendAtMs: send.atMs,
              coalescedCount: existing.coalescedCount + 1,
            };
    this.upsert(obligation);
    return { obligation, created: existing == null };
  }
  recordInterrupt(agentId: string, atMs: number): void {
    const existing = this.get(agentId);
    if (existing != null) this.upsert({ ...existing, lastInterruptAtMs: atMs });
  }
  recordRedriveAttempt(agentId: string): AckObligation | undefined {
    const existing = this.get(agentId);
    if (existing == null) return undefined;
    const next = { ...existing, redriveAttempts: existing.redriveAttempts + 1 };
    this.upsert(next);
    return next;
  }
  clear(agentId: string): void {
    try {
      const current = this.readPending(),
        remaining = current.filter((entry) => entry.agentId !== agentId);
      if (remaining.length !== current.length) this.write(remaining);
    } catch {}
  }
  upsert(obligation: AckObligation): void {
    const state = this.readState();
    // Quarantine rather than overwrite: the un-acked obligations the file still
    // holds are the only record of messages the user never saw acknowledged.
    // The cache is dropped first so the next read observes the archived file
    // instead of replaying the damage forever.
    if (state.damaged) { this.cache = null; quarantineDurableFile(this.filePath, "ack-obligation: unreadable pending file"); return; }
    try {
      this.write([
        ...state.entries.filter(
          (entry) => entry.agentId !== obligation.agentId,
        ),
        obligation,
      ]);
    } catch {}
  }
  readPending(): AckObligation[] {
    return this.readState().entries;
  }
  readState(): { entries: AckObligation[]; damaged: boolean } {
    // The cache is only trustworthy while the file it came from is unchanged: a
    // cached "not damaged" must not survive the file being replaced underneath,
    // or a later read-modify-write would rebuild it from a stale empty base.
    const signature = readDurableFileSignature(this.filePath);
    if (this.cache != null && this.cacheSignature === signature) return this.cache;
    if (signature == null) {
      this.cache = { entries: [], damaged: false };
      this.cacheSignature = signature;
      return this.cache;
    }
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      writeDurableDegradedMarker(this.filePath, `ack-obligation: read failed (${String(code ?? error)})`);
      this.cache = { entries: [], damaged: true };
      this.cacheSignature = signature;
      return this.cache;
    }
    const parsed = parseAckObligationsFile(raw);
    if (parsed.damaged) writeDurableDegradedMarker(this.filePath, "ack-obligation: unparseable pending file");
    this.cache = parsed;
    this.cacheSignature = signature;
    return this.cache;
  }
  write(pending: readonly AckObligation[]): void {
    writeDurableEntries(this.filePath, { version: 1, pending });
    this.cache = { entries: [...pending], damaged: false };
    this.cacheSignature = readDurableFileSignature(this.filePath);
  }
}
