import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { LocalExecProcessAdapter, LocalExecProcessIdentity, ProcessIdentityReadOptions, ProcessTerminateOptions } from "./local-exec-process-types.js";

const execFileAsync = promisify(execFile);
function validatePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new RangeError(`Invalid local-exec process ID: ${pid}`);
}

export function parsePosixProcessIdentity(pid: number, output: string): LocalExecProcessIdentity | null {
  const match = /^(\S{3}\s+\S{3}\s+[ 0-9]\d\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(output.trim());
  const started = match?.[1];
  if (started == null) return null;
  const startEpochMs = Date.parse(started);
  const command = match?.[2]?.trim() ?? "";
  return Number.isFinite(startEpochMs) && command.length > 0 ? { pid, startEpochMs, command } : null;
}

async function readIdentity(pid: number, options: ProcessIdentityReadOptions = {}): Promise<LocalExecProcessIdentity | null> {
  validatePid(pid);
  options.signal?.throwIfAborted();
  let output: string;
  try {
    const pending = execFileAsync("ps", ["-p", String(pid), "-o", "state=", "-o", "lstart=", "-o", "command="], { encoding: "utf8", timeout: 2_000, signal: options.signal, env: { ...process.env, LC_ALL: "", LC_TIME: "C", LC_CTYPE: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8" } });
    pending.child.stdin?.end();
    output = (await pending).stdout;
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown };
    if (failed.code === 1 && failed.stdout === "" && failed.stderr === "" && failed.killed !== true && failed.signal == null) return null;
    throw error;
  }
  const stateAndIdentity = /^\s*(\S+)\s+([\s\S]+)$/.exec(output);
  if (stateAndIdentity?.[1]?.startsWith("Z")) return null;
  const identity = stateAndIdentity?.[2] == null ? null : parsePosixProcessIdentity(pid, stateAndIdentity[2]);
  if (identity == null) throw new Error(`Malformed POSIX process identity for ${pid}`);
  return identity;
}

export const posixProcessAdapter: LocalExecProcessAdapter = {
  readIdentity,
  readState(pid) {
    try { validatePid(pid); return execFileSync("ps", ["-p", String(pid), "-o", "state="], { encoding: "utf8", timeout: 2_000 }).trim() || null; }
    catch { return null; }
  },
  async terminate(pid, options: ProcessTerminateOptions = {}) {
    validatePid(pid);
    (options.kill ?? process.kill.bind(process))(pid, "SIGTERM");
  },
};
