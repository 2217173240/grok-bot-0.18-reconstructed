import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isCursorProductionBackendUrl, isLocalAdminEnabled } from "./local-admin.js";

// The ledger is a diagnostic surface, not a database: keep it bounded. When it
// outgrows the cap, rewrite it with the most recent lines; heartbeat events
// are sampled down to one per window.
const INTERCEPT_LOG_MAX_BYTES = 2_000_000;
const INTERCEPT_LOG_KEEP_BYTES = 512_000;
const HEARTBEAT_KINDS = new Set(["already-ready"]);
const HEARTBEAT_MIN_INTERVAL_MS = 60_000;
const LOCAL_ADMIN_INTERCEPT_INSTALLED = Symbol.for("grokbot.local-admin-intercept-installed");
let lastHeartbeatAtMs = 0;

export function localInterceptLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SAND_DATA_ROOT?.trim() || join(homedir(), ".grokbot");
  return join(root, "local-intercept.jsonl");
}

function rotateIfNeeded(path: string): void {
  let size: number;
  try { size = statSync(path).size; } catch { return; }
  if (size <= INTERCEPT_LOG_MAX_BYTES) return;
  let contents: string;
  try { contents = readFileSync(path, "utf8"); } catch { return; }
  const tail = contents.slice(Math.max(0, contents.length - INTERCEPT_LOG_KEEP_BYTES));
  const firstLineBreak = tail.indexOf("\n");
  const kept = firstLineBreak >= 0 ? tail.slice(firstLineBreak + 1) : tail;
  try {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, kept.endsWith("\n") || kept.length === 0 ? kept : `${kept}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch {}
}

// The ledger records tool traffic; anything the agent types into the box's
// desktop (XTEST payloads) may be a credential the user handed it despite the
// handoff design. Redact the typed values in the RECORDED copy only — the
// executed command is untouched. Passwords typed char-by-char via key
// presses are covered too (Archive's "press loophole" fix).
export function redactTypedDesktopInput(command: string): string {
  if (!command.includes("xtest-input")) return command;
  return command
    .replace(/("text"\s*:\s*")((?:\\.|[^"\\])*)(")/g, (_all, head: string, value: string, tail: string) => `${head}<redacted ${value.length} chars>${tail}`)
    .replace(/('text'\s*:\s*')([^']*)(')/g, (_all, head: string, value: string, tail: string) => `${head}<redacted ${value.length} chars>${tail}`)
    .replace(/("key"\s*:\s*")((?:\\.|[^"\\])*)(")/g, (_all, head: string, value: string, tail: string) => `${head}<redacted>${tail}`);
}

function ensureLedgerPermissions(path: string): void {
  // One stat per record — cheap enough, and a ledger loosened after the
  // first append (restore, manual edit) must still be tightened.
  try {
    const mode = statSync(path).mode;
    if ((mode & 0o077) !== 0) chmodSync(path, 0o600);
  } catch {}
}

export function appendLocalIntercept(record: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv = process.env): void {
  if (record.kind === "local-host" && HEARTBEAT_KINDS.has(String(record.event))) {
    const now = Date.now();
    if (now - lastHeartbeatAtMs < HEARTBEAT_MIN_INTERVAL_MS) return;
    lastHeartbeatAtMs = now;
  }
  const path = localInterceptLogPath(env);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
  ensureLedgerPermissions(path);
  rotateIfNeeded(path);
}

export function installLocalAdminNetworkIntercept(env: NodeJS.ProcessEnv = process.env): void {
  if (!isLocalAdminEnabled(env)) return;
  const current = globalThis.fetch as typeof fetch & { [LOCAL_ADMIN_INTERCEPT_INSTALLED]?: boolean };
  if (current[LOCAL_ADMIN_INTERCEPT_INSTALLED] === true) return;
  const original = globalThis.fetch.bind(globalThis);
  const intercepted = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String((input as Request).url);
    if (isCursorProductionBackendUrl(url)) {
      appendLocalIntercept({ kind: "blocked-fetch", url, method: init?.method ?? "GET" }, env);
      throw new Error(`SAND_LOCAL_ADMIN blocked fetch ${url}`);
    }
    return await original(input, init);
  }) as typeof fetch & { [LOCAL_ADMIN_INTERCEPT_INSTALLED]?: boolean };
  intercepted[LOCAL_ADMIN_INTERCEPT_INSTALLED] = true;
  globalThis.fetch = intercepted;
}
