import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { localPerformanceLedgerSchema, PERFORMANCE_COUNTS, PERFORMANCE_TIMINGS } from "../source/shared/local-performance-record.ts";

const paths = process.argv.slice(2);
if (paths.length === 0) throw new Error("Usage: node scripts/summarize-local-performance.mjs <local-intercept.jsonl> [...files]");
const groups = new Map();
let records = 0;
let ignoredRecords = 0;
for (const [fileIndex, path] of paths.entries()) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (line.trim().length === 0) continue;
    let value;
    try { value = JSON.parse(line); }
    catch { throw new Error(`Invalid JSON in input ${fileIndex + 1}, line ${lineNumber}.`); }
    if (value?.kind !== "local-performance") { ignoredRecords++; continue; }
    const parsed = localPerformanceLedgerSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid local-performance record in input ${fileIndex + 1}, line ${lineNumber}.`);
    const row = parsed.data;
    const attributes = { phase: row.phase, provider: row.provider ?? null, mode: row.mode ?? null, outcome: row.outcome, usageBasis: row.usageBasis ?? null };
    const key = JSON.stringify(attributes);
    const group = groups.get(key) ?? { attributes, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
    records++;
  }
}

function total(values) {
  if (values.length === 0) return null;
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result)) throw new Error("Performance token total exceeds the supported integer range.");
  return result;
}

function timingSummary(values) {
  values.sort((a, b) => a - b);
  const percentile = fraction => values.length === 0 ? null : values[Math.ceil(values.length * fraction) - 1];
  return { count: values.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

function inputTotal(row) {
  if (row.inputTokens === undefined) return undefined;
  if (row.usageBasis === "inclusive-input") return row.inputTokens;
  if (row.usageBasis === "exclusive-input" && row.cacheReadTokens !== undefined && row.cacheWriteTokens !== undefined) {
    const value = row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens;
    if (!Number.isSafeInteger(value)) throw new Error("Performance input token count exceeds the supported integer range.");
    return value;
  }
  return undefined;
}

function cacheSummary(rows, field) {
  const comparable = rows.filter(row => row[field] !== undefined && inputTotal(row) !== undefined);
  const numerator = total(comparable.map(row => row[field]));
  const denominator = total(comparable.map(inputTotal));
  if (numerator !== null && numerator > denominator) throw new Error("Performance cache count exceeds its input token count.");
  return { count: comparable.length, numerator, denominator, ratio: denominator !== null && denominator > 0 ? numerator / denominator : null };
}

const summary = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, { attributes, rows }]) => {
  const tokenFields = PERFORMANCE_COUNTS.filter(field => field !== "toolCount");
  const inputs = rows.map(inputTotal).filter(value => value !== undefined);
  return {
    ...attributes,
    count: rows.length,
    timings: Object.fromEntries(PERFORMANCE_TIMINGS.map(field => [field, timingSummary(rows.flatMap(row => row[field] === undefined ? [] : [row[field]]))])),
    counts: Object.fromEntries(PERFORMANCE_COUNTS.map(field => {
      const values = rows.flatMap(row => row[field] === undefined ? [] : [row[field]]);
      return [field, { count: values.length, total: total(values) }];
    })),
    usage: {
      rows: rows.filter(row => tokenFields.some(field => row[field] !== undefined)).length,
      totalInput: { count: inputs.length, total: total(inputs) },
      cacheRead: cacheSummary(rows, "cacheReadTokens"),
      cacheWrite: cacheSummary(rows, "cacheWriteTokens"),
    },
  };
});
console.log(JSON.stringify({ schemaVersion: 1, quantileMethod: "nearest-rank", records, ignoredRecords, groups: summary }, null, 2));
