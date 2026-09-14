import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isCursorProductionBackendUrl, isLocalAdminEnabled } from "./local-admin.js";

export function localInterceptLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SAND_DATA_ROOT?.trim() || join(homedir(), ".grokbot");
  return join(root, "local-intercept.jsonl");
}

export function appendLocalIntercept(record: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv = process.env): void {
  const path = localInterceptLogPath(env);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
}

export function installLocalAdminNetworkIntercept(env: NodeJS.ProcessEnv = process.env): void {
  if (!isLocalAdminEnabled(env)) return;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String((input as Request).url);
    if (isCursorProductionBackendUrl(url)) {
      appendLocalIntercept({ kind: "blocked-fetch", url, method: init?.method ?? "GET" }, env);
      throw new Error(`SAND_LOCAL_ADMIN blocked fetch ${url}`);
    }
    return await original(input, init);
  }) as typeof fetch;
}
