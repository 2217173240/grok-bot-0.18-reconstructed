import { createHash } from "node:crypto";
import { localPerformanceRecordSchema, PERFORMANCE_COUNTS, PERFORMANCE_TIMINGS, type LocalPerformanceRecord } from "../local-performance-record.js";
import { isLocalAdminEnabled } from "./local-admin.js";
import { appendLocalIntercept } from "./local-admin-intercept.js";

export type { LocalPerformanceRecord } from "../local-performance-record.js";

export function localPerformanceCorrelationHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function appendLocalPerformance(record: LocalPerformanceRecord, env: NodeJS.ProcessEnv = process.env): void {
  if (!isLocalAdminEnabled(env) || env.SAND_DISABLE_TELEMETRY !== "1") return;
  // 调用者的额外属性不进入日志；只有这里明确列出的字段允许持久化。
  const candidate: Record<string, unknown> = {};
  for (const key of ["phase", "provider", "mode", "outcome", "correlationHash", "usageBasis", ...PERFORMANCE_TIMINGS, ...PERFORMANCE_COUNTS] as const) {
    if (record[key] !== undefined) candidate[key] = record[key];
  }
  const parsed = localPerformanceRecordSchema.safeParse(candidate);
  if (!parsed.success) throw new TypeError("Invalid local performance record.");
  appendLocalIntercept({ kind: "local-performance", schemaVersion: 1, ...parsed.data }, env);
}
