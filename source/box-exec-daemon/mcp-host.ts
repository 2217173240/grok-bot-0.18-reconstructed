import { Value, type JsonValue } from "@bufbuild/protobuf";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

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
// HTTP servers stay on the backend and never reach here.
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

type LoadedServer = {
  readonly config: StdioServerConfig;
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
export function parseMcpServerConfigs(configJson: string): Record<string, StdioServerConfig> {
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
  const result: Record<string, StdioServerConfig> = {};
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`MCP server "${name}" must be an object`);
    const record = raw as Record<string, unknown>;
    if (typeof record.command !== "string" || record.command.length === 0) {
      throw new Error(`MCP server "${name}" needs a command; HTTP servers are executed on the backend and do not belong in this config`);
    }
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

function sameConfig(left: StdioServerConfig, right: StdioServerConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
        if (this.servers.has(name)) {
          loaded.push(name);
          continue;
        }
        const server = await this.connect(name, config);
        this.servers.set(name, server);
        loaded.push(name);
      }
      return loaded;
    });
  }

  private async connect(name: string, config: StdioServerConfig): Promise<LoadedServer> {
    const client = new Client({ name: `grok-bot-box-daemon/${name}`, version: "1" }, { capabilities: {} });
    try {
      const transport = new StdioClientTransport({
        command: config.command,
        ...(config.args === undefined ? {} : { args: [...config.args] }),
        env: serverEnvironment(config),
        cwd: config.cwd ?? this.options.workspaceRoot,
      });
      await client.connect(transport, { timeout: this.connectTimeoutMs });
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
      this.log(`mcp server "${name}" connected${server == null ? "" : ` (${server.name} ${server.version})`}`);
      return connected;
    } catch (error) {
      await client.close().catch(() => undefined);
      // A server that will not start is a per-server failure: the operator sees
      // which plugin is down and why, and the others still work.
      const message = error instanceof Error ? error.message : String(error);
      this.log(`mcp server "${name}" did not start: ${message}`);
      return { config, client, status: "error", errorMessage: message, tools: [], instructions: [] };
    }
  }

  private async closeServer(name: string, server: LoadedServer): Promise<void> {
    try {
      await server.client.close();
    } catch (error) {
      this.log(`mcp server "${name}" did not close cleanly: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private toolName(name: string, toolName: string): string {
    // Unique per server, because every stdio server's tools reach the model
    // through one flat list.
    return `${name}__${toolName}`;
  }

  private async refreshTools(name: string, server: LoadedServer): Promise<void> {
    if (server.status !== "connected") return;
    try {
      const listed = await server.client.listTools(undefined, { timeout: this.connectTimeoutMs });
      server.tools = listed.tools.map((tool) => new McpToolDefinition({
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
      const requested = args.serverIdentifiers.length === 0 ? [...this.servers.keys()] : [...args.serverIdentifiers];
      const missing = requested.filter((name) => !this.servers.has(name));
      if (missing.length > 0 && requested.length === missing.length) {
        return new McpStateExecResult({
          result: { case: "error", value: new McpStateError({ error: `No MCP server is loaded on this computer (requested: ${missing.join(", ")}).` }) },
        });
      }
      try {
        // kickOnly is the status surface: it must not block on a slow server, so
        // it answers from the tool list the last real listing produced.
        if (args.kickOnly !== true) for (const name of requested) await this.refreshTools(name, this.servers.get(name)!);
        const servers = requested.filter((name) => this.servers.has(name)).map((name) => {
          const loaded = this.servers.get(name)!;
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
      if (!knows()) {
        return new McpResult({ result: { case: "toolNotFound", value: new McpToolNotFound({ name: displayName, availableTools: loaded.tools.map((tool) => tool.toolName) }) } });
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

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.queue.catch(() => undefined);
    const servers = [...this.servers];
    this.servers.clear();
    for (const [name, server] of servers) await this.closeServer(name, server);
  }
}
