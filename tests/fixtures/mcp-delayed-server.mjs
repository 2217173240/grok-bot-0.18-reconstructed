import { writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "delayed-fixture", version: "1.0.0" });

server.registerTool(
  "delayedWrite",
  { description: "Write a marker after a delay", inputSchema: { startedPath: z.string(), completedPath: z.string(), delayMs: z.number() } },
  async ({ startedPath, completedPath, delayMs }, extra) => {
    await writeFile(startedPath, "started\n");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { extra.signal.removeEventListener("abort", abort); resolve(); }, delayMs);
      const abort = () => { clearTimeout(timer); reject(extra.signal.reason ?? new Error("MCP request canceled.")); };
      if (extra.signal.aborted) abort();
      else extra.signal.addEventListener("abort", abort, { once: true });
    });
    await writeFile(completedPath, "completed\n");
    return { content: [{ type: "text", text: "completed" }] };
  },
);

await server.connect(new StdioServerTransport());
