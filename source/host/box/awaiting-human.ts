import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { appendLocalIntercept } from "../../shared/node/local-admin-intercept.js";

// awaiting_human — the human-handoff state machine (slice C1), Archive's
// screens.mjs semantics transplanted onto this topology: the state lives in
// the in-box host process, the ask/hand-back contract is the same file idiom
// as novnc-url (/workspace/.grokbot/…), and the deadline runs SERVER-SIDE so
// it holds even if the caller never comes back.
//
// Contract files under <root> (= /workspace/.grokbot in the box):
//   ask-human.json  {"reason":"auth"|"captcha"|"payment"|"other",
//                    "instruction":string}   — presence means awaiting
//   novnc-url       the takeover URL (re-minted each container boot)
// Hand-back = the ask file disappearing (the agent's Mac-side tools share
// the directory and can remove it once the human is done; the timeout is
// the honest fallback when nobody comes back).
export const AWAITING_HUMAN_ASK_FILE = "ask-human.json";
export const AWAITING_HUMAN_URL_FILE = "novnc-url";
export const AWAITING_HUMAN_REASONS = ["auth", "captcha", "payment", "other"] as const;
export type AwaitingHumanReason = typeof AWAITING_HUMAN_REASONS[number];
export const AWAITING_HUMAN_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export class BoxAwaitingHumanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoxAwaitingHumanError";
  }
}

export interface AwaitingHumanSnapshot {
  readonly awaiting: boolean;
  readonly reason?: AwaitingHumanReason;
  readonly instruction?: string;
  /** ms until the server-side deadline (negative = expired pending reap). */
  readonly remainingMs?: number;
}

export interface AwaitingHumanState {
  poll(): Promise<void>;
  snapshot(): AwaitingHumanSnapshot;
  /** Throws while awaiting — the gate every box-facing executor passes through. */
  assertNotAwaiting(operation: string): void;
  stop(): void;
}

function timeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.SAND_AWAITING_HUMAN_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : AWAITING_HUMAN_DEFAULT_TIMEOUT_MS;
}

export function parseAwaitingHumanAsk(text: string): { reason: AwaitingHumanReason; instruction: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("ask-human.json is not valid JSON: expected {\"reason\":\"auth|captcha|payment|other\",\"instruction\":\"…\"}");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("ask-human.json must be an object");
  const reason = Reflect.get(parsed, "reason");
  const instruction = Reflect.get(parsed, "instruction");
  if (typeof reason !== "string" || !(AWAITING_HUMAN_REASONS as readonly string[]).includes(reason)) {
    throw new Error(`ask-human.json reason must be one of ${AWAITING_HUMAN_REASONS.join("|")}`);
  }
  if (typeof instruction !== "string" || instruction.trim().length === 0) throw new Error("ask-human.json instruction must be a non-empty string");
  return { reason: reason as AwaitingHumanReason, instruction };
}

export function createAwaitingHumanState(options: {
  readonly root: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
}): AwaitingHumanState {
  const { root } = options;
  const now = options.now ?? Date.now;
  const timeoutMs = timeoutMsFromEnv(options.env);
  const askPath = join(root, AWAITING_HUMAN_ASK_FILE);
  const urlPath = join(root, AWAITING_HUMAN_URL_FILE);
  let deadlineMs: number | undefined;
  let reason: AwaitingHumanReason | undefined;
  let instruction: string | undefined;
  let stopped = false;

  const reap = async (): Promise<void> => {
    // The honest repossession: the deadline passed server-side, so the box
    // returns itself and the record says so.
    appendLocalIntercept({ kind: "awaiting-human", event: "timeout", reason: reason ?? "unknown", waitedMs: timeoutMs });
    deadlineMs = undefined;
    reason = undefined;
    instruction = undefined;
    await rm(askPath, { force: true }).catch(() => undefined);
  };

  const poll = async (): Promise<void> => {
    let text: string | undefined;
    try {
      text = await readFile(askPath, "utf8");
    } catch {
      // No ask file: handed back (or never asked). If we were awaiting, the
      // hand-back is worth recording; the timer dies with the state.
      if (deadlineMs != null) {
        appendLocalIntercept({ kind: "awaiting-human", event: "hand-back", reason: reason ?? "unknown", waitedMs: timeoutMs - Math.max(0, deadlineMs - now()) });
      }
      deadlineMs = undefined;
      reason = undefined;
      instruction = undefined;
      return;
    }
    try {
      const ask = parseAwaitingHumanAsk(text);
      if (deadlineMs == null) {
        // A new ask starts the clock; a REPEATED ask while awaiting must NOT
        // reset it (ask_human idempotence, Archive semantics).
        deadlineMs = now() + timeoutMs;
        appendLocalIntercept({ kind: "awaiting-human", event: "ask", reason: ask.reason, instruction: ask.instruction.slice(0, 200), timeoutMs });
      }
      reason = ask.reason;
      instruction = ask.instruction;
    } catch (error) {
      // A malformed ask is surfaced, never silently treated as "not asking":
      // the gate engages in reason-less mode so the box cannot act past a
      // broken handoff request.
      if (deadlineMs == null) {
        deadlineMs = now() + timeoutMs;
        appendLocalIntercept({ kind: "awaiting-human", event: "ask-malformed", error: error instanceof Error ? error.message : String(error) });
      }
      reason = undefined;
      instruction = undefined;
    }
    if (deadlineMs != null && now() >= deadlineMs) await reap();
  };

  const timer = setInterval(() => {
    if (!stopped) void poll();
  }, options.pollIntervalMs ?? 2_000);
  timer.unref?.();

  const snapshot = (): AwaitingHumanSnapshot => deadlineMs == null
    ? { awaiting: false }
    : {
        awaiting: true,
        ...(reason == null ? {} : { reason }),
        ...(instruction == null ? {} : { instruction }),
        remainingMs: deadlineMs - now(),
      };

  const assertNotAwaiting = (operation: string): void => {
    if (deadlineMs == null) return;
    const remainingSeconds = Math.max(0, Math.round((deadlineMs - now()) / 1000));
    throw new BoxAwaitingHumanError(
      `The box is awaiting a human handoff (${reason ?? "malformed ask"}): ${operation} is blocked for the remaining ${remainingSeconds}s. `
      + `The human takes over at the noVNC URL in ${AWAITING_HUMAN_URL_FILE}; hand back by removing ${AWAITING_HUMAN_ASK_FILE}, `
      + `or the box honestly reclaims itself when the deadline passes. If the takeover URL no longer opens, the container restarted and re-minted the token — ask again for a fresh URL.`,
    );
  };

  void stat(urlPath).catch(() => undefined);

  return {
    poll,
    snapshot,
    assertNotAwaiting,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
