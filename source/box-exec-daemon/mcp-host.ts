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
  connected: boolean;
  readonly generation: number;
  supportsListChanged: boolean;
  catalogRevision: number;
  listedRevision: number | undefined;
};

type ServerSlot = {
  tail: Promise<void>;
  connection: LoadedServer | undefined;
  pendingChanges: number;
  pendingChange: Promise<void> | undefined;
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
  } catch {
    throw new Error("MCP server config is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("MCP server config must be a JSON object");
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (servers === undefined || servers === null) return {};
  if (typeof servers !== "object" || Array.isArray(servers)) throw new Error("MCP server config must carry an mcpServers object");
  const result: Record<string, ServerConfig> = Object.create(null);
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
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(args)) result[key] = value.toJson();
  return result;
}

export class BoxMcpHost {
  private readonly slots = new Map<string, ServerSlot>();
  private configured = new Map<string, ServerConfig>();
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private loads: Promise<unknown> = Promise.resolve();
  private nextGeneration = 0;
  private readonly clients = new Set<Client>();
  private readonly transports = new Map<Client, Transport>();
  private readonly closedTransports = new WeakSet<Transport>();
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

  private requestSignal(signal?: AbortSignal): AbortSignal {
    return signal == null ? this.shutdown.signal : AbortSignal.any([signal, this.shutdown.signal]);
  }

