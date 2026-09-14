import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendLocalIntercept } from "../../shared/node/local-admin-intercept.js";
import type { GatewayConnection } from "./gateway-descriptor-cache.js";

const LOCAL_ADMIN_GATEWAY_URL = "http://127.0.0.1:1340";

const READY_TIMEOUT_MS = 30_000;

let child: ChildProcess | undefined;
let logStream: ReturnType<typeof createWriteStream> | undefined;

export function localAdminHostLogPath(settingsPath: string): string {
  return join(dirname(settingsPath), "box-logs", "sand-host.log");
}

export async function ensureLocalAdminHost(options: {
  readonly settingsPath: string;
  readonly hostMainPath: string;
  readonly token: string;
  readonly execPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}): Promise<GatewayConnection> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const logPath = localAdminHostLogPath(options.settingsPath);
  await mkdir(dirname(logPath), { recursive: true });
  if (await gatewayReady(options.token, fetchImpl)) {
    appendLocalIntercept({ kind: "local-host", event: "already-ready", logPath }, env);
    return { baseUrl: LOCAL_ADMIN_GATEWAY_URL, token: options.token };
  }
  stopLocalAdminHost();
  logStream = createWriteStream(logPath, { flags: "a" });
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
  };
  const execPath = options.execPath ?? process.execPath;
  child = spawn(execPath, [options.hostMainPath], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => logStream?.write(chunk));
  child.stderr?.on("data", (chunk) => logStream?.write(chunk));
  child.once("exit", (code, signal) => {
    appendLocalIntercept({ kind: "local-host", event: "exit", code, signal, logPath }, env);
    if (child?.exitCode != null) child = undefined;
  });
  appendLocalIntercept({ kind: "local-host", event: "spawn", pid: child.pid, hostMainPath: options.hostMainPath, logPath }, env);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await gatewayReady(options.token, fetchImpl)) return { baseUrl: LOCAL_ADMIN_GATEWAY_URL, token: options.token };
    if (child.exitCode != null) throw new Error(`Local admin host exited before the gateway was ready (code ${child.exitCode}). See ${logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Local admin host did not expose ${LOCAL_ADMIN_GATEWAY_URL} within 30s. See ${logPath}`);
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
