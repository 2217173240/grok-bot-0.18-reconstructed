import { randomUUID } from "node:crypto";
import type { Context } from "../../packages/context/core.js";
import {
  shellExecutorResource,
  type ShellExecResponse,
  type ShellExecutor
} from "../../packages/agent-exec/shell.js";
import { SAND_BOX_PRIMARY_WINDOW_INDEX, SandBoxNoMonitorAvailableError, isPrimaryWindowIndex } from "../ports/box.js";
import { buildHostShellArgs } from "./box-shell-command.js";

export class SandBoxWindowError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "SandBoxWindowError"; } }
export const SAND_BOX_FORK_ROUTER_PORT = 1339;
export const SAND_BOX_DISPLAY_HEADER = "x-sand-display";
export const SAND_BOX_WINDOW_OWNER_HEADER = "x-sand-window-owner";
export const SAND_BOX_WINDOW_OWNER_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
export const SAND_BOX_WINDOW_UNAVAILABLE_EXIT_CODE = 75;
export function mintSandWindowOwnerToken(): string { return randomUUID(); }
export function envInt(name: string, fallback: number, env: Record<string, string | undefined> = process.env): number { const raw = env[name]; if (raw == null || !raw.trim()) return fallback; const value = Number.parseInt(raw.trim(), 10); return Number.isInteger(value) && value > 0 ? value : fallback; }
// The desktop container has a 4 GiB limit. Four active Chromium windows at
// roughly 800 MiB each leave headroom for the desktop and exec services.
// An environment override can lower the quota, but cannot exceed that budget.
export const SAND_BOX_MAX_WINDOWS = Math.min(4, envInt("SAND_BOX_MAX_WINDOWS", 4));
// The exec router selects a display by its index. This value is a route key,
// never a noVNC credential; noVNC gets a separate random TokenFile entry.
export function sandBoxDisplayToken(windowIndex: number): string { return String(windowIndex); }
export type ShellExecutionResult = ShellExecResponse;
export interface ShellAccessor { get(resource: typeof shellExecutorResource): ShellExecutor }
export async function runWindowScript(ctx: Context, accessor: ShellAccessor, label: string, windowIndex: number, options: { ownerToken?: string; reportGuardRefused?: (stage: string) => void } = {}): Promise<void> { if (isPrimaryWindowIndex(windowIndex)) { options.reportGuardRefused?.(label); return; } if (!Number.isInteger(windowIndex) || windowIndex < 2 || windowIndex > 65535 || (label === "start-window" && windowIndex > SAND_BOX_MAX_WINDOWS)) throw new SandBoxWindowError(`invalid window index ${windowIndex}`); const ownerToken = options.ownerToken; if (ownerToken != null && !SAND_BOX_WINDOW_OWNER_TOKEN_PATTERN.test(ownerToken)) throw new SandBoxWindowError(`refusing to run ${label} with a malformed owner token`); const command = ownerToken == null ? `/usr/local/bin/${label} ${windowIndex}` : `/usr/local/bin/${label} ${windowIndex} ${ownerToken}`; const result = await accessor.get(shellExecutorResource).execute(ctx, buildHostShellArgs({ command, name: label, workingDirectory: "/workspace", toolCallId: `sand-${label}` })); if (result.result.case !== "success") throw new SandBoxWindowError(`${label} failed (${result.result.case})`); const { exitCode, stderr } = result.result.value; if (exitCode === SAND_BOX_WINDOW_UNAVAILABLE_EXIT_CODE) throw new SandBoxNoMonitorAvailableError(`${label} could not claim display :${windowIndex}: it is a live fork owned by a different agent`); if (exitCode !== 0) throw new SandBoxWindowError(`${label} exited ${exitCode}: ${stderr}`); }
export async function runStartWindow(ctx: Context, accessor: ShellAccessor, windowIndex: number, ownerToken?: string): Promise<string> {
  if (!Number.isInteger(windowIndex) || windowIndex < 2 || windowIndex > SAND_BOX_MAX_WINDOWS) throw new SandBoxWindowError(`invalid window index ${windowIndex}`);
  if (ownerToken == null || !SAND_BOX_WINDOW_OWNER_TOKEN_PATTERN.test(ownerToken)) throw new SandBoxWindowError("refusing to start a fork without a valid owner token");
  // Serialize our start/stop calls for this display. Reject an occupied display
  // before touching its token. For a valid owner, revoke the old view token
  // before start-window can expose the new display, then mint inside the box.
  const command = [
    "set -eu",
    ". /usr/local/bin/box-common.sh",
    "umask 077",
    "mkdir -p \"$TOKEN_DIR\" \"$NOVNC_TOKEN_DIR\"",
    `exec 9>"$NOVNC_TOKEN_DIR/.fork-${windowIndex}.lock"`,
    "flock -x 9",
    "was_alive=0",
    `if [ -e "/tmp/.X11-unix/X${windowIndex}" ] && DISPLAY=:${windowIndex} xdpyinfo >/dev/null 2>&1; then was_alive=1; current="$(cat "$TOKEN_DIR/${windowIndex}" 2>/dev/null || true)"; if [ -z "$current" ] || [ "$current" != "${ownerToken}" ]; then exit 75; fi; fi`,
    `rm -f "$NOVNC_TOKEN_DIR/${windowIndex}"`,
    "temporary=",
    `trap 'rm -f "$NOVNC_TOKEN_DIR/${windowIndex}" "$temporary"; if [ "$was_alive" -eq 0 ]; then /usr/local/bin/stop-window ${windowIndex} 9>&- >/dev/null 2>&1 || true; fi' EXIT`,
    // Desktop daemons are children of start-window; do not let them inherit
    // the lock descriptor and hold it after the command returns.
    `/usr/local/bin/start-window ${windowIndex} ${ownerToken} 9>&-`,
    "token=\"$(od -An -N32 -tx1 /dev/urandom | tr -d ' \\n')\"",
    "[ \"${#token}\" -eq 64 ]",
    `temporary="$(mktemp "$NOVNC_TOKEN_DIR/.${windowIndex}.XXXXXXXX")"`,
    `printf '%s: localhost:%s\\n' "$token" "$((5900 + ${windowIndex}))" > "$temporary"`,
    "chmod 600 \"$temporary\"",
    `mv -f "$temporary" "$NOVNC_TOKEN_DIR/${windowIndex}"`,
    "trap - EXIT",
    "printf '%s' \"$token\"",
  ].join("; ");
  const result = await accessor.get(shellExecutorResource).execute(ctx, buildHostShellArgs({ command, name: "start-window", workingDirectory: "/workspace", toolCallId: "sand-start-window" }));
  if (result.result.case !== "success") throw new SandBoxWindowError(`start-window failed (${result.result.case})`);
  const { exitCode, stdout, stderr } = result.result.value;
  if (exitCode === SAND_BOX_WINDOW_UNAVAILABLE_EXIT_CODE) throw new SandBoxNoMonitorAvailableError(`start-window could not claim display :${windowIndex}: it is a live fork owned by a different agent`);
  if (exitCode !== 0) throw new SandBoxWindowError(`start-window exited ${exitCode}: ${stderr}`);
  const token = stdout.trim().match(/([a-f0-9]{64})$/)?.[1] ?? "";
  if (!/^[a-f0-9]{64}$/.test(token)) throw new SandBoxWindowError("noVNC token issuance returned an invalid credential");
  return token;
}
export async function runStopWindow(ctx: Context, accessor: ShellAccessor, windowIndex: number): Promise<void> {
  if (isPrimaryWindowIndex(windowIndex)) return;
  if (!Number.isInteger(windowIndex) || windowIndex < 2 || windowIndex > 65535) throw new SandBoxWindowError(`invalid window index ${windowIndex}`);
  const command = `set -eu; . /usr/local/bin/box-common.sh; umask 077; mkdir -p "$NOVNC_TOKEN_DIR"; exec 9>"$NOVNC_TOKEN_DIR/.fork-${windowIndex}.lock"; flock -x 9; /usr/local/bin/stop-window ${windowIndex} 9>&-`;
  const result = await accessor.get(shellExecutorResource).execute(ctx, buildHostShellArgs({ command, name: "stop-window", workingDirectory: "/workspace", toolCallId: "sand-stop-window" }));
  if (result.result.case !== "success") throw new SandBoxWindowError(`stop-window failed (${result.result.case})`);
  if (result.result.value.exitCode !== 0) throw new SandBoxWindowError(`stop-window exited ${result.result.value.exitCode}: ${result.result.value.stderr}`);
}
export async function touchSandMonitorBusyLease(ctx: Context, accessor: ShellAccessor, windowIndex: number): Promise<void> { if (!Number.isInteger(windowIndex) || windowIndex < 1) return; try { await accessor.get(shellExecutorResource).execute(ctx, buildHostShellArgs({ command: `touch /tmp/sand-monitor-busy-${windowIndex}`, name: "touch", workingDirectory: "/workspace", toolCallId: "sand-monitor-busy-lease" })); } catch {} }
export function sandBoxWindowKey(agentId: string, windowIndex: number): string { return `${agentId}#${windowIndex}`; }
export function clearAgentWindowConnections(connections: Map<string, unknown>, agentId: string): void { const prefix = `${agentId}#`; for (const key of connections.keys()) if (key.startsWith(prefix)) connections.delete(key); }
export function primarySandBoxWindow<T>(connection: { remoteAccessor: T; vncUrl: string }): { windowIndex: number; computerUse: T; vncUrl: string } { return { windowIndex: SAND_BOX_PRIMARY_WINDOW_INDEX, computerUse: connection.remoteAccessor, vncUrl: connection.vncUrl }; }
