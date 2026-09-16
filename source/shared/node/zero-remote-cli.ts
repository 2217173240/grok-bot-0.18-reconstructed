import { readFileSync } from "node:fs";

import { checkZeroRemoteLedger } from "./zero-remote.js";

// CLI form of the zero-remote ledger check, bundled by
// scripts/zero-remote-check.mjs (the daemon-smoke pattern: one
// implementation, hermetic tests plus a live re-runnable command).
//
//   node zero-remote-check.cjs <ledger.jsonl> [first-line-1-based]
//
// Exit 0 = every cursor/xai mention in the scanned range is a blocked-fetch
// (blocked, zero egress); exit 1 prints each violation with its line number.
void (async () => {
  const ledgerPath = process.argv[2];
  const firstLine = Number.parseInt(process.argv[3] ?? "1", 10);
  if (ledgerPath == null || ledgerPath.length === 0 || !Number.isInteger(firstLine) || firstLine < 1) {
    console.error("usage: zero-remote-check.cjs <ledger.jsonl> [first-line-1-based]");
    process.exit(2);
  }
  const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(line => line.trim().length > 0);
  const scanned = lines.slice(firstLine - 1);
  const violations = checkZeroRemoteLedger(scanned);
  const blocked = scanned.filter(line => classifyIsBlockedFetch(line)).length;
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`ZERO-REMOTE VIOLATION line ${violation.line + firstLine - 1} kind=${violation.kind} ${violation.urlFields}: ${violation.excerpt}`);
    }
    process.exit(1);
  }
  console.log(`zero-remote OK: ${scanned.length} ledger lines scanned from line ${firstLine}; ${blocked} blocked-fetch mention(s) of cursor/xai domains, 0 egress observations`);
  process.exit(0);
})();

function classifyIsBlockedFetch(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { kind?: unknown };
    return parsed.kind === "blocked-fetch" && /cursor\.sh|cursor\.com|x\.ai|grok\.com/.test(line);
  } catch {
    return false;
  }
}
