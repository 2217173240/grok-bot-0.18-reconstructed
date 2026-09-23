import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const mcp = new McpServer({ name: "runtime-http-fixture", version: "1" });
mcp.tool("echo", "Echo input", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text: `http:${text}` }] }));
const server = createServer(async (request, response) => {
  if (request.headers["x-test-workspace"] !== "local-runtime") { response.writeHead(403).end(); return; }
  if (request.method !== "POST" || request.url !== "/mcp") { response.writeHead(404).end(); return; }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on("close", () => { void transport.close(); });
  await mcp.connect(transport);
  await transport.handleRequest(request, response);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ port: typeof address === "object" && address != null ? address.port : 0 })}\n`);
});
