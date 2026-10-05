import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readLocalExecDaemonDiscovery } from "../../host/local-exec/local-exec-daemon-protocol.js";
import {
  commandCarriesLocalExecGeneration,
  localExecDiscoveryTimeMatchesProcess,
  LOCAL_EXEC_GENERATION_TOKEN_ARG,
  LOCAL_EXEC_GENERATION_TOKEN_ENV,
} from "../../shared/local-exec-process-identity.js";
import { findSystemErrno } from "../../shared/system-errno.js";
import { reportLocalExecExited, reportLocalExecSpawnFailed, reportLocalExecSpawned, reportLocalExecTerminationFailed } from "./local-exec-lifecycle-telemetry.js";
import { posixProcessAdapter, parsePosixProcessIdentity } from "./local-exec-process-posix.js";
import { windowsProcessAdapter, parseWindowsProcessIdentity } from "./local-exec-process-windows.js";
import type { LocalExecProcessIdentity } from "./local-exec-process-types.js";
import type { ProcessTerminateOptions } from "./local-exec-process-types.js";

export function daemonMainPath(moduleUrl = import.meta.url): string { return join(dirname(fileURLToPath(moduleUrl)), "..", "local-exec-daemon", "main.cjs"); }
export function resolveLocalExecDaemonEntryRealpath(mainPath = daemonMainPath(), realpath: typeof realpathSync = realpathSync): string { return realpath(mainPath); }
export interface SpawnedLocalExecDaemon { readonly child: ChildProcess; readonly entryRealpath: string; readonly generationToken: string; }
/* Platform process queries and termination live in local-exec-process-* adapters. */
export { parsePosixProcessIdentity, parseWindowsProcessIdentity };
export type { LocalExecProcessIdentity } from "./local-exec-process-types.js";
function chooseAdapter(platform: NodeJS.Platform) { return platform === "win32" ? windowsProcessAdapter : posixProcessAdapter; }
interface ProcessIdentityReadOptions { readonly signal?: AbortSignal }
const pendingIdentityReads = new Map<string, Promise<LocalExecProcessIdentity | null>>();
export function readProcessIdentity(pid: number, platform = process.platform, options: ProcessIdentityReadOptions = {}): Promise<LocalExecProcessIdentity | null> {
  const adapter = chooseAdapter(platform);
  if (options.signal != null) return adapter.readIdentity(pid, options);
  const key = `${platform}:${pid}`;
  const existing = pendingIdentityReads.get(key);
  if (existing != null) return existing;
  const pending = adapter.readIdentity(pid, options);
  pendingIdentityReads.set(key, pending);
  const clear = (): void => { if (pendingIdentityReads.get(key) === pending) pendingIdentityReads.delete(key); };
  void pending.then(clear, clear);
  return pending;
}
export function readProcessState(pid: number, platform = process.platform): string | null { return (platform === "win32" ? windowsProcessAdapter : posixProcessAdapter).readState(pid); }
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
export const terminateWindowsProcessTree = (identity: LocalExecProcessIdentity): Promise<void> => windowsProcessAdapter.terminate(identity.pid, { expectedIdentity: identity });

export async function terminateProcess(pid: number, deps: { readonly kill?: typeof process.kill; readonly waitForExit?: (pid: number) => Promise<void>; readonly reportFailure?: (error: unknown) => void; readonly expectedIdentity?: LocalExecProcessIdentity } = {}): Promise<void> {
  try {
    const options: ProcessTerminateOptions = {
      ...(deps.expectedIdentity === undefined ? {} : { expectedIdentity: deps.expectedIdentity }),
      ...(deps.kill === undefined ? {} : { kill: deps.kill }),
    };
    await chooseAdapter(process.platform).terminate(pid, options);
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
