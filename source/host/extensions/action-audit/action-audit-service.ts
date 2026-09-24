import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { PollingPolicy } from "../../../internal/scheduling.js";
import { getConnectRetryAfterMs, isRateLimitConnectError } from "../../../shared/connect-errors.js";
import { errorLogTag } from "../../../shared/errors.js";
import { getSandAgentsRootDir, resolveSandAgentDir } from "../../storage/agent-paths.js";

export const ACTION_AUDIT_FLUSH_INTERVAL_MS = 5_000;
export const MAX_AUDIT_BATCH_SIZE = 50;
export const MAX_PENDING_AUDIT_EVENTS = 2_000;
export const AUDIT_FLUSH_FAILURE_BACKOFF_MS = 30_000;

export function flushFailureBackoffMs(error: unknown, nowMs: number): number {
  return isRateLimitConnectError(error)
    ? Math.max(getConnectRetryAfterMs(error, nowMs) ?? 0, AUDIT_FLUSH_FAILURE_BACKOFF_MS)
    : AUDIT_FLUSH_FAILURE_BACKOFF_MS;
}

const nonNegativeNumber = z.number().finite().nonnegative();
const auditActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mcpToolCall"), toolCallId: z.string(), serverIdentifier: z.string(),
    serverName: z.string().optional(), toolName: z.string(), transport: z.string(),
    status: z.string(), durationMs: nonNegativeNumber
  }),
  z.object({
    kind: z.literal("shellCommand"), command: z.string(), shellKind: z.string(), target: z.string(),
    allowed: z.boolean().optional(), blockedReason: z.string().optional(),
    classificationReasons: z.array(z.string()).optional()
  }),
  z.object({ kind: z.literal("browserNavigation"), url: z.string(), pageTitle: z.string() }),
  z.object({
    kind: z.literal("computerUseSession"), toolCallId: z.string().optional(),
    actionCount: nonNegativeNumber, actionCounts: z.record(nonNegativeNumber),
    durationMs: nonNegativeNumber, screenshotCount: nonNegativeNumber
  })
]);
const auditEventSchema = z.object({
  eventId: z.string().min(1), occurredAtMs: nonNegativeNumber, agentId: z.string(),
  turnId: z.string(), boxId: z.string(), action: auditActionSchema
});

export type AuditAction = z.infer<typeof auditActionSchema>;
export interface AuditRecord {
  readonly occurredAtMs: number;
  readonly agentId: string;
  readonly turnId?: string;
  readonly boxId?: string;
  readonly action: AuditAction;
}
export interface AuditEvent extends AuditRecord {
  readonly eventId: string;
  readonly turnId: string;
  readonly boxId: string;
}

export function isBackendForwardable(record: AuditRecord): boolean {
  return record.action.kind !== "mcpToolCall" || record.action.transport === "stdio";
}

export function localAuditJsonlLine(record: AuditRecord, eventId: string): string {
  const action = record.action;
  const base = {
    ts: new Date(record.occurredAtMs).toISOString(), agentId: record.agentId, eventId,
    ...(record.turnId ? { turnId: record.turnId } : {})
  };
  switch (action.kind) {
    case "mcpToolCall":
      return `${JSON.stringify({ ...base, type: "mcp_tool_call", serverIdentifier: action.serverIdentifier, toolName: action.toolName, toolCallId: action.toolCallId, transport: action.transport, status: action.status, durationMs: action.durationMs })}\n`;
    case "browserNavigation":
      return `${JSON.stringify({ ...base, type: "browser_navigation", url: action.url, pageTitle: action.pageTitle })}\n`;
    case "computerUseSession":
      return `${JSON.stringify({ ...base, type: "computer_use_session", toolCallId: action.toolCallId ?? "", actionCount: action.actionCount, actionCounts: action.actionCounts, durationMs: action.durationMs, screenshotCount: action.screenshotCount })}\n`;
    case "shellCommand":
      return `${JSON.stringify({ ...base, type: "shell_command", command: action.command, shellKind: action.shellKind, target: action.target })}\n`;
  }
}

