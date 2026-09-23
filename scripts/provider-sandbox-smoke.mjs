import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Value } from "@bufbuild/protobuf";
import path from "node:path";
import { build } from "esbuild";

if (process.platform !== "linux" || !existsSync("/.dockerenv")) throw new Error("provider sandbox smoke requires a Linux container");
const workspace = path.resolve(process.env.SAND_AGENT_WORKSPACE ?? path.join(process.cwd(), ".provider-sandbox-smoke"));
const nonce = randomUUID();
const marker = path.join(workspace, `.provider-smoke-${nonce}.txt`);
const tokenPath = process.env.PROVIDER_SMOKE_TOKEN_FILE ?? path.join(process.env.SAND_DATA_ROOT ?? "", "anthropic-token");
if (process.env.ANTHROPIC_API_KEY == null && process.env.ANTHROPIC_AUTH_TOKEN == null && !existsSync(tokenPath)) throw new Error("provider token file is unavailable");
await mkdir(workspace, { recursive: true });

const root = path.resolve(import.meta.dirname, "..");
await build({ entryPoints: [path.join(root, "source/host/extensions/inference/provider-session.ts"), path.join(root, "source/packages/context/core.ts"), path.join(root, "source/box-exec-daemon/mcp-host.ts")], bundle: true, format: "esm", platform: "node", packages: "external", outdir: workspace, entryNames: ".provider-smoke-[name]", outExtension: { ".js": ".mjs" }, logLevel: "silent" });
const provider = await import(path.join(workspace, ".provider-smoke-provider-session.mjs"));
const contextModule = await import(path.join(workspace, ".provider-smoke-core.mjs"));
const mcpModule = await import(path.join(workspace, ".provider-smoke-mcp-host.mjs"));
const calls = [];
const host = new mcpModule.BoxMcpHost({ workspaceRoot: workspace, log: (line) => process.stderr.write(`${line}\n`) });
const [context, cancel] = contextModule.createContext().withTimeoutAndCancel(120_000);
try {
  await host.load(JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [path.join(root, "tests/fixtures/mcp-echo-server.mjs")], cwd: workspace } } }));
  const state = await host.listState({ serverIdentifiers: ["echo"] });
  const tools = state.result.value.servers.flatMap((server) => server.tools).map((tool) => ({ name: tool.name, providerIdentifier: tool.providerIdentifier, toolName: tool.toolName, description: tool.description, inputSchema: tool.inputSchema?.toJson() }));
  const mcp = { listTools: async () => tools, callTool: async (args) => {
    calls.push(args.toolName);
    const encoded = Object.fromEntries(Object.entries(args.args).map(([key, value]) => [key, Value.fromJson(value)]));
    return host.callTool({ name: args.toolName, providerIdentifier: args.providerIdentifier, toolName: args.name, toolCallId: args.toolCallId, args: encoded });
  } };
  const session = provider.createProviderPromptSession("claude-code", { mcp });
  const executor = session.getExecutor([{ role: "user", content: `Use Bash to run uname -s and write its output plus the text ${nonce} to ${marker}. Read it back. Call the echo__echo MCP tool with text ${nonce}. Report both results. Do not use images or modify other files.` }]);
  const stream = executor.stream(context, `provider-smoke-${process.pid}`, []);
  for await (const _event of stream.fullStream) {}
  await stream.response;
  const written = await readFile(marker, "utf8");
  assert.ok(written.includes("Linux") && written.includes(nonce), "Agent did not write the Linux and nonce evidence");
  assert.ok(calls.includes("echo"), "Claude did not call the real local MCP fixture");
  assert.equal(context.canceled, false);
  process.stdout.write(JSON.stringify({ ok: true, linux: process.platform, workspace, mcpCalls: calls }) + "\n");
} finally {
  cancel();
  await host.dispose();
}
