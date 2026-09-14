import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Zero-OAuth plugin surface for local admin: MCP server definitions live in a
// file next to settings.json instead of Cursor's dashboard. The shape mirrors
// the familiar `{ "mcpServers": { name: { command, args, env } | { url } } }`
// convention (Claude Code / Cursor style), so existing configs drop in as-is.

export interface LocalMcpServerConfig { readonly command?: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>>; readonly url?: string }
export interface LocalMcpRuntimeConfig { readonly mcpServers: Readonly<Record<string, LocalMcpServerConfig>> }

export const LOCAL_MCP_SERVERS_FILENAME = "mcp-servers.json";

function parseServerEntry(value: unknown): LocalMcpServerConfig | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const record = value as Record<string, unknown>;
  const command = record.command;
  const url = record.url;
  if (typeof command === "string" && command.trim().length > 0) {
    const args = record.args;
    const env = record.env;
    return {
      command: command.trim(),
      ...(Array.isArray(args) && args.every((entry) => typeof entry === "string") ? { args: args as string[] } : {}),
      ...(typeof env === "object" && env != null && Object.values(env).every((entry) => typeof entry === "string") ? { env: env as Record<string, string> } : {}),
    };
  }
  if (typeof url === "string" && url.trim().length > 0) return { url: url.trim() };
  return undefined;
}

export function parseLocalMcpServersConfig(raw: string): LocalMcpRuntimeConfig {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${LOCAL_MCP_SERVERS_FILENAME} is not valid JSON.`); }
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) throw new Error(`${LOCAL_MCP_SERVERS_FILENAME} must contain an object.`);
  const source = Object.hasOwn(parsed as object, "mcpServers") ? (parsed as { mcpServers: unknown }).mcpServers : parsed;
  if (typeof source !== "object" || source == null || Array.isArray(source)) throw new Error(`${LOCAL_MCP_SERVERS_FILENAME} must map server names to configs.`);
  const mcpServers: Record<string, LocalMcpServerConfig> = {};
  for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
    if (name.trim().length === 0) continue;
    const config = parseServerEntry(value);
    if (config != null) mcpServers[name.trim()] = config;
  }
  return { mcpServers };
}

export async function readLocalMcpServersConfig(
  sandRootDir: string,
  readFileImpl: (path: string, encoding: "utf8") => Promise<string> = (path, encoding) => readFile(path, encoding),
  filename: string = LOCAL_MCP_SERVERS_FILENAME,
): Promise<LocalMcpRuntimeConfig | null> {
  try {
    const raw = await readFileImpl(join(sandRootDir, filename), "utf8");
    return parseLocalMcpServersConfig(raw);
  } catch { return null; }
}
