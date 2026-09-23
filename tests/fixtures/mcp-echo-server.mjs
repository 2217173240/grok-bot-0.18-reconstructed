// A real stdio MCP server for the box daemon's MCP host test.
//
// It is built with the same official SDK the host uses, so the test exercises
// the protocol on both sides instead of a hand-written approximation of it.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "echo-fixture", version: "1.0.0" },
  { instructions: "Echoes text back, and adds numbers on request." },
);

server.registerTool(
  "echo",
  { description: "Echo the given text back", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
);

server.registerTool(
  "add",
  { description: "Add two integers", inputSchema: { left: z.number(), right: z.number() } },
  async ({ left, right }) => ({ content: [{ type: "text", text: String(left + right) }] }),
);

server.registerTool(
  "fail",
  { description: "Always reports a tool-level error", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: "this tool failed on purpose" }], isError: true }),
);

if (process.argv.includes("--image")) server.registerTool(
  "image",
  { description: "Returns a small PNG payload", inputSchema: {} },
  async () => ({ content: [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", mimeType: "image/png" }] }),
);

await server.connect(new StdioServerTransport());
