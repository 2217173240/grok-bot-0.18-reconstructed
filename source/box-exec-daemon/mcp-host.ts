import { Value, type JsonValue } from "@bufbuild/protobuf";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { adaptSdkTransport } from "../shared/node/mcp/sdk-transport.js";

import {
  McpError,
  McpImageContent,
  McpResult,
  McpServerNotFound,
  McpStateError,
  McpStateExecResult,
  McpStateServer,
  McpStateSuccess,
  McpSuccess,
  McpTextContent,
  McpToolNotFound,
  McpToolResultContentItem,
  type McpArgs,
  type McpStateExecArgs,
} from "../packages/proto/generated/agent/v1/mcp_exec_pb.js";
import { McpInstructions, McpToolDefinition } from "../packages/proto/generated/agent/v1/mcp_pb.js";

// The MCP host for the local computer.
//
// stdio MCP servers belong on the computer the agent acts on, so this daemon
// owns them: it spawns each configured server, keeps one MCP client per server,
// and answers the two exec requests the host sends (list state, call tool).
// local-admin 的 HTTP MCP 也由容器直接连接。
//
// Nothing is invented about the protocol: the official client speaks it, the
// config is the standard { mcpServers: { name: { command, args, env, cwd } } }
// shape, and a server that fails to start is reported per server instead of
// failing the whole load — one broken plugin must not hide the rest.

export const BOX_MCP_CONNECT_TIMEOUT_MS = 20_000;
export const BOX_MCP_CALL_TIMEOUT_MS = 120_000;

type StdioServerConfig = {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
};
type HttpServerConfig = { readonly url: string; readonly headers?: Readonly<Record<string, string>> };
type ServerConfig = StdioServerConfig | HttpServerConfig;

type LoadedServer = {
  readonly config: ServerConfig;
  readonly client: Client;
  status: string;
  errorMessage: string | undefined;
  tools: McpToolDefinition[];
  instructions: McpInstructions[];
};

export interface BoxMcpHostOptions {
  /** The working directory a server starts in when its config names none. */
  readonly workspaceRoot: string;
  readonly connectTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly log?: (message: string) => void;
}

