import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendLocalIntercept } from "../../shared/node/local-admin-intercept.js";
import type { GatewayConnection } from "./gateway-descriptor-cache.js";

const LOCAL_ADMIN_GATEWAY_URL = "http://127.0.0.1:1340";
const BOX_EXEC_DAEMON_PORT = 1337;

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 300;
const OUTPUT_TAIL_LIMIT_BYTES = 8_192;
// Loopback port 9 refuses instantly: every stock-host call aimed at the Cursor
// backend fails closed without DNS, egress, or a 3s timeout.
const INERT_BACKEND_URL = "http://127.0.0.1:9";

let child: ChildProcess | undefined;
let logStream: ReturnType<typeof createWriteStream> | undefined;

export function localAdminHostLogPath(settingsPath: string): string {
  return join(dirname(settingsPath), "box-logs", "sand-host.log");
}

export interface LocalAdminHostDeps { readonly nodePath?: string; readonly treeSitterDeps?: string }

export function resolveLocalAdminHostDeps(): LocalAdminHostDeps {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (typeof resourcesPath !== "string" || resourcesPath.length === 0) return {};
  const distRoot = join(resourcesPath, "app.asar.unpacked", "dist");
  const deps = join(distRoot, "deps");
  const nodeDeps = join(distRoot, "node-deps");
  if (!existsSync(join(deps, "tree-sitter")) || !existsSync(nodeDeps)) return {};
  return { nodePath: `${deps}:${nodeDeps}`, treeSitterDeps: deps };
}

interface HostExit { readonly code: number | null; readonly signal: NodeJS.Signals | null }

// A SIGKILLed host leaves its box-exec-daemon orphaned on 1337; the next host
// then refuses to start ("port already bound") and the connector breaker opens.
// Before spawning, free the port: reap our own orphan, refuse foreign owners.
export interface ExecDaemonHealDeps {
  readonly listPortOwner?: (port: number) => Promise<number | undefined>;
  readonly readCommand?: (pid: number) => Promise<string | undefined>;
  readonly terminate?: (pid: number) => Promise<void>;
}

function defaultListPortOwner(port: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 3_000 }, (error, stdout) => {
      if (error) return resolve(undefined);
      const pid = Number.parseInt(stdout.trim().split("\n")[0] ?? "", 10);
      resolve(Number.isInteger(pid) && pid > 0 ? pid : undefined);
    });
  });
}

function defaultReadCommand(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "command="], { timeout: 3_000 }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim().length > 0 ? stdout.trim() : undefined);
    });
  });
}

async function defaultTerminate(pid: number): Promise<void> {
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}

export async function healOrphanedBoxExecDaemon(port: number = BOX_EXEC_DAEMON_PORT, deps: ExecDaemonHealDeps = {}): Promise<"free" | "reaped-orphan"> {
  const listPortOwner = deps.listPortOwner ?? defaultListPortOwner;
  const readCommand = deps.readCommand ?? defaultReadCommand;
  const terminate = deps.terminate ?? defaultTerminate;
  const owner = await listPortOwner(port);
  if (owner == null) return "free";
  const command = await readCommand(owner);
  if (command == null || !command.includes("box-exec-daemon")) {
    throw new Error(`Port ${port} is held by pid ${owner} which is not a Grok Bot box-exec-daemon (${command ?? "unknown command"}). Free the port before starting the local computer.`);
  }
  await terminate(owner);
  return "reaped-orphan";
}

export async function ensureLocalAdminHost(options: {
  readonly settingsPath: string;
  readonly hostMainPath: string;
  readonly token: string;
  readonly execPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly deps?: LocalAdminHostDeps;
}): Promise<GatewayConnection> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const deps = options.deps ?? resolveLocalAdminHostDeps();
  const logPath = localAdminHostLogPath(options.settingsPath);
  await mkdir(dirname(logPath), { recursive: true });
  if (await gatewayReady(options.token, fetchImpl)) {
    appendLocalIntercept({ kind: "local-host", event: "already-ready", logPath }, env);
    return { baseUrl: LOCAL_ADMIN_GATEWAY_URL, token: options.token };
  }
  const healed = await healOrphanedBoxExecDaemon();
  if (healed === "reaped-orphan") appendLocalIntercept({ kind: "local-host", event: "reaped-orphan-daemon", port: BOX_EXEC_DAEMON_PORT }, env);
  stopLocalAdminHost();
  logStream = createWriteStream(logPath, { flags: "a" });
  let outputTail = "";
  const capture = (chunk: Buffer): void => {
    logStream?.write(chunk);
    outputTail = (outputTail + String(chunk)).slice(-OUTPUT_TAIL_LIMIT_BYTES);
  };
  let exit: HostExit | undefined;
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
    SAND_HOST_IN_BOX: "0",
    SAND_BOX_LOG_SHIP_DISABLED: "1",
    SAND_GATEWAY_BIND_HOST: "127.0.0.1",
    SAND_HOST_PORT: "1340",
    SAND_GATEWAY_TOKEN: options.token,
    SAND_GATEWAY_REQUIRE_AUTH: "1",
    SAND_DATA_ROOT: join(dirname(options.settingsPath), "box-data"),
    // Converge the Mac-host daemon's file plane with the container contract:
    // its workspaceRoot becomes the same <root>/box-workspace the Docker form
    // bind-mounts at /workspace, so the agent cwd and the computer's files
    // are one directory in either form.
    SAND_WORKSPACE_ROOT: join(dirname(options.settingsPath), "box-workspace"),
    ...(env.SAND_BACKEND_URL == null || env.SAND_BACKEND_URL.trim() === "" ? { SAND_BACKEND_URL: INERT_BACKEND_URL } : {}),
    ...(deps.nodePath == null ? {} : { NODE_PATH: deps.nodePath }),
    ...(deps.treeSitterDeps == null ? {} : { SAND_TREE_SITTER_NODE_DEPS: deps.treeSitterDeps }),
  };
  const execPath = options.execPath ?? process.execPath;
  child = spawn(execPath, [options.hostMainPath], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.once("exit", (code, signal) => {
    exit = { code, signal };
    appendLocalIntercept({ kind: "local-host", event: "exit", code, signal, outputTail, logPath }, env);
  });
  appendLocalIntercept({ kind: "local-host", event: "spawn", pid: child.pid, hostMainPath: options.hostMainPath, logPath }, env);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await gatewayReady(options.token, fetchImpl)) return { baseUrl: LOCAL_ADMIN_GATEWAY_URL, token: options.token };
    if (exit != null) throw new Error(`Local admin host exited before the gateway was ready (code ${exit.code}${exit.signal == null ? "" : `, signal ${exit.signal}`}). Last output:\n${outputTail.trim()}\nFull log: ${logPath}`);
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  throw new Error(`Local admin host did not expose ${LOCAL_ADMIN_GATEWAY_URL} within 30s. Last output:\n${outputTail.trim()}\nFull log: ${logPath}`);
}

export function stopLocalAdminHost(): void {
  if (child != null && child.exitCode == null) child.kill("SIGTERM");
  child = undefined;
  logStream?.end();
  logStream = undefined;
}

async function gatewayReady(token: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${LOCAL_ADMIN_GATEWAY_URL}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch {
    return false;
  }
}
