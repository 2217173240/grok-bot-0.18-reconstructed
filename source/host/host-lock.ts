import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findSystemErrno } from "../shared/system-errno.js";
import { getHostLockPath } from "./host-paths.js";
export const DEFAULT_TAKEOVER_TIMEOUT_MS = 3_000; export const DEFAULT_POLL_INTERVAL_MS = 100; export const MAX_ACQUIRE_ATTEMPTS = 5;
export function defaultIsProcessAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { if (findSystemErrno(error) === "ESRCH") return false; throw error; } }
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
interface HostLockRecord { readonly version: 1; readonly pid: number; readonly ownerToken: string; readonly processStartId: string }
type LockRecord = HostLockRecord | { readonly pid: number };

function readLockRecord(path: string): LockRecord | null {
  let text: string;
  try { text = readFileSync(path, "utf8").trim(); }
  catch (error) { if (findSystemErrno(error) === "ENOENT") return null; throw error; }
  if (text.length === 0) return null;
  if (/^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text))) return { pid: Number(text) };
  const record: unknown = JSON.parse(text);
  if (typeof record !== "object" || record === null || !("version" in record) || record.version !== 1
    || !("pid" in record) || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0
    || !("ownerToken" in record) || typeof record.ownerToken !== "string" || record.ownerToken.length === 0
    || !("processStartId" in record) || typeof record.processStartId !== "string" || record.processStartId.length === 0) throw new Error("Invalid host lock metadata");
  return record as HostLockRecord;
}

export function readLockPid(path: string): number | null { return readLockRecord(path)?.pid ?? null; }

export function readProcessStartId(pid: number): string | null {
  try {
    // 使用系统提供的不透明启动标识；秒级精度并不构成原子 PID 身份句柄。
    const start = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2_000, env: { ...process.env, LC_ALL: "C" } }).trim();
    return start.length > 0 ? `${process.platform}:${start}` : null;
  } catch { return null; }
}

function sameRecord(left: LockRecord | null, right: LockRecord): boolean {
  return left?.pid === right.pid && ("ownerToken" in right
    ? "ownerToken" in left && left.ownerToken === right.ownerToken && left.processStartId === right.processStartId
    : !("ownerToken" in left));
}

function publishLock(path: string, record: HostLockRecord): void {
  const temporary = `${path}.${record.ownerToken}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (findSystemErrno(error) !== "ENOENT") throw error; }
  }
}

function closeGuard(db: DatabaseSync): void { try { db.exec("ROLLBACK"); } finally { db.close(); } }

function makeHandle(path: string, record: HostLockRecord, db: DatabaseSync) {
  let released = false;
  return { path, pid: record.pid, release() {
    if (released) return;
    released = true;
    try {
      const current = readLockRecord(path);
      if (sameRecord(current, record)) unlinkSync(path);
      else if (current !== null) throw new Error("Host lock metadata ownership changed before release");
    } finally { closeGuard(db); }
  } };
}

export async function acquireHostLock(options: { path?: string; pid?: number; isProcessAlive?: (pid: number) => boolean; isSandHostProcess?: (pid: number) => boolean; terminateProcess?: (pid: number, signal: NodeJS.Signals) => void; delay?: (ms: number) => Promise<void>; takeoverTimeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {}) {
  const path = options.path ?? getHostLockPath(), pid = options.pid ?? process.pid;
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive, hostCheck = options.isSandHostProcess ?? isSandHostProcess;
  const terminate = options.terminateProcess ?? ((target, signal) => { try { process.kill(target, signal); } catch (error) { if (findSystemErrno(error) !== "ESRCH") throw error; } });
  const delay = options.delay ?? ((ms) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const timeout = options.takeoverTimeoutMs ?? DEFAULT_TAKEOVER_TIMEOUT_MS, poll = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const checkCancelled = () => options.signal?.throwIfAborted();
  checkCancelled();
  mkdirSync(dirname(path), { recursive: true });
  // 固定 guard 文件永不删除；SQLite 的内核锁覆盖整个 host 生命周期。
  const db = new DatabaseSync(`${path}.sqlite`);
  let acquired = false, transferred = false, takeoverAttempted = false;
  let outcome = "created", previousPid: number | undefined;
  const takeOver = async (holder: LockRecord): Promise<void> => {
    if (holder.pid === pid) throw new Error("This process already holds the host lock");
    const start = "processStartId" in holder ? holder.processStartId : readProcessStartId(holder.pid);
    if (start === null || readProcessStartId(holder.pid) !== start || !hostCheck(holder.pid)) throw new Error("Cannot verify the live host lock owner");
    const oldInstanceAlive = () => {
      if (!isAlive(holder.pid)) return false;
      const current = readProcessStartId(holder.pid);
      if (current === null) {
        if (!isAlive(holder.pid)) return false;
        throw new Error("Cannot verify whether the previous host exited");
      }
      return current === start;
    };
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      checkCancelled();
      if (!oldInstanceAlive()) return;
      if (!sameRecord(readLockRecord(path), holder) || !hostCheck(holder.pid) || readProcessStartId(holder.pid) !== start) throw new Error("Host lock owner changed during takeover");
      terminate(holder.pid, signal);
      const deadline = Date.now() + timeout;
      while (oldInstanceAlive() && Date.now() < deadline) { checkCancelled(); await delay(poll); }
      if (!oldInstanceAlive()) return;
    }
    throw new Error("The previous host did not exit; host lock takeover failed");
  };
  try {
    db.exec("PRAGMA busy_timeout = 0");
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      checkCancelled();
      try {
        const mode = db.prepare("PRAGMA journal_mode = DELETE").get();
        if (mode?.journal_mode !== "delete") throw new Error("Host lock requires SQLite rollback journal mode");
        db.exec("BEGIN EXCLUSIVE");
        acquired = true;
      } catch (error) {
        if (typeof error !== "object" || error === null || !("errcode" in error) || error.errcode !== 5) throw error;
        if (!takeoverAttempted) {
          takeoverAttempted = true;
          const holder = readLockRecord(path);
          if (holder !== null && isAlive(holder.pid)) {
            await takeOver(holder);
            outcome = "took-over"; previousPid = holder.pid;
          }
        }
        await delay(poll);
        continue;
      }
      const holder = readLockRecord(path);
      if (holder !== null) {
        previousPid ??= holder.pid;
        if ("ownerToken" in holder) {
          if (isAlive(holder.pid)) {
            const start = readProcessStartId(holder.pid);
            if (start === null) throw new Error("Cannot verify the live host lock owner");
            if (start === holder.processStartId && hostCheck(holder.pid)) throw new Error("A live host still owns the metadata; the host lock guard may have been replaced");
          }
          outcome = outcome === "took-over" ? outcome : "reclaimed-stale";
        }
        else if (holder.pid === pid) outcome = "reclaimed-stale";
        else if (!isAlive(holder.pid)) outcome = "reclaimed-dead";
        else if (!hostCheck(holder.pid)) outcome = "reclaimed-foreign";
        else {
          await takeOver(holder);
          outcome = "took-over";
        }
      }
      checkCancelled();
      const processStartId = readProcessStartId(pid);
      if (processStartId === null) throw new Error("Cannot identify this host process start");
      const record: HostLockRecord = { version: 1, pid, ownerToken: randomUUID(), processStartId };
      publishLock(path, record);
      transferred = true;
      return { outcome, lock: makeHandle(path, record, db), ...(previousPid === undefined ? {} : { previousPid }) };
    }
    throw new Error("Host lock remained busy; acquisition failed without changing the owner");
  } finally {
    if (!transferred) { if (acquired) closeGuard(db); else db.close(); }
  }
}