  // 接受请求时立即预约位置，配置切换与同一服务器的调用共享顺序。
  private takeTurn<T>(slot: ServerSlot, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("The MCP host has been disposed."));
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error("MCP request canceled."));
    const turn = slot.tail.then(() => {
      if (this.disposed) throw new Error("The MCP host has been disposed.");
      if (signal.aborted) throw signal.reason ?? new Error("MCP request canceled.");
      return operation();
    });
    slot.tail = turn.then(() => undefined, () => undefined);
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error("MCP request canceled."));
      signal.addEventListener("abort", abort, { once: true });
      turn.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }

  load(configJson: string): Promise<string[]> {
    const configs = parseMcpServerConfigs(configJson);
    if (this.disposed) return Promise.reject(new Error("The MCP host has been disposed."));
    const changes: Promise<void>[] = [];
    for (const name of new Set([...this.slots.keys(), ...Object.keys(configs)])) {
      let slot = this.slots.get(name);
      if (slot === undefined) {
        slot = { tail: Promise.resolve(), connection: undefined, pendingChanges: 0, pendingChange: undefined };
        this.slots.set(name, slot);
      }
      const config = configs[name];
      const previous = this.configured.get(name);
      if (config == null && previous == null) {
        if (slot.pendingChanges > 0 && slot.pendingChange != null) { changes.push(slot.pendingChange); continue; }
        if (slot.connection == null) continue;
      }
      if (config != null && previous != null && sameConfig(previous, config)) {
        if (slot.pendingChanges > 0 && slot.pendingChange != null) { changes.push(slot.pendingChange); continue; }
        if (slot.connection?.connected === true) continue;
      }
      const selected = slot;
      selected.pendingChanges++;
      const change = this.takeTurn(selected, this.shutdown.signal, async () => {
        const old = selected.connection;
        selected.connection = undefined;
        if (old != null) {
          try { await this.closeServer(name, old); }
          catch (error) {
            old.connected = false;
            old.status = "error";
            old.errorMessage = `MCP server close failed: ${error instanceof Error ? error.message : String(error)}`;
            old.tools = [];
            old.listedRevision = undefined;
            selected.connection = old;
            throw error;
          }
        }
        if (this.disposed) throw new Error("The MCP host has been disposed.");
        if (config != null) {
          const server = await this.connect(name, config);
          if (this.disposed) { await this.closeServer(name, server); throw new Error("The MCP host has been disposed."); }
          selected.connection = server;
        }
      }).finally(() => { selected.pendingChanges--; });
      selected.pendingChange = change;
      changes.push(change);
    }
    this.configured = new Map(Object.entries(configs));
    const applied = Promise.all(changes).then(() => Object.keys(configs));
    applied.catch(() => undefined);
    const completed = this.loads.then(() => applied);
    this.loads = completed.then(() => undefined, () => undefined);
    return completed;
  }

  private async connect(name: string, config: ServerConfig): Promise<LoadedServer> {
    let connected: LoadedServer;
    let transportClosed = false;
    const client = new Client({ name: `grok-bot-box-daemon/${name}`, version: "1" }, {
      capabilities: {},
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => {
        connected.catalogRevision++;
        connected.listedRevision = undefined;
      } } },
    });
    connected = {
      config, client, connected: false, generation: ++this.nextGeneration,
      status: "error", errorMessage: undefined, tools: [], instructions: [],
      supportsListChanged: false, catalogRevision: 0, listedRevision: undefined,
    };
    client.onclose = () => {
      transportClosed = true;
      this.clients.delete(client);
      const closed = this.transports.get(client);
      if (closed != null) this.closedTransports.add(closed);
      this.transports.delete(client);
      connected.connected = false;
      connected.status = "error";
      connected.errorMessage = "MCP transport closed.";
      connected.tools = [];
      connected.listedRevision = undefined;
      connected.catalogRevision++;
    };
    client.onerror = error => {
      if (transportClosed) return;
      connected.listedRevision = undefined;
      connected.catalogRevision++;
      connected.status = "error";
      connected.errorMessage = `MCP transport error: ${error.message}`;
    };
    this.clients.add(client);
    try {
      const transport = "url" in config
        ? new StreamableHTTPClientTransport(new URL(String(config.url)), config.headers == null ? {} : { requestInit: { headers: config.headers } })
        : new StdioClientTransport({ command: config.command, ...(config.args === undefined ? {} : { args: [...config.args] }), env: serverEnvironment(config), cwd: config.cwd ?? this.options.workspaceRoot });
      const adaptedTransport = this.trackCancellationDelivery(adaptSdkTransport(transport, { waitForClose: !("url" in config) }));
      this.transports.set(client, adaptedTransport);
      await client.connect(adaptedTransport, { timeout: this.connectTimeoutMs, signal: this.shutdown.signal });
      if (transportClosed) throw new Error("MCP transport closed during initialization.");
      const server = await client.getServerVersion();
      const instructions = client.getInstructions();
      connected.connected = true;
      connected.status = "connected";
      connected.errorMessage = undefined;
      connected.supportsListChanged = client.getServerCapabilities()?.tools?.listChanged === true;
      connected.instructions = instructions == null || instructions.length === 0 ? [] : [new McpInstructions({ serverName: name, serverIdentifier: name, instructions })];
      this.log(`mcp server "${name}" connected${server == null ? "" : ` (${server.name} ${server.version})`}`);
      return connected;
    } catch (error) {
      await this.closeClient(client);
      // A server that will not start is a per-server failure: the operator sees
      // which plugin is down and why, and the others still work.
      const message = error instanceof Error ? error.message : String(error);
      this.log(`mcp server "${name}" did not start: ${message}`);
      connected.status = "error";
      connected.errorMessage = message;
      return connected;
    }
  }

  private trackCancellationDelivery(transport: Transport): Transport {
    const pending = new Set<Promise<void>>();
    const failures: unknown[] = [];
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      const delivery = send(message, options);
      if ("method" in message && message.method === "notifications/cancelled") {
        pending.add(delivery);
        delivery.then(() => pending.delete(delivery), error => { pending.delete(delivery); failures.push(error); });
      }
      return delivery;
    };
    const close = transport.close.bind(transport);
    let closing: Promise<void> | undefined;
    transport.close = () => closing ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const errors: unknown[] = [];
      try {
        // HTTP close 会中止 fetch；先完成已经开始的取消通知发送。
        await Promise.race([
          (async () => { while (pending.size > 0) await Promise.allSettled([...pending]); })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MCP cancellation delivery timed out")), this.connectTimeoutMs); }),
        ]);
        if (failures.length > 0) throw new AggregateError(failures, "MCP cancellation delivery failed");
      } catch (error) {
        errors.push(error);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      try {
        await close();
        this.closedTransports.add(transport);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) throw new AggregateError(errors, "MCP transport shutdown failed");
    })();
    return transport;
  }

  private async closeServer(name: string, server: LoadedServer): Promise<void> {
    try {
      await this.closeClient(server.client);
    } catch (error) {
      this.log(`mcp server "${name}" did not close cleanly: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private async closeClient(client: Client): Promise<void> {
    const transport = this.transports.get(client);
    try {
      if (transport == null) await client.close();
      else if (!this.closedTransports.has(transport)) await transport.close();
    } finally {
      if (transport == null || this.closedTransports.has(transport)) {
        this.clients.delete(client);
        this.transports.delete(client);
      }
    }
  }

  private toolName(name: string, toolName: string): string {
    // Unique per server, because every stdio server's tools reach the model
    // through one flat list.
    return `${name}__${toolName}`;
  }

  private async refreshTools(name: string, server: LoadedServer, signal: AbortSignal, force = false): Promise<void> {
    if (!server.connected) return;
    if (!force && server.supportsListChanged && server.listedRevision === server.catalogRevision) return;
    try {
      const generation = server.generation;
      const deadline = performance.now() + this.connectTimeoutMs;
      while (true) {
        const revision = server.catalogRevision;
        const listedTools = [];
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        do {
          if (cursor != null) {
            if (seenCursors.has(cursor)) throw new Error(`MCP server "${name}" repeated pagination cursor "${cursor}"`);
            seenCursors.add(cursor);
          }
          const remaining = deadline - performance.now();
          if (remaining <= 0) throw new Error(`MCP server "${name}" did not publish a stable tool list before the discovery timeout`);
          const listed = await server.client.listTools(cursor == null ? undefined : { cursor }, { timeout: remaining, signal });
          listedTools.push(...listed.tools);
          cursor = listed.nextCursor;
        } while (cursor != null && cursor.length > 0);
        if (!server.connected || this.slots.get(name)?.connection?.generation !== generation) throw new Error("MCP connection changed during tool listing.");
        if (revision !== server.catalogRevision) continue;
        server.tools = listedTools.map((tool) => new McpToolDefinition({
          name: this.toolName(name, tool.name),
          providerIdentifier: name,
          toolName: tool.name,
          description: tool.description ?? "",
          ...(tool.inputSchema === undefined ? {} : { inputSchema: Value.fromJson(tool.inputSchema as JsonValue) }),
        }));
        server.errorMessage = undefined;
        server.status = "connected";
        server.listedRevision = revision;
        return;
      }
    } catch (error) {
      if (signal.aborted) throw error;
      server.tools = [];
      server.listedRevision = undefined;
      server.status = "error";
      server.errorMessage = `Tool listing failed: ${error instanceof Error ? error.message : String(error)}`;
      this.log(`mcp server "${name}" could not list tools: ${server.errorMessage}`);
    }
  }

  private serverSnapshot(name: string, loaded: LoadedServer | undefined): McpStateServer {
    if (loaded == null) return new McpStateServer({ serverIdentifier: name, serverName: name, status: "error", errorMessage: "MCP server is not loaded.", tools: [], instructions: [] });
    return new McpStateServer({
      serverIdentifier: name, serverName: name, status: loaded.status,
      ...(loaded.errorMessage == null ? {} : { errorMessage: loaded.errorMessage }),
      tools: loaded.tools, instructions: loaded.instructions,
    });
  }

  async listState(args: McpStateExecArgs, requestSignal?: AbortSignal): Promise<McpStateExecResult> {
    const signal = this.requestSignal(requestSignal);
    if (this.disposed) return new McpStateExecResult({ result: { case: "error", value: new McpStateError({ error: "The MCP host has been disposed." }) } });
    if (signal.aborted) throw signal.reason ?? new Error("MCP tool listing canceled.");
    const requested = args.serverIdentifiers.length === 0
      ? args.kickOnly === true
        ? [...this.slots].filter(([, slot]) => slot.connection != null).map(([name]) => name)
        : [...new Set([...this.configured.keys(), ...[...this.slots].filter(([, slot]) => slot.connection?.status === "error").map(([name]) => name)])]
      : [...args.serverIdentifiers];
    const missing = requested.filter(name => !this.configured.has(name) && this.slots.get(name)?.connection == null);
    if (missing.length > 0 && missing.length === requested.length) {
      return new McpStateExecResult({
        result: { case: "error", value: new McpStateError({ error: `No MCP server is loaded on this computer (requested: ${missing.join(", ")}).` }) },
      });
    }
    try {
      const servers = await Promise.all(requested.map(name => {
        const slot = this.slots.get(name);
        // 状态快照直接读取当前连接，不排在工具调用之后。
        if (args.kickOnly === true || slot == null) return this.serverSnapshot(name, slot?.connection);
        return this.takeTurn(slot, signal, async () => {
          const loaded = slot.connection;
          if (loaded != null) await this.refreshTools(name, loaded, signal);
          return this.serverSnapshot(name, loaded);
        });
      }));
      return new McpStateExecResult({ result: { case: "success", value: new McpStateSuccess({ servers }) } });
    } catch (error) {
      return new McpStateExecResult({
        result: { case: "error", value: new McpStateError({ error: `MCP tool discovery failed: ${error instanceof Error ? error.message : String(error)}` }) },
      });
    }
  }

  callTool(args: McpArgs, requestSignal?: AbortSignal): Promise<McpResult> {
    const signal = this.requestSignal(requestSignal);
    if (this.disposed) return Promise.resolve(new McpResult({ result: { case: "error", value: new McpError({ error: "The MCP host has been disposed." }) } }));
    const slot = this.slots.get(args.providerIdentifier);
    if (slot == null) return Promise.resolve(new McpResult({ result: { case: "serverNotFound", value: new McpServerNotFound({ name: args.providerIdentifier, availableServers: [...this.configured.keys()] }) } }));
    return this.takeTurn(slot, signal, async () => {
      if (signal.aborted) throw signal.reason ?? new Error("MCP tool call canceled.");
      // At this boundary `name` is the server's own tool and `toolName` is the
      // label the caller used: the gateway swaps them on the way here, and the
      // HTTP execution path reads the server's tool from `name` the same way.
      const toolName = args.name.length > 0 ? args.name : args.toolName;
      const displayName = args.toolName.length > 0 ? args.toolName : args.name;
      const loaded = slot.connection;
      if (loaded == null) {
        return new McpResult({
          result: { case: "serverNotFound", value: new McpServerNotFound({ name: args.providerIdentifier, availableServers: [...this.configured.keys()] }) },
        });
      }
      if (!loaded.connected) {
        return new McpResult({ result: { case: "error", value: new McpError({ error: `MCP server "${args.providerIdentifier}" is not running: ${loaded.errorMessage ?? loaded.status}` }) } });
      }
      // The answer to "does this tool exist" comes from the list this daemon
      // enumerated, never from the wording of a server's error: a tool added
      // since the last listing is found by re-listing before refusing.
      const knows = (): boolean => loaded.tools.some((tool) => tool.toolName === toolName);
      if (!knows() || loaded.listedRevision !== loaded.catalogRevision) await this.refreshTools(args.providerIdentifier, loaded, signal, !knows());
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
        const result = await loaded.client.callTool({ name: toolName, arguments: plainToolArguments(args.args) }, undefined, { timeout: this.callTimeoutMs, signal });
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
      await Promise.all([...this.slots.values()].map(slot => slot.tail));
      await this.loads;
      const failures = results.filter(result => result.status === "rejected");
      if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), "MCP host close failed");
      this.clients.clear();
      this.transports.clear();
      this.slots.clear();
      this.configured.clear();
    })();
    return this.closing;
  }
}