// Reads the servers out of a pushed config. A payload that is not the standard
// shape is a caller bug and is reported as one rather than read as "none".
export function parseMcpServerConfigs(configJson: string): Record<string, ServerConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch (error) {
    throw new Error(`MCP server config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("MCP server config must be a JSON object");
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (servers === undefined || servers === null) return {};
  if (typeof servers !== "object" || Array.isArray(servers)) throw new Error("MCP server config must carry an mcpServers object");
  const result: Record<string, ServerConfig> = {};
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`MCP server "${name}" must be an object`);
    const record = raw as Record<string, unknown>;
    if (typeof record.url === "string" && record.url.length > 0) {
      if (record.type === "sse") throw new Error(`MCP server "${name}" requires the Streamable HTTP endpoint; legacy SSE is not supported by this computer.`);
      const endpoint = new URL(record.url);
      if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error(`MCP server "${name}" requires an HTTP or HTTPS URL`);
      if (record.headers !== undefined && (typeof record.headers !== "object" || record.headers === null || Array.isArray(record.headers) || Object.values(record.headers as Record<string, unknown>).some((item) => typeof item !== "string"))) throw new Error(`MCP server "${name}" has a non-string headers entry`);
      result[name] = { url: record.url, ...(record.headers === undefined ? {} : { headers: record.headers as Record<string, string> }) };
      continue;
    }
    if (typeof record.command !== "string" || record.command.length === 0) throw new Error(`MCP server "${name}" needs a command or url`);
    const args = record.args;
    if (args !== undefined && (!Array.isArray(args) || args.some((item) => typeof item !== "string"))) throw new Error(`MCP server "${name}" has a non-string args entry`);
    const env = record.env;
    if (env !== undefined && (typeof env !== "object" || env === null || Array.isArray(env) || Object.values(env as Record<string, unknown>).some((item) => typeof item !== "string"))) {
      throw new Error(`MCP server "${name}" has a non-string env entry`);
    }
    if (record.cwd !== undefined && typeof record.cwd !== "string") throw new Error(`MCP server "${name}" has a non-string cwd`);
    result[name] = {
      command: record.command,
      ...(args === undefined ? {} : { args: args as string[] }),
      ...(env === undefined ? {} : { env: env as Record<string, string> }),
      ...(record.cwd === undefined ? {} : { cwd: record.cwd as string }),
    };
  }
  return result;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function sameConfig(left: ServerConfig, right: ServerConfig): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function serverEnvironment(config: StdioServerConfig): Record<string, string> {
  // The config's entries are additions to the environment the daemon runs with:
  // replacing it outright would drop PATH and make most servers unspawnable.
  return { ...getDefaultEnvironment(), ...(config.env ?? {}) };
}

// Tool arguments travel as protobuf Value messages; the MCP client takes plain
// JSON.
function plainToolArguments(args: McpArgs["args"]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) result[key] = value.toJson();
  return result;
}

export class BoxMcpHost {
  private readonly servers = new Map<string, LoadedServer>();
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly clients = new Set<Client>();
  private readonly transports = new Map<Client, Transport>();
  private readonly shutdown = new AbortController();
  private closing: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly options: BoxMcpHostOptions) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? BOX_MCP_CONNECT_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? BOX_MCP_CALL_TIMEOUT_MS;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  // Serialised so a config push and a tool call cannot interleave connection
  // bookkeeping: the host pushes on change and calls on demand.
  private takeTurn<T>(operation: () => Promise<T>): Promise<T> {
    const turn = this.queue.then(operation);
    this.queue = turn.then(() => undefined, () => undefined);
    return turn;
  }

  load(configJson: string): Promise<string[]> {
    const configs = parseMcpServerConfigs(configJson);
    return this.takeTurn(async () => {
      if (this.disposed) throw new Error("The MCP host has been disposed.");
      for (const [name, loaded] of [...this.servers]) {
        if (configs[name] != null && sameConfig(loaded.config, configs[name]!)) continue;
        this.servers.delete(name);
        await this.closeServer(name, loaded);
      }
      const loaded: string[] = [];
      for (const [name, config] of Object.entries(configs)) {
        if (this.disposed) throw new Error("The MCP host has been disposed.");
        if (this.servers.has(name) && this.servers.get(name)!.status === "connected") {
          loaded.push(name);
          continue;
        }
        const previous = this.servers.get(name);
        if (previous != null) {
          this.servers.delete(name);
          await this.closeServer(name, previous);
        }
        const server = await this.connect(name, config);
        if (this.disposed) { await this.closeServer(name, server); throw new Error("The MCP host has been disposed."); }
        this.servers.set(name, server);
        loaded.push(name);
      }
      return loaded;
    });
  }

  private async connect(name: string, config: ServerConfig): Promise<LoadedServer> {
    const client = new Client({ name: `grok-bot-box-daemon/${name}`, version: "1" }, { capabilities: {} });
    this.clients.add(client);
    try {
      const transport = "url" in config
        ? new StreamableHTTPClientTransport(new URL(String(config.url)), config.headers == null ? {} : { requestInit: { headers: config.headers } })
        : new StdioClientTransport({ command: config.command, ...(config.args === undefined ? {} : { args: [...config.args] }), env: serverEnvironment(config), cwd: config.cwd ?? this.options.workspaceRoot });
      const adaptedTransport = adaptSdkTransport(transport, { waitForClose: !("url" in config) });
      this.transports.set(client, adaptedTransport);
      await client.connect(adaptedTransport, { timeout: this.connectTimeoutMs, signal: this.shutdown.signal });
      const server = await client.getServerVersion();
      const instructions = client.getInstructions();
      const connected: LoadedServer = {
        config,
        client,
        status: "connected",
        errorMessage: undefined,
        tools: [],
        instructions: instructions == null || instructions.length === 0 ? [] : [new McpInstructions({ serverName: name, serverIdentifier: name, instructions })],
      };
      client.onclose = () => {
        this.clients.delete(client);
        connected.status = "error";
        connected.errorMessage = "MCP transport closed.";
      };
      this.log(`mcp server "${name}" connected${server == null ? "" : ` (${server.name} ${server.version})`}`);
      return connected;
    } catch (error) {
      await this.closeClient(client);
      // A server that will not start is a per-server failure: the operator sees
      // which plugin is down and why, and the others still work.
      const message = error instanceof Error ? error.message : String(error);
      this.log(`mcp server "${name}" did not start: ${message}`);
      return { config, client, status: "error", errorMessage: message, tools: [], instructions: [] };
    }
  }

  private async closeServer(name: string, server: LoadedServer): Promise<void> {
    try {
      await this.closeClient(server.client);
    } catch (error) {
      this.log(`mcp server "${name}" did not close cleanly: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async closeClient(client: Client): Promise<void> {
    const transport = this.transports.get(client);
    const results = await Promise.allSettled([client.close(), ...(transport == null ? [] : [transport.close()])]);
    this.clients.delete(client);
    this.transports.delete(client);
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), "MCP client close failed");
  }

  private toolName(name: string, toolName: string): string {
    // Unique per server, because every stdio server's tools reach the model
    // through one flat list.
    return `${name}__${toolName}`;
  }

  private async refreshTools(name: string, server: LoadedServer): Promise<void> {
    if (server.status !== "connected") return;
    try {
      const listedTools = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      do {
        if (cursor != null) {
          if (seenCursors.has(cursor)) throw new Error(`MCP server "${name}" repeated pagination cursor "${cursor}"`);
          seenCursors.add(cursor);
        }
        const listed = await server.client.listTools(cursor == null ? undefined : { cursor }, { timeout: this.connectTimeoutMs });
        listedTools.push(...listed.tools);
        cursor = listed.nextCursor;
      } while (cursor != null && cursor.length > 0);
      server.tools = listedTools.map((tool) => new McpToolDefinition({
        name: this.toolName(name, tool.name),
        providerIdentifier: name,
        toolName: tool.name,
        description: tool.description ?? "",
        ...(tool.inputSchema === undefined ? {} : { inputSchema: Value.fromJson(tool.inputSchema as JsonValue) }),
      }));
      server.errorMessage = undefined;
      server.status = "connected";
    } catch (error) {
      server.status = "error";
      server.errorMessage = `Tool listing failed: ${error instanceof Error ? error.message : String(error)}`;
      this.log(`mcp server "${name}" could not list tools: ${server.errorMessage}`);
    }
  }

  listState(args: McpStateExecArgs): Promise<McpStateExecResult> {
    return this.takeTurn(async () => {
      if (this.disposed) return new McpStateExecResult({ result: { case: "error", value: new McpStateError({ error: "The MCP host has been disposed." }) } });
      const requested = args.serverIdentifiers.length === 0 ? [...this.servers.keys()] : [...args.serverIdentifiers];
      const missing = requested.filter((name) => !this.servers.has(name));
      if (missing.length > 0 && missing.length === requested.length) {
        return new McpStateExecResult({
          result: { case: "error", value: new McpStateError({ error: `No MCP server is loaded on this computer (requested: ${missing.join(", ")}).` }) },
        });
      }
      try {
        // kickOnly is the status surface: it must not block on a slow server, so
        // it answers from the tool list the last real listing produced.
        if (args.kickOnly !== true) for (const name of requested) {
          const loaded = this.servers.get(name);
          if (loaded != null) await this.refreshTools(name, loaded);
        }
        const servers = requested.map((name) => {
          const loaded = this.servers.get(name);
          if (loaded == null) return new McpStateServer({ serverIdentifier: name, serverName: name, status: "error", errorMessage: "MCP server is not loaded.", tools: [], instructions: [] });
          return new McpStateServer({
            serverIdentifier: name,
            serverName: name,
            status: loaded.status,
            ...(loaded.errorMessage == null ? {} : { errorMessage: loaded.errorMessage }),
            tools: loaded.tools,
            instructions: loaded.instructions,
          });
        });
        return new McpStateExecResult({ result: { case: "success", value: new McpStateSuccess({ servers }) } });
      } catch (error) {
        return new McpStateExecResult({
          result: { case: "error", value: new McpStateError({ error: `MCP tool discovery failed: ${error instanceof Error ? error.message : String(error)}` }) },
        });
      }
    });
  }

  callTool(args: McpArgs): Promise<McpResult> {
    return this.takeTurn(async () => {
      if (this.disposed) return new McpResult({ result: { case: "error", value: new McpError({ error: "The MCP host has been disposed." }) } });
      // At this boundary `name` is the server's own tool and `toolName` is the
      // label the caller used: the gateway swaps them on the way here, and the
      // HTTP execution path reads the server's tool from `name` the same way.
      const toolName = args.name.length > 0 ? args.name : args.toolName;
      const displayName = args.toolName.length > 0 ? args.toolName : args.name;
      const loaded = this.servers.get(args.providerIdentifier);
      if (loaded == null) {
        return new McpResult({
          result: { case: "serverNotFound", value: new McpServerNotFound({ name: args.providerIdentifier, availableServers: [...this.servers.keys()] }) },
        });
      }
      if (loaded.status !== "connected") {
        return new McpResult({ result: { case: "error", value: new McpError({ error: `MCP server "${args.providerIdentifier}" is not running: ${loaded.errorMessage ?? loaded.status}` }) } });
      }
      // The answer to "does this tool exist" comes from the list this daemon
      // enumerated, never from the wording of a server's error: a tool added
      // since the last listing is found by re-listing before refusing.
      const knows = (): boolean => loaded.tools.some((tool) => tool.toolName === toolName);
      if (!knows()) await this.refreshTools(args.providerIdentifier, loaded);
      if (!knows() && loaded.status === "connected") {
        return new McpResult({ result: { case: "toolNotFound", value: new McpToolNotFound({ name: displayName, availableTools: loaded.tools.map((tool) => tool.toolName) }) } });
      }
      if (!knows()) {
        return new McpResult({ result: { case: "error", value: new McpError({ error: `MCP tool discovery failed for "${displayName}": ${loaded.errorMessage ?? "the server is unavailable"}` }) } });
      }
      try {
        // Key names only: an operator needs to see which call arrived, and the
        // values belong to the user's plugin arguments.
        this.log(`mcp tool "${toolName}" on "${args.providerIdentifier}" called with [${Object.keys(args.args).join(", ")}]`);
        const result = await loaded.client.callTool({ name: toolName, arguments: plainToolArguments(args.args) }, undefined, { timeout: this.callTimeoutMs });
        const content = (Array.isArray(result.content) ? result.content : []).flatMap((item): McpToolResultContentItem[] => {
          if (item.type === "text") return [new McpToolResultContentItem({ content: { case: "text", value: new McpTextContent({ text: item.text }) } })];
          if (item.type === "image") return [new McpToolResultContentItem({ content: { case: "image", value: new McpImageContent({ data: Buffer.from(item.data, "base64"), mimeType: item.mimeType }) } })];
          // Resources and audio have no carrier in this protocol version; the
          // text form keeps the payload visible instead of dropping it.
          return [new McpToolResultContentItem({ content: { case: "text", value: new McpTextContent({ text: JSON.stringify(item) }) } })];
        });
        if (content.length === 0) content.push(new McpToolResultContentItem({ content: { case: "text", value: new McpTextContent({ text: "The tool returned no content." }) } }));
        return new McpResult({ result: { case: "success", value: new McpSuccess({ content, isError: result.isError === true }) } });
      } catch (error) {
        return new McpResult({ result: { case: "error", value: new McpError({ error: `MCP tool "${displayName}" on "${args.providerIdentifier}" failed: ${error instanceof Error ? error.message : String(error)}` }) } });
      }
    });
  }

  dispose(): Promise<void> {
    if (this.closing != null) return this.closing;
    this.disposed = true;
    this.shutdown.abort(new Error("The MCP host has been disposed."));
    this.closing = (async () => {
      const active = new Set([...this.clients, ...this.transports.keys()]);
      const results = await Promise.allSettled([...active].map(client => this.closeClient(client)));
      await this.queue;
      this.clients.clear();
      this.transports.clear();
      this.servers.clear();
      const failures = results.filter(result => result.status === "rejected");
      if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), "MCP host close failed");
    })();
    return this.closing;
  }
}
