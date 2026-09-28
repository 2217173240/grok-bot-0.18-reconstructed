import { z } from "zod";

export const PERFORMANCE_TIMINGS = ["durationMs", "spawnMs", "dispatchMs", "firstOutputMs", "firstTextMs", "cleanupMs", "cancelCleanupMs", "processCloseMs", "bridgeCloseMs", "permissionDecisionMs"] as const;
export const PERFORMANCE_COUNTS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "toolCount"] as const;
const timing = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = timing.int();

export const localPerformanceRecordSchema = z.object({
  phase: z.enum(["provider", "queue", "dispatch", "ttft", "classifier", "approval", "tool", "tool-bridge", "delivery", "turn"]),
  provider: z.enum(["claude-code", "codex", "openrouter", "command-code"]).optional(),
  mode: z.enum(["text-only", "hosted", "unhosted"]).optional(),
  outcome: z.enum(["success", "failed", "cancelled", "observed", "pending", "approved", "denied", "expired", "dismissed"]),
  correlationHash: z.string().regex(/^[a-f0-9]{16}$/).optional(),
  usageBasis: z.enum(["exclusive-input", "inclusive-input"]).optional(),
  durationMs: timing,
  spawnMs: timing.optional(),
  dispatchMs: timing.optional(),
  firstOutputMs: timing.optional(),
  firstTextMs: timing.optional(),
  cleanupMs: timing.optional(),
  cancelCleanupMs: timing.optional(),
  processCloseMs: timing.optional(),
  bridgeCloseMs: timing.optional(),
  permissionDecisionMs: timing.optional(),
  inputTokens: count.optional(),
  outputTokens: count.optional(),
  cacheReadTokens: count.optional(),
  cacheWriteTokens: count.optional(),
  toolCount: count.optional(),
}).strict();

export const localPerformanceLedgerSchema = localPerformanceRecordSchema.extend({
  kind: z.literal("local-performance"),
  schemaVersion: z.literal(1),
  at: z.string().datetime({ offset: true }),
}).strict();

export type LocalPerformanceRecord = z.infer<typeof localPerformanceRecordSchema>;
