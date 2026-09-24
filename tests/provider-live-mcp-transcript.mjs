import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";

if (process.platform !== "linux" || !existsSync("/.dockerenv")) throw new Error("Provider MCP transcript requires a Linux container");
const root = path.resolve(import.meta.dirname, "..");
const workspace = process.env.SAND_AGENT_WORKSPACE;
if (workspace == null || workspace.length === 0) throw new Error("SAND_AGENT_WORKSPACE is required");
await mkdir(workspace, { recursive: true });
const outfile = path.join(workspace, ".provider-live-mcp-runtime.mjs");
await build({ entryPoints: [path.join(root, "tests/fixtures/production-mcp-runtime.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
const runtime = await import(outfile);
const host = new runtime.BoxMcpHost({ workspaceRoot: workspace });
const [context, cancel] = runtime.createContext().withTimeoutAndCancel(120_000);
const events = [];
const invocations = [];
const records = [];
const nonce = randomUUID();
try {
  await host.load(JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [path.join(root, "tests/fixtures/mcp-echo-server.mjs")], cwd: workspace } } }));
  const mcp = runtime.createProductionMcpForTurn({
    createExecutor: (persistImage, spill, identity) => new runtime.SandMcpExecutor({ executeTool: (ctx, args) => {
      invocations.push(args.toolCallId);
      return host.callTool(args, ctx.signal);
    } }, persistImage, spill, identity),
    createStateExecutor: () => runtime.createSandMcpStateExecutor({ getTools: async ctx => {
      const state = await host.listState({ serverIdentifiers: ["echo"] }, ctx.signal);
      assert.equal(state.result.case, "success");
      return state.result.value.servers.flatMap(server => server.tools).map(tool => ({ name: tool.name, providerIdentifier: tool.providerIdentifier, toolName: tool.toolName, description: tool.description, inputSchema: tool.inputSchema.toJson() }));
    } }),
  });
  const resourceAccessor = new runtime.RegistryResourceAccessor();
  resourceAccessor.register(runtime.mcpExecutorResource, mcp.createExecutor(undefined, undefined, { agentId: nonce }));
  resourceAccessor.register(runtime.mcpStateExecutorResource, mcp.createStateExecutor());
  const turn = { autoReviewModes: runtime.SAND_AUTO_REVIEW_MODES_OFF, mcp: { mcpForTurn: mcp } };
  const toolHost = runtime.createProductionTurnToolsetHost({
    turn,
    factoryProvider: { createMcpMetaToolInputs: (_turn, props) => runtime.createProductionMcpToolInputs({ resourceAccessor: props.resourceAccessor, getMcpTools: () => props.mcpTools ?? [], mode: "off", agentId: nonce }) },
    isSubagentRunner: false, isSharedRoomRunner: false, isBoxScopedSubagent: false, isComputerUseSubagent: false, isBrowserUseSubagent: false,
    isSystemPromptOverridden: false, remoteBoxHasDesktop: false, getConversationId: () => nonce, getRemoteBoxAvailable: () => false,
    cloudAgentsDisabledByTeam: () => true, spotlightEnabled: () => false,
  });
  const toolset = runtime.createTurnAgentToolsHandoff({ toolHost, turn }).toolsGenerator({ resourceAccessor, mcpTools: [] });
  const session = runtime.createProviderPromptSession("claude-code", { onToolEvent: event => events.push(event) });
  const executor = new runtime.SimplePromptToolExecutor(session.getExecutor([{ role: "user", content: `Use host GetMcpTools to inspect echo, then host CallMcpTool to call its echo tool exactly once with text ${nonce}. Report its exact result.` }]));
  const interaction = new runtime.InteractionHandler({ sendUpdate: async (_ctx, update) => records.push(update) }, { recordToolCall: (call, id) => records.push({ call, id }) }, nonce);
  const result = executor.executeToolStream(context, undefined, interaction, toolset.getToolExecutionSet(), {}, () => {}, undefined, undefined);
  let outerToolChunks = 0;
  for await (const event of result.fullStream) if (event.type === "tool-call" || event.type === "tool-call-streaming-start") outerToolChunks++;
  const response = await result.response;
  const content = response.messages.flatMap(message => message.content);
  const calls = content.filter(part => part.type === "tool-call" && part.toolName === "mcp__grok_bot_host_tools__CallMcpTool");
  const results = content.filter(part => part.type === "tool-result" && part.toolName === "mcp__grok_bot_host_tools__CallMcpTool");
  assert.equal(outerToolChunks, 0);
  assert.equal(invocations.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].toolCallId, calls[0].toolCallId);
  assert.ok(JSON.stringify(results[0].result).includes(nonce));
  assert.ok(events.some(event => event.name === "mcp__grok_bot_host_tools__GetMcpTools" && event.status === "done"));
  assert.ok(records.length >= 4);
  process.stdout.write(JSON.stringify({ ok: true, mcpInvocations: invocations.length, calls: calls.length, results: results.length, productionToolset: true }) + "\n");
} finally {
  cancel();
  await host.dispose();
}
