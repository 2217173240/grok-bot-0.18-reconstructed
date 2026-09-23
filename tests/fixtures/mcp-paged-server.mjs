import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { writeFile } from "node:fs/promises";

const startupMarker = process.argv.indexOf("--startup-marker");
if (startupMarker >= 0) {
  await writeFile(process.argv[startupMarker + 1], String(process.pid));
  await new Promise(resolve => setTimeout(resolve, 2_000));
}

const repeat = process.argv.includes("--repeat-cursor");
const server = new McpServer({ name: "paged-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
const tools = [
  { name: "identity", description: "Return this server process identity", inputSchema: { type: "object", properties: {} } },
  { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];
server.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  if (request.params?.cursor == null) return { tools: [tools[0]], nextCursor: "page-2" };
  if (repeat && request.params.cursor === "page-2") return { tools: [tools[1]], nextCursor: "page-2" };
  if (request.params.cursor === "page-2") return { tools: [tools[1]] };
  return { tools: [] };
});
server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "identity") return { content: [{ type: "text", text: String(process.pid) }] };
  if (request.params.name === "echo") return { content: [{ type: "text", text: `echo:${request.params.arguments?.text ?? ""}` }] };
  throw new Error(`unknown tool ${request.params.name}`);
});
await server.connect(new StdioServerTransport());
