import { createHash } from "node:crypto";
import { appendLocalIntercept } from "./local-admin-intercept.js";
import { isLocalAdminEnabled } from "./local-admin.js";

const PROVIDERS = new Set(["claude-code", "codex", "openrouter", "command-code"]);
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
  if (env.SAND_DISABLE_TELEMETRY !== "1" || !isLocalAdminEnabled(env)) return;
  if (record.phase !== "provider" || !OUTCOMES.has(record.outcome) || !["text-only", "hosted"].includes(record.mode)
    || !PROVIDERS.has(record.provider) || !finite(record.durationMs) || !/^[0-9a-f]{16}$/.test(record.correlationHash)) throw new TypeError("Invalid local performance record.");
  const values = [record.spawnMs, record.dispatchMs, record.firstTextMs, record.cleanupMs, record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheWriteTokens];
  if (values.some(value => value !== undefined && !finite(value))) throw new TypeError("Invalid local performance metric.");
  appendLocalIntercept({ kind: "local-performance", phase: record.phase, provider: record.provider, mode: record.mode, outcome: record.outcome, durationMs: record.durationMs, ...(record.spawnMs === undefined ? {} : { spawnMs: record.spawnMs }), ...(record.dispatchMs === undefined ? {} : { dispatchMs: record.dispatchMs }), ...(record.firstTextMs === undefined ? {} : { firstTextMs: record.firstTextMs }), ...(record.cleanupMs === undefined ? {} : { cleanupMs: record.cleanupMs }), ...(record.inputTokens === undefined ? {} : { inputTokens: record.inputTokens }), ...(record.outputTokens === undefined ? {} : { outputTokens: record.outputTokens }), ...(record.cacheReadTokens === undefined ? {} : { cacheReadTokens: record.cacheReadTokens }), ...(record.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: record.cacheWriteTokens }), correlationHash: record.correlationHash }, env);
}
