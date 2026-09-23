import {
  McpArgs,
  McpError,
  McpResult,
  McpStateExecArgs,
  McpStateExecResult
} from "../../../packages/proto/generated/agent/v1/mcp_exec_pb.js";
import { Value, type JsonValue } from "@bufbuild/protobuf";
import { mcpExecutorResource, mcpStateExecutorResource } from "../../../packages/agent-exec/mcp.js";
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.js";
import type { RemoteExecManager } from "../../../packages/agent-exec/remote.js";
import { createContext } from "../../../packages/context/core.js";
import { recordMcpExecErrorClass } from "../../../shared/node/mcp/mcp-diagnostics.js";
import { toJsonArgs } from "../../../shared/node/mcp/mcp-validation.js";
import {
  boxLoadMcpServers,
  boxMcpResourceAccessor,
  type CapableBox
} from "../../box/box-capabilities.js";

export class SandBoxMcpExecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandBoxMcpExecError";
  }
}

export interface BoxMcpTool {
  name: string;
  providerIdentifier: string;
  toolName: string;
  description?: string;
  inputSchema?: unknown;
}

export interface BoxMcpExecPort {
  loadServers(configJson: string): Promise<void>;
  listTools(
    serverIdentifiers: readonly string[],
    options?: { kickOnly?: boolean }
  ): Promise<Array<{
    serverIdentifier: string;
    status: string;
    statusDetail?: string;
    toolCount: number;
    tools: Array<BoxMcpTool & { clientKey: string }>;
  }>>;
  executeTool(args: McpArgs): Promise<McpResult>;
}

export function errorLabel(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

function errorResult(message: string): McpResult {
  return new McpResult({
    result: { case: "error", value: new McpError({ error: message }) }
  });
}

type McpAccessor = ResourceAccessor<RemoteExecManager>;

// The transport carries tool arguments as protobuf Values, and the callers on
// this side supply ordinary JSON: the routed bridge and the CLI child know
// nothing about protobuf. Normalize at this one boundary, the same way the
// backend exec port does, so the serializer never receives a raw value and
// fails while looking for `toJson`.
export function toMcpArgs(args: unknown): McpArgs {
  if (args instanceof McpArgs) return args;
  const raw = (typeof args === "object" && args != null ? args : {}) as Record<string, unknown>;
  const encoded: Record<string, Value> = {};
  if (typeof raw.args === "object" && raw.args != null) {
    for (const [key, value] of Object.entries(toJsonArgs(raw.args as Record<string, unknown>))) encoded[key] = Value.fromJson(value as JsonValue);
  }
  const text = (key: string): string => (typeof raw[key] === "string" ? raw[key] as string : "");
  return new McpArgs({
    name: text("name"),
    providerIdentifier: text("providerIdentifier"),
    toolName: text("toolName"),
    toolCallId: text("toolCallId"),
    args: encoded,
  });
}

export function createBoxSandMcpExec(box: CapableBox): BoxMcpExecPort {
  const ctx = createContext().withName("sandBoxMcp");
  return {
    async loadServers(configJson) {
      await boxLoadMcpServers(box, ctx, configJson);
    },
    async listTools(serverIdentifiers, options) {
      const accessor = await boxMcpResourceAccessor(box, ctx) as McpAccessor;
      const result = await accessor.get(mcpStateExecutorResource).execute(
        ctx,
        new McpStateExecArgs({
          serverIdentifiers: [...serverIdentifiers],
          kickOnly: options?.kickOnly === true
        })
      );
      if (result.result.case !== "success") {
        throw new SandBoxMcpExecError(
          `Box MCP tool discovery failed: ${result.result.case ?? "empty result"}`
        );
      }
      const requested = new Set(serverIdentifiers);
      return result.result.value.servers
        .filter(server => requested.size === 0 || requested.has(server.serverIdentifier))
        .map(server => ({
          serverIdentifier: server.serverIdentifier,
          status: server.status ?? "connected",
          ...(server.errorMessage == null || server.errorMessage.length === 0
            ? {}
            : { statusDetail: server.errorMessage }),
          toolCount: server.tools.length,
          tools: server.tools.map(tool => ({
            name: tool.name,
            providerIdentifier: tool.providerIdentifier,
            toolName: tool.toolName,
            clientKey: server.serverIdentifier,
            ...(tool.description.length === 0 ? {} : { description: tool.description }),
            ...(tool.inputSchema == null ? {} : { inputSchema: tool.inputSchema.toJson() })
          }))
        }));
    },
    async executeTool(args) {
      try {
        const accessor = await boxMcpResourceAccessor(box, ctx) as McpAccessor;
        return await accessor.get(mcpExecutorResource).execute(ctx, toMcpArgs(args));
      } catch (error) {
        recordMcpExecErrorClass(args.toolCallId, error);
        return errorResult(
          `Box MCP execution failed for "${args.name}": ${errorLabel(error)}`
        );
      }
    }
  };
}
