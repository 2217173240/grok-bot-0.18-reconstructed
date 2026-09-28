import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { killDetachedProcessGroup } from "../../../packages/shell-exec/core.js";

const execFileAsync = promisify(execFile);

export async function liveClaudeProcessGroup(pid: number): Promise<number[]> {
  const selector = process.platform === "linux" ? "-s" : "-g";
  let output: string;
  try {
    output = (await execFileAsync("ps", [selector, String(pid), "-o", "pid=,pgid=,stat="], { timeout: 2000 })).stdout;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return [];
    throw error;
  }
  return output.trim().split("\n").flatMap(line => {
    const [processId, groupId, state] = line.trim().split(/\s+/);
    return Number(groupId) === pid && state != null && !state.startsWith("Z") ? [Number(processId)] : [];
  });
}

async function stopGroup(pid: number): Promise<void> {
  killDetachedProcessGroup(pid, "SIGTERM");
  const started = performance.now();
  let forced = false;
  while ((await liveClaudeProcessGroup(pid)).length > 0) {
    const elapsed = performance.now() - started;
    if (elapsed >= 1000 && !forced) {
      killDetachedProcessGroup(pid, "SIGKILL");
      forced = true;
    }
    if (elapsed >= 5000) throw new Error(`Claude process group ${pid} remained alive after termination`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export function createClaudeProcessOwner(onSpawn?: (child: ChildProcess) => void) {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Claude process ownership requires Linux or macOS");
  const stops: Array<() => Promise<void>> = [];
  const processIds: number[] = [];
  let closing: Promise<void> | undefined;
  return {
    processIds,
    spawn(options: SpawnOptions): SpawnedProcess {
      if (closing !== undefined) throw new Error("Claude process owner is closed");
      if (options.signal.aborted) throw options.signal.reason ?? new Error("Claude process launch canceled");
      const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, detached: true, windowsHide: true, stdio: "pipe" });
      if (child.pid != null) processIds.push(child.pid);
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      let stopping: Promise<void> | undefined;
      const stop = (): Promise<void> => {
        stopping ??= (async () => {
          if (child.pid != null) await stopGroup(child.pid);
          await closed;
        })();
        // 异步取消会先触发 stop；close 负责将终止失败传给调用方。
        stopping.catch(() => undefined);
        return stopping;
      };
      const abort = () => { void stop(); };
      options.signal.addEventListener("abort", abort, { once: true });
      child.once("exit", () => { void stop(); });
      child.once("close", () => { options.signal.removeEventListener("abort", abort); void stop(); });
      child.on("error", () => {});
      stops.push(stop);
      if (onSpawn !== undefined) onSpawn(child);
      else child.stderr.resume();
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        get killed() { return stopping !== undefined; },
        get exitCode() { return child.exitCode; },
        kill(signal: NodeJS.Signals) {
          if (signal === "SIGKILL" && child.pid != null) killDetachedProcessGroup(child.pid, signal);
          void stop();
          return true;
        },
        on: child.on.bind(child),
        once: child.once.bind(child),
        off: child.off.bind(child),
      };
    },
    close(): Promise<void> {
      closing ??= Promise.all(stops.map(stop => stop())).then(() => undefined);
      return closing;
    },
  };
}
