import { isCursorProductionBackendUrl } from "./local-admin.js";

// The zero-remote ledger classifier: the standing proof that local-admin
// operation never leaks a cursor/xai request. The claim is scoped to
// egress-shaped fields (url/baseUrl/backendUrl) — a record that names a
// cursor/xai endpoint in a URL field is an observation of a remote call.
// Such a record is legal in exactly one shape: kind "blocked-fetch", the
// fetch interceptor catching the attempt (zero bytes left the machine).
//
// Deliberately NOT a text scan: audit fields routinely carry domain names as
// TEXT — an agent's shell command strings, container log tails inside error
// messages. Those are not egress claims by the app, and flagging them would
// make the gate noisy enough to ignore. Network-level independence is
// proven separately (the graduation run blocks the domains outright).
export interface ZeroRemoteViolation {
  readonly line: number;
  readonly kind: string;
  readonly urlFields: string;
  readonly excerpt: string;
}

const URL_FIELDS = ["url", "baseUrl", "backendUrl", "endpoint"] as const;

export function cursorRemoteUrlFieldsOf(record: Record<string, unknown>): string[] {
  const hits: string[] = [];
  for (const field of URL_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && isCursorProductionBackendUrl(value)) hits.push(`${field}=${value}`);
  }
  return hits;
}

export function classifyZeroRemoteLedgerLine(lineNumber: number, line: string): ZeroRemoteViolation | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // An unparsable line is not an egress observation; leave it to the
    // ledger's own integrity, not this classifier.
    return null;
  }
  const urlFields = cursorRemoteUrlFieldsOf(parsed);
  if (urlFields.length === 0) return null;
  const kind = typeof parsed.kind === "string" ? parsed.kind : "(missing kind)";
  if (kind === "blocked-fetch") return null;
  return { line: lineNumber, kind, urlFields: urlFields.join(","), excerpt: line.slice(0, 200) };
}

export function checkZeroRemoteLedger(lines: readonly string[]): ZeroRemoteViolation[] {
  const violations: ZeroRemoteViolation[] = [];
  for (const [index, line] of lines.entries()) {
    const violation = classifyZeroRemoteLedgerLine(index + 1, line ?? "");
    if (violation != null) violations.push(violation);
  }
  return violations;
}
