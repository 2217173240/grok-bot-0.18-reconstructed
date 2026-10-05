import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findSystemErrno } from "../../shared/system-errno.js";
import type { LocalExecProcessAdapter, LocalExecProcessIdentity, ProcessIdentityReadOptions, ProcessTerminateOptions } from "./local-exec-process-types.js";

const execFileAsync = promisify(execFile);
function validatePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new RangeError(`Invalid local-exec process ID: ${pid}`);
}

async function runPowerShell(script: string, options: ProcessIdentityReadOptions = {}): Promise<string> {
  const pending = execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`, "utf16le").toString("base64")], { encoding: "utf8", timeout: 15_000, windowsHide: true, signal: options.signal });
  pending.child.stdin?.end();
  return (await pending).stdout;
}

export function parseWindowsProcessIdentity(pid: number, output: string): LocalExecProcessIdentity | null {
  validatePid(pid);
  const parsed = JSON.parse(output.trim()) as { startEpochMs?: unknown; command?: unknown } | null;
  if (parsed === null) return null;
  if (typeof parsed.startEpochMs !== "number" || !Number.isSafeInteger(parsed.startEpochMs) || parsed.startEpochMs <= 0 || typeof parsed.command !== "string" || parsed.command.trim().length === 0) throw new Error(`Malformed Windows process identity for ${pid}`);
  return { pid, startEpochMs: parsed.startEpochMs, command: parsed.command.trim() };
}

async function readIdentity(pid: number, options: ProcessIdentityReadOptions = {}): Promise<LocalExecProcessIdentity | null> {
  validatePid(pid);
  options.signal?.throwIfAborted();
  const output = await runPowerShell(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -eq $p) { Write-Output 'null' } else { @{startEpochMs=([DateTimeOffset]$p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds();command=$p.CommandLine}|ConvertTo-Json -Compress }`, options);
  return parseWindowsProcessIdentity(pid, output);
}

async function terminate(pid: number, options: ProcessTerminateOptions = {}): Promise<void> {
  validatePid(pid);
  const identity = options.expectedIdentity ?? await readIdentity(pid);
  if (identity == null) {
    try { process.kill(pid, 0); }
    catch (error) { if (findSystemErrno(error) === "ESRCH") return; throw error; }
    throw new Error(`Could not verify local-exec process ${pid} before termination`);
  }
  if (identity.pid !== pid || identity.pid === process.pid || !Number.isSafeInteger(identity.startEpochMs) || identity.startEpochMs <= 0 || identity.command.trim().length === 0) throw new Error("Invalid local-exec process identity for Windows termination");
  const encoded = Buffer.from(JSON.stringify(identity), "utf8").toString("base64");
  // 持有目标进程句柄，核对创建时间及完整命令以后终止所属进程树。
  await runPowerShell(`
    $expected=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json;
    $p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$expected.pid);
    if ($null -eq $p) { exit 0 };
    $target=[System.Diagnostics.Process]::GetProcessById($expected.pid);
    try {
      $null=$target.Handle;
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

export const windowsProcessAdapter: LocalExecProcessAdapter = { readIdentity, readState: () => null, terminate };
