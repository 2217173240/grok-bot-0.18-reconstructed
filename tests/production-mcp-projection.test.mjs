import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

test("生产 MCP 工具通过真实 stdio 服务器完成发现、调用、错误与审批控制", { timeout: 30_000 }, async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/production-mcp-"));
  const bundle = path.join(directory, "runtime.mjs");
  await build({ entryPoints: [path.join(root, "tests/fixtures/production-mcp-runtime.ts")], outfile: bundle, bundle: true, format: "esm", packages: "external", platform: "node", logLevel: "silent" });
  const runtime = await import(pathToFileURL(bundle).href);
  const host = new runtime.BoxMcpHost({ workspaceRoot: directory });
  const updates = [];
  const recorded = [];
  const diagnostics = [];
  const ctx = runtime.createContext();
  const interaction = new runtime.InteractionHandler({ sendUpdate: async (_ctx, update) => { updates.push(update); } }, { recordToolCall: (call, id) => { recorded.push({ call, id }); } }, "production-mcp-test");
  const controller = new runtime.SandAutoReviewController({ agentId: "test-agent", hostGeneration: "test-generation" });
  const gate = runtime.createAutoReviewGate({ baseModes: runtime.SAND_AUTO_REVIEW_MODES_OFF, controller: () => controller, resolveBoxId: () => "test-box" });
  const observation = runtime.createTurnObservation({ getConversationId: () => "test-agent" });
  observation.setToolCallDiagnosticHandler(event => diagnostics.push(event));
  const getTools = async () => {
    const state = await host.listState({ serverIdentifiers: ["fixture"] });
    assert.equal(state.result.case, "success");
    return state.result.value.servers.flatMap(server => server.tools).map(tool => ({ name: tool.name, providerIdentifier: tool.providerIdentifier, toolName: tool.toolName, description: tool.description, inputSchema: tool.inputSchema.toJson() }));
  };
  const service = {
    createExecutor: (persistImage, spillText, auditIdentity) => new runtime.SandMcpExecutor({ executeTool: (context, args) => host.callTool(args, context.signal) }, persistImage, spillText, auditIdentity),
    createStateExecutor: () => runtime.createSandMcpStateExecutor({ getTools }),
  };
  const mcpForTurn = runtime.createProductionMcpForTurn(service);
  const executor = mcpForTurn.createExecutor(undefined, undefined, { agentId: "test-agent" });
  const guard = runtime.createTurnMcpExecutorGuard({
    isSubagentRunner: false,
    assertNoPendingApproval: () => gate.assertNoPendingApproval(),
    execute: (context, args, options) => executor.execute(context, args, options),
    beginObservation: args => observation.beginMcpExecObservation(args),
    boundedConnectorTag: runtime.boundedConnectorTag,
    mcpErrorClassOf: runtime.mcpErrorClassOf,
    takeMcpExecErrorClass: runtime.takeMcpExecErrorClass,
    emitConnectorCard: emission => updates.push(emission),
    reportDiagnostic: event => diagnostics.push(event),
    errorLogTag: runtime.mcpErrorClassOf,
  });
  const resourceAccessor = new runtime.RegistryResourceAccessor();
  resourceAccessor.register(runtime.mcpExecutorResource, guard);
  resourceAccessor.register(runtime.mcpStateExecutorResource, mcpForTurn.createStateExecutor());
  const projection = { mcpForTurn };
  const makeTools = (mcpTools, isBoxScopedSubagent = false) => {
    const toolHost = runtime.createProductionTurnToolsetHost({
      turn: { autoReviewModes: runtime.SAND_AUTO_REVIEW_MODES_OFF },
      factoryProvider: { createMcpMetaToolInputs: (_turn, props) => runtime.createProductionMcpToolInputs({ resourceAccessor: props.resourceAccessor, getMcpTools: () => props.mcpTools ?? [], mode: "off", agentId: "test-agent", controller }) },
      isSubagentRunner: isBoxScopedSubagent, isSharedRoomRunner: false, isBoxScopedSubagent,
      isComputerUseSubagent: isBoxScopedSubagent, isBrowserUseSubagent: false,
      isSystemPromptOverridden: false, remoteBoxHasDesktop: false,
      getConversationId: () => "test-agent", getRemoteBoxAvailable: () => false,
      cloudAgentsDisabledByTeam: () => true, spotlightEnabled: () => false,
    });
    const props = runtime.createProductionTurnToolInputs({ resourceAccessor, mcpTools });
    assert.equal(props.mcpTools, mcpTools);
    return runtime.createTurnAgentToolsHandoff({ toolHost, turn: { autoReviewModes: runtime.SAND_AUTO_REVIEW_MODES_OFF, mcp: projection } }).toolsGenerator(props);
  };
  const stream = async function* (args) { yield JSON.stringify(args); };
  try {
    const cold = makeTools([]);
    assert.ok(cold);
    await host.load(JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [path.join(root, "tests/fixtures/mcp-echo-server.mjs")] } } }));
    const tools = cold.getStaticTools();
    assert.deepEqual(tools.map(tool => tool.name), ["GetMcpTools", "CallMcpTool"]);
    const discover = tools.find(tool => tool.name === "GetMcpTools");
    const call = tools.find(tool => tool.name === "CallMcpTool");
    const found = await discover.execute(ctx, interaction, stream({ server: "fixture", toolName: "echo" }), { toolCallId: "discover-cold" });
    assert.match(JSON.stringify(found), /Echo the given text back/);
    const called = await call.execute(ctx, interaction, stream({ server: "fixture", toolName: "echo", arguments: { text: "production-projection" } }), { toolCallId: "call-cold" });
    assert.match(JSON.stringify(called), /echo:production-projection/);
    const warm = makeTools(await getTools());
    assert.deepEqual(warm.getStaticTools().map(tool => tool.name), ["GetMcpTools", "CallMcpTool"]);
    assert.equal(makeTools(await getTools(), true).getStaticTools().some(tool => ["GetMcpTools", "CallMcpTool"].includes(tool.name)), false);
    const failed = await call.execute(ctx, interaction, stream({ server: "fixture", toolName: "fail", arguments: {} }), { toolCallId: "call-error" });
    assert.match(JSON.stringify(failed), /failed on purpose/);
    await assert.rejects(call.execute(ctx, interaction, stream({ server: "fixture", toolName: "missing", arguments: {} }), { toolCallId: "call-missing" }), /not found|unknown|does not exist/i);
    const approval = controller.requestApproval({ surface: "mcp", fingerprint: "pending", reason: "Review tool action", summary: "Review tool action", expiryPolicy: "park" });
    await assert.rejects(call.execute(ctx, interaction, stream({ server: "fixture", toolName: "echo", arguments: { text: "blocked" } }), { toolCallId: "call-blocked" }), /waiting for Auto-review approval/);
    controller.resolveApproval(controller.getPendingApprovals()[0].id, "denied");
    assert.equal((await approval).approved, false);
    const [canceled, cancel] = ctx.withCancel();
    cancel(new Error("test cancellation"));
    await assert.rejects(call.execute(canceled, interaction, stream({ server: "fixture", toolName: "echo", arguments: { text: "canceled" } }), { toolCallId: "call-canceled" }), /abort|cancel/i);
    assert.ok(recorded.some(row => row.id === "call-cold"));
    assert.ok(updates.length >= 4);
    const review = runtime.createProductionMcpToolInputs({ resourceAccessor, getMcpTools: () => [], mode: "enforce", agentId: "test-agent", controller });
    assert.equal(review.callOptions.smartModeClassifierMode, true);
    const [approvalContext, cancelApproval] = ctx.withCancel();
    const decision = review.callOptions.smartModeApprovalProvider.requestApproval({
      kind: "mcp", fingerprint: "mcp-review", toolCallId: "review-call", conversationId: "test-agent", signal: approvalContext.signal,
      target: { serverIdentifier: "fixture", toolName: "echo", mcpMode: "meta_tool", blockReason: "Review requested" },
    });
    assert.equal(controller.getPendingApprovals()[0].surface, "mcp");
    cancelApproval();
    assert.equal((await decision).approved, false);
    assert.equal(controller.getPendingApprovals().length, 0);
  } finally {
    controller.expire("session_end");
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
