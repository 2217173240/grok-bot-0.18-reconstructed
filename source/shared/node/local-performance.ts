import { createHash } from "node:crypto";
import { appendLocalIntercept } from "./local-admin-intercept.js";

const PHASES = new Set(["provider"]);
const OUTCOMES = new Set(["success", "failed", "cancelled"]);

export interface LocalPerformanceRecord {
  readonly phase: "provider";
  readonly provider: string;
  readonly mode: "text-only" | "hosted";
  readonly outcome: "success" | "failed" | "cancelled";
  readonly durationMs: number;
  readonly spawnMs?: number;
  readonly dispatchMs?: number;
  readonly firstTextMs?: number;
  readonly cleanupMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly correlationHash: string;
}

function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }

export function localPerformanceCorrelationHash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 16); }

export function appendLocalPerformance(record: LocalPerformanceRecord, env: NodeJS.ProcessEnv = process.env): void {
  if (env.SAND_DISABLE_TELEMETRY !== "1") return;
  if (!PHASES.has(record.phase) || !OUTCOMES.has(record.outcome) || !["text-only", "hosted"].includes(record.mode)
    || typeof record.provider !== "string" || !finite(record.durationMs) || typeof record.correlationHash !== "string" || !/^[0-9a-f]{16}$/.test(record.correlationHash)) throw new TypeError("Invalid local performance record.");
  for (const value of [record.spawnMs, record.dispatchMs, record.firstTextMs, record.cleanupMs, record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheWriteTokens]) if (value !== undefined && !finite(value)) throw new TypeError("Invalid local performance metric.");
  appendLocalIntercept({ kind: "local-performance", ...record }, env);
}
