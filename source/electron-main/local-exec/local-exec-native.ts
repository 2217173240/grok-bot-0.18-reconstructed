import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readLocalExecDaemonDiscovery } from "../../host/local-exec/local-exec-daemon-protocol.js";
import {
  commandCarriesLocalExecGeneration,
  localExecDiscoveryTimeMatchesProcess,
  LOCAL_EXEC_GENERATION_TOKEN_ARG,
  LOCAL_EXEC_GENERATION_TOKEN_ENV,
} from "../../shared/local-exec-process-identity.js";
import { findSystemErrno } from "../../shared/system-errno.js";
import { reportLocalExecExited, reportLocalExecSpawnFailed, reportLocalExecSpawned, reportLocalExecTerminationFailed } from "./local-exec-lifecycle-telemetry.js";

export function daemonMainPath(moduleUrl = import.meta.url): string { return join(dirname(fileURLToPath(moduleUrl)), "..", "local-exec-daemon", "main.cjs"); }
export function resolveLocalExecDaemonEntryRealpath(mainPath = daemonMainPath(), realpath: typeof realpathSync = realpathSync): string { return realpath(mainPath); }
function attemptSync<T>(run: () => T): { ok: true; value: T } | { ok: false } { try { return { ok: true, value: run() }; } catch { return { ok: false }; } }
export interface LocalExecProcessIdentity { readonly pid: number; readonly startEpochMs: number; readonly command: string; }
export interface SpawnedLocalExecDaemon { readonly child: ChildProcess; readonly entryRealpath: string; readonly generationToken: string; }
export function parsePosixProcessIdentity(pid: number, output: string): LocalExecProcessIdentity | null { const match = /^(\S{3}\s+\S{3}\s+[ 0-9]\d\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(output.trim()); const started = match?.[1]; if (started == null) return null; const startEpochMs = Date.parse(started); const command = match?.[2]?.trim() ?? ""; return Number.isFinite(startEpochMs) && command.length > 0 ? { pid, startEpochMs, command } : null; }
const execFileAsync = promisify(execFile);
interface ProcessIdentityReadOptions { readonly signal?: AbortSignal }
async function runWindowsPowerShell(script: string, options: ProcessIdentityReadOptions = {}): Promise<string> {
  const pending = execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`, "utf16le").toString("base64")], { encoding: "utf8", timeout: 15_000, windowsHide: true, signal: options.signal });
  pending.child.stdin?.end();
  const { stdout } = await pending;
  return stdout;
}

function validateProcessId(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new RangeError(`Invalid local-exec process ID: ${pid}`);
}

export function parseWindowsProcessIdentity(pid: number, output: string): LocalExecProcessIdentity | null {
  validateProcessId(pid);
  const parsed = JSON.parse(output.trim()) as { startEpochMs?: unknown; command?: unknown } | null;
  if (parsed === null) return null;
  if (typeof parsed.startEpochMs !== "number" || !Number.isSafeInteger(parsed.startEpochMs) || parsed.startEpochMs <= 0 || typeof parsed.command !== "string" || parsed.command.trim().length === 0) throw new Error(`Malformed Windows process identity for ${pid}`);
  return { pid, startEpochMs: parsed.startEpochMs, command: parsed.command.trim() };
}

async function queryProcessIdentity(pid: number, platform: NodeJS.Platform, options: ProcessIdentityReadOptions): Promise<LocalExecProcessIdentity | null> {
  validateProcessId(pid);
  options.signal?.throwIfAborted();
  if (platform === "win32") {
    const output = await runWindowsPowerShell(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -eq $p) { Write-Output 'null' } else { @{startEpochMs=([DateTimeOffset]$p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds();command=$p.CommandLine}|ConvertTo-Json -Compress }`, options);
    return parseWindowsProcessIdentity(pid, output);
  }
  let output: string;
  try {
    const pending = execFileAsync("ps", ["-p", String(pid), "-o", "state=", "-o", "lstart=", "-o", "command="], { encoding: "utf8", timeout: 2_000, signal: options.signal, env: { ...process.env, LC_ALL: "", LC_TIME: "C", LC_CTYPE: platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8" } });
    pending.child.stdin?.end();
    const result = await pending;
    output = result.stdout;
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown };
    // ps 对不存在的 PID 返回 1 且无输出；其他失败保留错误。
    if (failed.code === 1 && failed.stdout === "" && failed.stderr === "" && failed.killed !== true && failed.signal == null) return null;
    throw error;
  }
  const stateAndIdentity = /^\s*(\S+)\s+([\s\S]+)$/.exec(output);
  if (stateAndIdentity?.[1]?.startsWith("Z")) return null;
  const identity = stateAndIdentity?.[2] == null ? null : parsePosixProcessIdentity(pid, stateAndIdentity[2]);
  if (identity == null) throw new Error(`Malformed POSIX process identity for ${pid}`);
  return identity;
}

const pendingIdentityReads = new Map<string, Promise<LocalExecProcessIdentity | null>>();
export function readProcessIdentity(pid: number, platform = process.platform, options: ProcessIdentityReadOptions = {}): Promise<LocalExecProcessIdentity | null> {
  if (options.signal != null) return queryProcessIdentity(pid, platform, options);
  const key = `${platform}:${pid}`;
  const existing = pendingIdentityReads.get(key);
  if (existing != null) return existing;
  const pending = queryProcessIdentity(pid, platform, options);
  pendingIdentityReads.set(key, pending);
  const clear = (): void => { if (pendingIdentityReads.get(key) === pending) pendingIdentityReads.delete(key); };
  void pending.then(clear, clear);
  return pending;
}
export function readProcessState(pid: number, platform = process.platform): string | null { if (platform === "win32") return null; const queried = attemptSync(() => execFileSync("ps", ["-p", String(pid), "-o", "state="], { encoding: "utf8", timeout: 2_000 })); if (!queried.ok) return null; const state = queried.value.trim(); return state.length > 0 ? state : null; }
export function isProcessAlive(pid: number, kill: typeof process.kill = process.kill.bind(process), readState: (pid: number) => string | null = readProcessState): boolean { let signalable = false; try { kill(pid, 0); signalable = true; } catch (error) { if (findSystemErrno(error) !== "EPERM") return false; signalable = true; } if (!signalable) return false; const state = readState(pid); return state == null || !state.startsWith("Z"); }
export async function readProcessCommand(pid: number, platform = process.platform): Promise<string | null> {
  return (await readProcessIdentity(pid, platform))?.command ?? null;
}
export async function isLocalExecDaemonProcess(pid: number, entryRealpath?: string, generationToken?: string): Promise<boolean> { if (entryRealpath == null || generationToken == null) return false; const identity = await readProcessIdentity(pid); return identity != null && commandCarriesLocalExecGeneration(identity.command, entryRealpath, generationToken); }
export { commandCarriesLocalExecGeneration, LOCAL_EXEC_GENERATION_TOKEN_ARG, LOCAL_EXEC_GENERATION_TOKEN_ENV };
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
export class LocalExecTerminationTimeoutError extends Error { constructor(readonly pid: number) { super(`local-exec process ${pid} remained alive after termination timeout`); this.name = "LocalExecTerminationTimeoutError"; } }
export class LocalExecTerminationSignalError extends Error { constructor(readonly pid: number, readonly code: string | undefined, cause: unknown) { super(`local-exec process ${pid} could not be signalled${code == null ? "" : ` (${code})`}`, { cause }); this.name = "LocalExecTerminationSignalError"; } }
export async function waitForProcessExit(pid: number, deps: { readonly isAlive?: (pid: number) => boolean; readonly delay?: (ms: number) => Promise<void> } = {}): Promise<void> { const alive = deps.isAlive ?? isProcessAlive; const wait = deps.delay ?? delay; for (let attempt = 0; attempt < 40; attempt += 1) { if (!alive(pid)) return; await wait(100); } if (alive(pid)) throw new LocalExecTerminationTimeoutError(pid); }
export async function terminateWindowsProcessTree(identity: LocalExecProcessIdentity): Promise<void> {
  if (!Number.isInteger(identity.pid) || identity.pid <= 0 || identity.pid === process.pid || !Number.isSafeInteger(identity.startEpochMs) || identity.startEpochMs <= 0 || identity.command.trim().length === 0) throw new Error("Invalid local-exec process identity for Windows termination");
  const encoded = Buffer.from(JSON.stringify(identity), "utf8").toString("base64");
  // 保持目标进程 handle，直到 taskkill 完成；再次核验创建时间和完整命令。
  await runWindowsPowerShell(`
    $expected=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json;
    $p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$expected.pid);
    if ($null -eq $p) { exit 0 };
    $target=[System.Diagnostics.Process]::GetProcessById($expected.pid);
    try {
      $heldHandle=$target.Handle;
      if ($target.HasExited) { exit 0 };
      $p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$expected.pid);
      if ($null -eq $p) { exit 0 };
      $started=([DateTimeOffset]$p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds();
      if ($started -ne $expected.startEpochMs -or $p.CommandLine.Trim() -cne $expected.command) { throw 'Local-exec process identity changed before termination' };
      & "$env:SystemRoot\\System32\\taskkill.exe" /PID $expected.pid /T /F;
      if ($LASTEXITCODE -ne 0 -and -not $target.HasExited) { throw 'taskkill failed to terminate local-exec process tree' };
    } finally { $target.Dispose() }
  `);
}

export async function terminateProcess(pid: number, deps: { readonly kill?: typeof process.kill; readonly waitForExit?: (pid: number) => Promise<void>; readonly reportFailure?: (error: unknown) => void; readonly expectedIdentity?: LocalExecProcessIdentity } = {}): Promise<void> {
  try {
    if (process.platform === "win32") {
      const identity = deps.expectedIdentity ?? await readProcessIdentity(pid);
      if (identity == null) {
        if (!isProcessAlive(pid)) return;
        throw new Error(`Could not verify local-exec process ${pid} before termination`);
      }
      if (identity.pid !== pid) throw new Error("Local-exec termination PID does not match its identity");
      await terminateWindowsProcessTree(identity);
    } else (deps.kill ?? process.kill.bind(process))(pid, "SIGTERM");
  } catch (error) {
    const code = findSystemErrno(error);
    if (code === "ESRCH") return;
    (deps.reportFailure ?? ((failure) => reportLocalExecTerminationFailed(pid, failure)))(error);
    throw new LocalExecTerminationSignalError(pid, code, error);
  }
  await (deps.waitForExit ?? waitForProcessExit)(pid);
}
export async function spawnLocalExecDaemon(args: { readonly logPath: string; readonly env: NodeJS.ProcessEnv; readonly mainPath?: string; readonly spawnImpl?: typeof spawn; readonly generationToken?: string; readonly realpath?: typeof realpathSync; readonly open?: typeof openSync; readonly close?: typeof closeSync }): Promise<SpawnedLocalExecDaemon> {
  await mkdir(dirname(args.logPath), { recursive: true });
  const entryRealpath = resolveLocalExecDaemonEntryRealpath(args.mainPath ?? daemonMainPath(), args.realpath ?? realpathSync);
  const generationToken = args.generationToken ?? randomUUID();
  if (generationToken.length === 0) throw new Error("local-exec generation token must not be empty");
  const logFd = (args.open ?? openSync)(args.logPath, "a");
  try {
    const child = (args.spawnImpl ?? spawn)(process.execPath, [entryRealpath, `${LOCAL_EXEC_GENERATION_TOKEN_ARG}${generationToken}`], { detached: true, windowsHide: true, stdio: ["ignore", logFd, logFd], env: { ...process.env, ...args.env, [LOCAL_EXEC_GENERATION_TOKEN_ENV]: generationToken } });
    const spawnedAt = performance.now();
    let spawnSucceeded = false;
    child.once("error", (error) => reportLocalExecSpawnFailed(error));
    child.once("spawn", () => { spawnSucceeded = true; reportLocalExecSpawned(child.pid); });
    child.once("exit", (exitCode, signal) => { if (spawnSucceeded) reportLocalExecExited({ ...(child.pid === undefined ? {} : { pid: child.pid }), exitCode, signal, uptimeMs: performance.now() - spawnedAt }); });
    child.unref();
    return { child, entryRealpath, generationToken };
  } finally { (args.close ?? closeSync)(logFd); }
}

export async function killLocalExecDaemon(discoveryPath: string, deps: { readonly expectedEntryRealpath?: string; readonly readIdentity?: typeof readProcessIdentity; readonly terminate?: (pid: number) => Promise<void>; readonly now?: () => number } = {}): Promise<void> {
  const existing = await readLocalExecDaemonDiscovery(discoveryPath);
  if (existing == null || existing.entryRealpath == null || existing.generationToken == null) return;
  const expectedEntryRealpath = deps.expectedEntryRealpath ?? realpathSync(daemonMainPath());
  if (existing.entryRealpath !== expectedEntryRealpath) return;
  const observed = await (deps.readIdentity ?? readProcessIdentity)(existing.pid);
  if (observed == null || !localExecDiscoveryTimeMatchesProcess(existing.startedAt, observed.startEpochMs, (deps.now ?? Date.now)()) || !commandCarriesLocalExecGeneration(observed.command, expectedEntryRealpath, existing.generationToken)) return;
  if (deps.terminate != null) await deps.terminate(existing.pid);
  else await terminateProcess(existing.pid, { expectedIdentity: observed });
}
