import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (path == null || path.length === 0) throw new Error("Usage: node scripts/summarize-local-performance.mjs <local-intercept.jsonl>");
const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
const rows = [];
for (const line of lines) {
  const value = JSON.parse(line);
  if (value.kind !== "local-performance") continue;
  if (value.phase !== "provider" || !["success", "failed", "cancelled"].includes(value.outcome) || !Number.isFinite(value.durationMs)) throw new Error("Invalid local-performance record.");
  rows.push(value);
}
const percentile = (values, fraction) => { if (values.length === 0) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]; };
const groups = new Map();
for (const row of rows) { const key = [row.provider, row.mode, row.outcome].join("/"); const group = groups.get(key) ?? { provider: row.provider, mode: row.mode, outcome: row.outcome, durations: [], inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usageRows: 0 }; group.durations.push(row.durationMs); for (const field of ["inputTokens", "cacheReadTokens", "cacheWriteTokens"]) if (typeof row[field] === "number") group[field] += row[field]; if (["inputTokens", "cacheReadTokens", "cacheWriteTokens"].every(field => typeof row[field] === "number")) group.usageRows += 1; groups.set(key, group); }
console.log(JSON.stringify([...groups.values()].map(group => ({ provider: group.provider, mode: group.mode, outcome: group.outcome, count: group.durations.length, p50Ms: percentile(group.durations, .5), p95Ms: percentile(group.durations, .95), usageRows: group.usageRows, inputTokens: group.inputTokens, cacheReadTokens: group.cacheReadTokens, cacheWriteTokens: group.cacheWriteTokens, totalInputTokens: group.inputTokens + group.cacheReadTokens + group.cacheWriteTokens })), null, 2));