export function createSandActionAuditor(deps: {
  readonly isBackendForwardingEnabled: () => boolean | Promise<boolean>;
  readonly sendBatch: (events: readonly AuditEvent[]) => Promise<void>;
  readonly flushPolicy: PollingPolicy;
  readonly report?: (diagnostic: unknown) => void;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly outboxPath?: string;
  readonly auditPath?: (agentId: string) => string;
  readonly appendLocalLine?: (path: string, line: string) => Promise<void>;
}) {
  const now = deps.now ?? Date.now;
  const outbox = deps.outboxPath ?? join(getSandAgentsRootDir(), "audit-outbox.json");
  const auditPath = deps.auditPath ?? ((id) => join(resolveSandAgentDir(id), "audit.jsonl"));
  const report = (diagnostic: Record<string, unknown>) => deps.report?.({ extension: "action_audit", ...diagnostic });
  const append = deps.appendLocalLine ?? (async (path, line) => {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.appendFile(path, line, "utf8");
  });
  let pending: AuditEvent[] = [];
  let loadPromise: Promise<void> | undefined;
  let flushInFlight: Promise<void> | undefined;
  let localWriteTail = Promise.resolve();
  let backendRecordTail = Promise.resolve();
  let acceptingRecords = true;
  let backoffUntilMs = 0;
  let capacityReported = false;
  let disposePromise: Promise<void> | undefined;

  const checkCapacity = () => {
    if (pending.length > MAX_PENDING_AUDIT_EVENTS) {
      if (!capacityReported) report({ event: "outbox_capacity_exceeded", pendingCount: pending.length, capacity: MAX_PENDING_AUDIT_EVENTS });
      capacityReported = true;
    } else {
      capacityReported = false;
    }
  };
  const load = () => loadPromise ??= (async () => {
    try {
      const stored = z.array(auditEventSchema).parse(JSON.parse(await fs.readFile(outbox, "utf8")));
      pending = [...stored, ...pending];
      checkCapacity();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      report({ event: "outbox_load_failed", errorClass: errorLogTag(error) });
      throw error;
    }
  })();
  const persist = async () => {
    await load();
    let temp: string | undefined;
    try {
      if (pending.length === 0) {
        await fs.rm(outbox, { force: true });
        return;
      }
      await fs.mkdir(dirname(outbox), { recursive: true });
      temp = `${outbox}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temp, JSON.stringify(pending), "utf8");
      await fs.rename(temp, outbox);
    } catch (error) {
      report({ event: "outbox_persist_failed", errorClass: errorLogTag(error) });
      throw error;
    } finally {
      if (temp != null) {
        await fs.rm(temp, { force: true }).catch((error) => {
          report({ event: "outbox_temp_cleanup_failed", errorClass: errorLogTag(error) });
        });
      }
    }
  };
  const runFlush = async () => {
    await load();
    await backendRecordTail;
    await persist();
    if (now() < backoffUntilMs) return;
    try {
      if (!await deps.isBackendForwardingEnabled()) return;
      while (pending.length > 0) {
        const batch = pending.slice(0, MAX_AUDIT_BATCH_SIZE);
        await deps.sendBatch(batch);
        pending.splice(0, batch.length);
        checkCapacity();
      }
    } catch (error) {
      backoffUntilMs = now() + flushFailureBackoffMs(error, now());
      report({ event: "outbox_flush_failed", errorClass: errorLogTag(error) });
    }
    await persist();
  };
  const flushOnce = () => {
    if (flushInFlight != null) return flushInFlight;
    const flush = runFlush().finally(() => {
      if (flushInFlight === flush) flushInFlight = undefined;
    });
    flushInFlight = flush;
    return flush;
  };
  let initial = true;
  const polling = deps.flushPolicy.start(async () => {
    if (initial) { initial = false; return; }
    await flushOnce();
  });
  const auditor = {
    record(record: AuditRecord) {
      if (!acceptingRecords) return;
      const eventId = deps.randomId?.() ?? crypto.randomUUID();
      const line = localAuditJsonlLine(record, eventId);
      localWriteTail = localWriteTail.then(() => append(auditPath(record.agentId), line)).catch((error) => {
        report({ event: "local_jsonl_write_failed", errorClass: errorLogTag(error) });
      });
      if (!isBackendForwardable(record)) return;
      const event: AuditEvent = { ...record, eventId, turnId: record.turnId ?? "", boxId: record.boxId ?? "" };
      backendRecordTail = backendRecordTail.then(async () => {
        if (!await deps.isBackendForwardingEnabled()) return;
        pending.push(event);
        checkCapacity();
      }).catch((error) => {
        report({ event: "backend_gate_failed", errorClass: errorLogTag(error) });
      });
    }
  };
  const dispose = () => disposePromise ??= (async () => {
    acceptingRecords = false;
    polling.dispose();
    await Promise.all([localWriteTail, backendRecordTail]);
    if (flushInFlight != null) await flushInFlight;
    await flushOnce();
  })();
  return { auditor, dispose, flush: () => disposePromise ?? flushOnce() };
}
