import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { findSystemErrno } from "../shared/system-errno.js";
import { getHostLockPath } from "./host-paths.js";
export const DEFAULT_TAKEOVER_TIMEOUT_MS = 3_000; export const DEFAULT_POLL_INTERVAL_MS = 100; export const MAX_ACQUIRE_ATTEMPTS = 5;
export function defaultIsProcessAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
export function readProcessCommand(pid: number): string | null { try { const value = readFileSync(`/proc/${pid}/cmdline`, "utf8"); if (value.length > 0) return value.replace(/\0/g, " ").trim(); } catch {} try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2_000 }).trim(); } catch { return null; } }
export function isSandHostProcess(pid: number): boolean {
  try {
    const executable = process.platform === "linux"
      ? readlinkSync(`/proc/${pid}/exe`)
      : execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 2_000 }).trim();
    const executablePath = realpathSync(executable);
    const runtimeName = basename(executablePath);
    if (executablePath !== realpathSync(process.execPath) && !["node", "nodejs", "Electron"].includes(runtimeName)) return false;
    let entry: string | undefined;
    if (process.platform === "linux") {
      entry = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[1];
    } else {
      const command = readProcessCommand(pid);
      if (!command?.startsWith(`${executable} `)) return false;
      // Mac host 使用 Electron-as-Node 加单个入口路径，路径可以包含空格。
      entry = command.slice(executable.length + 1).trim();
    }
    return entry !== undefined && isAbsolute(entry) && basename(entry) === "host-main.cjs" && statSync(entry).isFile();
  } catch { return false; }
}
export function readLockPid(path: string): number | null { try { const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10); return Number.isInteger(pid) && pid > 0 ? pid : null; } catch { return null; } }
function removeLock(path: string): void { try { unlinkSync(path); } catch {} }
function tryCreateLock(path: string, pid: number): boolean { try { const fd = openSync(path, "wx"); try { writeFileSync(fd, String(pid), "utf8"); } finally { closeSync(fd); } return true; } catch (error) { if (findSystemErrno(error) === "EEXIST") return false; throw error; } }
function makeHandle(path: string, pid: number) { return { path, pid, release() { if (readLockPid(path) === pid) removeLock(path); } }; }
async function waitForExit(pid: number, isAlive: (pid: number) => boolean, delay: (ms: number) => Promise<void>, timeoutMs: number, pollMs: number): Promise<void> { const deadline = Date.now() + timeoutMs; while (isAlive(pid) && Date.now() < deadline) await delay(pollMs); }
export async function acquireHostLock(options: { path?: string; pid?: number; isProcessAlive?: (pid: number) => boolean; isSandHostProcess?: (pid: number) => boolean; terminateProcess?: (pid: number, signal: NodeJS.Signals) => void; delay?: (ms: number) => Promise<void>; takeoverTimeoutMs?: number; pollIntervalMs?: number } = {}) {
  const path = options.path ?? getHostLockPath(); const pid = options.pid ?? process.pid; const isAlive = options.isProcessAlive ?? defaultIsProcessAlive; const hostCheck = options.isSandHostProcess ?? isSandHostProcess; const terminate = options.terminateProcess ?? ((target, signal) => { try { process.kill(target, signal); } catch {} }); const delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))); const timeout = options.takeoverTimeoutMs ?? DEFAULT_TAKEOVER_TIMEOUT_MS; const poll = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  mkdirSync(dirname(path), { recursive: true }); let outcome: "created" | "reclaimed-dead" | "reclaimed-foreign" | "took-over" = "created"; let previousPid: number | undefined;
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) { if (tryCreateLock(path, pid)) return { outcome, lock: makeHandle(path, pid), ...(previousPid === undefined ? {} : { previousPid }) }; const holder = readLockPid(path); if (holder == null) { outcome = "reclaimed-dead"; removeLock(path); continue; } if (holder === pid) { removeLock(path); continue; } if (!isAlive(holder)) { outcome = "reclaimed-dead"; previousPid = holder; removeLock(path); continue; } if (!hostCheck(holder)) { outcome = "reclaimed-foreign"; previousPid = holder; removeLock(path); continue; } outcome = "took-over"; previousPid = holder; terminate(holder, "SIGTERM"); await waitForExit(holder, isAlive, delay, timeout, poll); if (isAlive(holder)) { terminate(holder, "SIGKILL"); await waitForExit(holder, isAlive, delay, timeout, poll); } removeLock(path); }
  writeFileSync(path, String(pid), "utf8"); return { outcome, lock: makeHandle(path, pid), ...(previousPid === undefined ? {} : { previousPid }) };
}
