import { randomUUID } from "node:crypto";
import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

export interface HostToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface HostToolExecution {
  readonly execute: (call: { readonly name: string; readonly args: unknown; readonly toolCallId: string; readonly signal: AbortSignal }) => Promise<{ readonly content: readonly Record<string, unknown>[]; readonly isError: boolean }>;
}

function mcpContent(content: readonly Record<string, unknown>[]): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  return content.map(part => {
    if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
    if (part.type === "image" && typeof part.mimeType === "string") {
      const data = part.data instanceof Uint8Array ? Buffer.from(part.data).toString("base64") : part.data;
      if (typeof data === "string") return { type: "image", data, mimeType: part.mimeType };
    }
    return { type: "text", text: JSON.stringify(part) };
  });
}

/** 每个回合独立创建；执行 ID 与 Claude 的 tool_use ID 分开记录。 */
export function createHostToolsMcpBridge(definitions: readonly HostToolDefinition[], execution: HostToolExecution, turnSignal: AbortSignal): { readonly config: McpSdkServerConfigWithInstance; close(): Promise<void> } {
  const tools = new Map(definitions.map(definition => [definition.name, definition]));
  if (tools.size !== definitions.length) throw new Error("Duplicate host tool names");
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(turnSignal.reason);
  if (turnSignal.aborted) abort();
  else turnSignal.addEventListener("abort", abort, { once: true });
  const config = createSdkMcpServer({ name: "grok-bot-host-tools", tools: [] });
  config.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.map(definition => ({ name: definition.name, description: definition.description, inputSchema: definition.inputSchema as { type: "object"; [key: string]: unknown } })) }));
  config.instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const selected = tools.get(request.params.name);
    if (selected == null) throw new McpError(ErrorCode.InvalidParams, `Unknown Grok Bot host tool: ${request.params.name}`);
    const signal = AbortSignal.any([lifetime.signal, extra.signal]);
    try {
      if (signal.aborted) throw signal.reason ?? new Error("Host tool call canceled.");
      const result = await execution.execute({ name: selected.name, args: request.params.arguments ?? {}, toolCallId: randomUUID(), signal });
      const content = mcpContent(result.content);
      if (result.isError) {
        // Claude SDK 的错误分支只读取第一个文本块，完整正文与边界标记需要放在一起。
        const text = content.filter(part => part.type === "text").map(part => part.text).join("\n");
        return { content: [{ type: "text" as const, text }, ...content.filter(part => part.type !== "text")], isError: true };
      }
      return { content, isError: false };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
  let closing: Promise<void> | undefined;
  return {
    config,
    close: () => closing ??= (async () => {
      turnSignal.removeEventListener("abort", abort);
      lifetime.abort(new Error("Host tool bridge closed."));
      await config.instance.close();
    })(),
  };
}
