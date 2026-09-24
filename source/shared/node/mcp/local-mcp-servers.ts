import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isLocalAdminEnabled } from "../local-admin.js";
import { getSandRootDir } from "../../../host/host-paths.js";

// Zero-OAuth plugin surface for local admin: MCP server definitions live in a
// file next to settings.json instead of Cursor's dashboard. The shape mirrors
// the familiar `{ "mcpServers": { name: { command, args, env } | { url } } }`
// convention (Claude Code / Cursor style), so existing configs drop in as-is.

export interface LocalMcpServerConfig { readonly command?: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>>; readonly cwd?: string; readonly url?: string; readonly headers?: Readonly<Record<string, string>>; readonly type?: "http" | "sse" }
export interface LocalMcpRuntimeConfig { readonly mcpServers: Readonly<Record<string, LocalMcpServerConfig>> }

export const LOCAL_MCP_SERVERS_FILENAME = "mcp-servers.json";
// The file lives in its own folder so the box can bind the folder rather than
// the file: a single-file bind keeps the old inode, so a save that replaces
// the file (the writer below, most editors) left the box reading a missing
// file, and a file created after the container existed was never mounted.
export const LOCAL_MCP_PLUGINS_DIRNAME = "plugins";

// When the plugins folder exists it is the only source; the old location next
// to settings.json is read only before the one-time move.
export function localMcpServersPath(sandRootDir: string, filename: string = LOCAL_MCP_SERVERS_FILENAME): string {
  const pluginsDir = join(sandRootDir, LOCAL_MCP_PLUGINS_DIRNAME);
  return join(existsSync(pluginsDir) ? pluginsDir : sandRootDir, filename);
}

// Creates the plugins folder (owner-only) and moves an existing file from the
// old location into it once. A file already in the folder wins; the old one
// is then left alone.
export function prepareLocalMcpPluginsDir(sandRootDir: string): string {
  const pluginsDir = join(sandRootDir, LOCAL_MCP_PLUGINS_DIRNAME);
  mkdirSync(pluginsDir, { recursive: true, mode: 0o700 });
  const legacy = join(sandRootDir, LOCAL_MCP_SERVERS_FILENAME);
  const target = join(pluginsDir, LOCAL_MCP_SERVERS_FILENAME);
  const legacyStat = lstatSync(legacy, { throwIfNoEntry: false });
  if (legacyStat?.isFile() === true && !existsSync(target)) renameSync(legacy, target);
  return pluginsDir;
}

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
      ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    };
  }
  if (typeof url === "string" && url.trim().length > 0) {
    const headers = record.headers;
    if (headers !== undefined && (typeof headers !== "object" || headers == null || Array.isArray(headers) || Object.values(headers).some(value => typeof value !== "string"))) throw new Error("MCP HTTP headers must contain string values.");
    return { url: url.trim(), ...(headers === undefined ? {} : { headers: headers as Record<string, string> }), ...(record.type === "http" || record.type === "sse" ? { type: record.type } : {}) };
  }
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
    const raw = await readFileImpl(localMcpServersPath(sandRootDir, filename), "utf8");
    return parseLocalMcpServersConfig(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// One swap shared by the host-side and desktop-side MCP managers: under local
// admin the definition source is the local file and the dashboard display
// provider is dropped so the manager falls back to runtime rows.
export interface McpProviderSources { readonly accountConfigProvider?: (() => Promise<unknown>) | undefined; readonly accountServersProvider?: (() => Promise<unknown>) | undefined }

export function applyLocalAdminMcpSources(sources: McpProviderSources): McpProviderSources {
  if (!isLocalAdminEnabled()) return sources;
  const result: McpProviderSources = { ...sources, accountConfigProvider: async () => await readLocalMcpServersConfig(getSandRootDir()) };
  delete (result as { accountServersProvider?: unknown }).accountServersProvider;
  return result;
}

// Account-writer implementation backed by mcp-servers.json so UI add/remove
// of local servers works with no dashboard. Marketplace plugin mutation is
// refused honestly instead of calling the official backend.
export interface LocalMcpServersFileWriterDeps {
  readonly readFile?: (path: string, encoding: "utf8") => string;
  readonly writeFile?: (path: string, data: string) => void;
  readonly rename?: (from: string, to: string) => void;
}

export function createLocalMcpServersFileWriter(sandRootDir: string, deps: LocalMcpServersFileWriterDeps = {}) {
  const readFileImpl = deps.readFile ?? ((path, encoding) => readFileSync(path, encoding));
  const writeFileImpl = deps.writeFile ?? ((path, data) => writeFileSync(path, data, { encoding: "utf8", mode: 0o600 }));
  const renameImpl = deps.rename ?? renameSync;
  const readConfig = (): LocalMcpRuntimeConfig => {
    try { return parseLocalMcpServersConfig(readFileImpl(localMcpServersPath(sandRootDir), "utf8")); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mcpServers: {} };
      throw error;
    }
  };
  return {
    async getConfigForEdit() { return { config: readConfig(), serverIdsByName: {} as Readonly<Record<string, bigint>> }; },
    async setConfig(config: { mcpServers?: unknown }) {
      const servers = typeof config.mcpServers === "object" && config.mcpServers != null ? config.mcpServers as Record<string, LocalMcpServerConfig> : {};
      const target = join(prepareLocalMcpPluginsDir(sandRootDir), LOCAL_MCP_SERVERS_FILENAME);
      const temporary = `${target}.${process.pid}.tmp`;
      writeFileImpl(temporary, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
      renameImpl(temporary, target);
    },
    async installPlugin() { throw new Error("Marketplace plugins need a Cursor account. Add local MCP servers to mcp-servers.json instead."); },
    async updatePluginInstall() { throw new Error("Marketplace plugins need a Cursor account. Add local MCP servers to mcp-servers.json instead."); },
    async uninstallPlugin() { throw new Error("Marketplace plugins need a Cursor account. Remove local MCP servers from mcp-servers.json instead."); },
  };
}
