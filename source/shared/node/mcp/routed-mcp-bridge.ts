import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { adaptSdkTransport } from "./sdk-transport.js";

const RoutedToolSchema = ToolSchema.extend({
  providerIdentifier: z.string().min(1),
  toolName: z.string().min(1),
  inputSchema: ToolSchema.shape.inputSchema.default({ type: "object", additionalProperties: true }),
});
type Tool = { readonly name: string; readonly providerIdentifier: string; readonly toolName: string; readonly description?: string; readonly inputSchema?: unknown };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function mcpResult(value: unknown): Record<string, unknown> {
  const result = record(record(value)?.result);
  const payload = record(result?.value);
  if (result?.case !== "success") {
    return { isError: true, content: [{ type: "text", text: typeof payload?.error === "string" ? payload.error : JSON.stringify(value) }] };
  }
  if (!Array.isArray(payload?.content)) throw new Error("MCP success response has no content array");
  const content = payload.content.map((item: unknown) => {
    const carrier = record(record(item)?.content);
    const data = record(carrier?.value);
    if (carrier?.case === "text" && typeof data?.text === "string") return { type: "text", text: data.text };
    if (carrier?.case === "image" && typeof data?.mimeType === "string") {
      if (data.data instanceof Uint8Array) return { type: "image", data: Buffer.from(data.data).toString("base64"), mimeType: data.mimeType };
      if (typeof data.data === "string") return { type: "image", data: data.data, mimeType: data.mimeType };
    }
    throw new Error("Unsupported routed MCP content");
  });
  return { isError: payload.isError === true, content, ...(payload.structuredContent == null ? {} : { structuredContent: payload.structuredContent }) };
}

export async function createRoutedMcpBridge(deps: {
  readonly listTools: () => Promise<unknown>;
  readonly callTool: (args: Tool & { readonly args: unknown; readonly toolCallId: string }) => Promise<unknown>;
}): Promise<{ readonly url: string; close(): Promise<void> }> {
  const secret = randomUUID();
  let tools = new Map<string, z.infer<typeof RoutedToolSchema>>();
  const mcp = new Server({ name: "grok-bot-plugins", version: "1" }, { capabilities: { tools: { listChanged: false } } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    const discovered = z.array(RoutedToolSchema).parse(await deps.listTools());
    const next = new Map(discovered.map(tool => [tool.name, tool]));
    if (next.size !== discovered.length) throw new Error("Duplicate routed MCP tool names");
    tools = next;
    return { tools: discovered.map(tool => ({ name: tool.name, description: tool.description ?? `${tool.toolName} via ${tool.providerIdentifier}`, inputSchema: tool.inputSchema })) };
  });
  mcp.setRequestHandler(CallToolRequestSchema, async request => {
    const selected = tools.get(request.params.name);
    if (selected == null) throw new McpError(ErrorCode.InvalidParams, `Unknown Grok Bot plugin tool: ${request.params.name}`);
    return mcpResult(await deps.callTool({ name: selected.name, providerIdentifier: selected.providerIdentifier, toolName: selected.toolName, args: request.params.arguments ?? {}, toolCallId: randomUUID() }));
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await mcp.connect(adaptSdkTransport(transport));
  const server = createServer((request, response) => {
    if (request.url !== `/mcp/${secret}`) { response.writeHead(404).end(); return; }
    void transport.handleRequest(request, response).catch(error => {
      if (response.headersSent) { response.destroy(error instanceof Error ? error : undefined); return; }
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: ErrorCode.InternalError, message: "MCP transport failed" } }));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch (error) {
    await mcp.close();
    throw error;
  }
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Could not bind the routed MCP bridge");
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}/mcp/${secret}`,
    close: () => closing ??= (async () => {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      const outcomes = await Promise.allSettled([mcp.close(), closed]);
      const failures = outcomes.filter(result => result.status === "rejected");
      if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), "MCP bridge close failed");
    })(),
  };
}
