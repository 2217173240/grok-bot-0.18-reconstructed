// Regression guard for the box daemon's MCP host.
//
// The daemon now owns the stdio MCP servers configured for the local computer:
// it starts them, keeps one client per server, and answers the two exec requests
// the host sends. The fixture is a real stdio server built with the same
// official SDK, so both ends of the protocol are real. The retired daemon
// answered these requests with BOX_EXEC_UNSUPPORTED and reported an empty
// success for the config push.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { Value } from "@bufbuild/protobuf";
import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const fixtureServer = path.join(repositoryRoot, "tests", "fixtures", "mcp-echo-server.mjs");
const ECHO = "echo-fixture";

async function loadModule(buildRoot, entry, name) {
  const outfile = path.join(buildRoot, name);
  await build({
    entryPoints: [path.join(repositoryRoot, entry)],
    bundle: true,
    format: "esm",
    packages: "external",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  return await import(pathToFileURL(outfile).href);
}

// One exec round over the production wire, returning the first result message.
// The deadline is short on purpose: the Connect transport holds its deadline
// timer, so the value also decides how long the test process outlives the last
// call. These calls only cross a loopback socket, so a generous-by-orders
// deadline stays well clear of a flake.
async function execOnce(client, execPb, request, timeoutMs = 5_000) {
  for await (const element of client.exec(request, { timeoutMs })) {
    const inner = element.element;
    if (inner.case === "execClientMessage") {
      if (inner.value.message.case === "throw") throw new Error(inner.value.message.value.error);
      return inner.value.message;
    }
    if (inner.case === "execClientControlMessage" && inner.value.message.case === "throw") {
      throw new Error(inner.value.message.value.error);
    }
  }
  throw new Error(`the daemon closed the stream without a result for ${request.message.case}`);
}

function stateRequest(execPb, mcpPb, serverIdentifiers, kickOnly = false) {
  return new execPb.ExecServerMessage({
    id: 1,
    message: { case: "mcpStateExecArgs", value: new mcpPb.McpStateExecArgs({ serverIdentifiers, kickOnly }) },
  });
}

function callRequest(execPb, mcpPb, { server, tool, args, toolCallId = "call-1" }) {
  // Arguments travel as protobuf Value messages, and the daemon receives the
  // field order the gateway produces: `name` is the server's own tool, while
  // `toolName` carries the label the caller used to reach it.
  const encoded = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, Value.fromJson(value)]));
  return new execPb.ExecServerMessage({
    id: 2,
    message: {
      case: "mcpArgs",
      value: new mcpPb.McpArgs({ name: tool, providerIdentifier: server, toolName: `${server}__${tool}`, toolCallId, args: encoded }),
    },
  });
}

test("the box daemon hosts the configured stdio MCP servers", async () => {
  const { createClient } = await import("@connectrpc/connect");
  const { createConnectTransport } = await import("@connectrpc/connect-node");
  const buildRoot = await mkdtemp(path.join(repositoryRoot, ".tmp-box-mcp-host-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "grok-box-mcp-workspace-"));
  const token = "mcp-host-test-token";
  const server = await loadModule(buildRoot, "source/box-exec-daemon/server.ts", "server.mjs");
  const control = await loadModule(buildRoot, "source/packages/proto/generated/agent/v1/control_service_connect.ts", "control-service.mjs");
  const controlPb = await loadModule(buildRoot, "source/packages/proto/generated/agent/v1/control_service_pb.ts", "control-service-pb.mjs");
  const exec = await loadModule(buildRoot, "source/packages/proto/generated/agent/v1/exec_service_connect.ts", "exec-service.mjs");
  const execPb = await loadModule(buildRoot, "source/packages/proto/generated/agent/v1/exec_pb.ts", "exec-pb.mjs");
  const mcpPb = await loadModule(buildRoot, "source/packages/proto/generated/agent/v1/mcp_exec_pb.ts", "mcp-exec-pb.mjs");
  const daemon = await server.startBoxExecDaemon({ port: 0, authToken: token, workspaceRoot });
  const transport = () => createConnectTransport({
    httpVersion: "1.1",
    baseUrl: daemon.url,
    useBinaryFormat: true,
    interceptors: [next => async request => {
      request.header.set("Authorization", `Bearer ${token}`);
      return await next(request);
    }],
  });
  try {
    const controlClient = createClient(control.ControlService, transport());
    const execClient = createClient(exec.ExecService, transport());
    const load = (config) => controlClient.loadMcpServers(new controlPb.LoadMcpServersRequest({ mcpConfigJson: JSON.stringify({ mcpServers: config }) }));

    // A config that names no servers still asks for nothing.
    assert.deepEqual([...(await load({})).loadedServerNames], []);

    // One healthy server and one that cannot start: the healthy one must still
    // work, and the broken one must say why rather than disappear.
    const loaded = await load({
      [ECHO]: { command: process.execPath, args: [fixtureServer] },
      broken: { command: path.join(workspaceRoot, "no-such-binary") },
    });
    assert.deepEqual([...loaded.loadedServerNames].sort(), ["broken", ECHO]);

    const state = await execOnce(execClient, execPb, stateRequest(execPb, mcpPb, []));
    assert.equal(state.case, "mcpStateExecResult");
    const servers = state.value.result.value.servers;
    const echo = servers.find((row) => row.serverIdentifier === ECHO);
    assert.ok(echo, "the healthy server must appear");
    assert.equal(echo.status, "connected");
    assert.deepEqual(echo.tools.map((tool) => tool.toolName).sort(), ["add", "echo", "fail"]);
    assert.deepEqual(echo.tools.map((tool) => tool.name).sort(), [`${ECHO}__add`, `${ECHO}__echo`, `${ECHO}__fail`]);
    for (const tool of echo.tools) assert.equal(tool.providerIdentifier, ECHO);
    const echoTool = echo.tools.find((tool) => tool.toolName === "echo");
    assert.equal(echoTool.description, "Echo the given text back");
    // The tool's JSON Schema survives the proto round-trip: the daemon converts
    // it to a protobuf Value and the host converts it back for the model.
    assert.deepEqual(echoTool.inputSchema.toJson().properties, { text: { type: "string" } });
    assert.deepEqual(echoTool.inputSchema.toJson().required, ["text"]);
    assert.match(echo.instructions[0].instructions, /Echoes text back/);
    const broken = servers.find((row) => row.serverIdentifier === "broken");
    assert.equal(broken.status, "error");
    assert.ok(broken.errorMessage.length > 0, "a server that will not start must carry the reason");

    // A call round-trips, including arguments and the result payload.
    const echoed = await execOnce(execClient, execPb, callRequest(execPb, mcpPb, { server: ECHO, tool: "echo", args: { text: "hello" } }));
    assert.equal(echoed.case, "mcpResult");
    assert.equal(echoed.value.result.case, "success", `echo call answered ${JSON.stringify(echoed.value.toJson())}`);
    assert.equal(echoed.value.result.value.isError, false);
    assert.equal(echoed.value.result.value.content[0].content.value.text, "echo:hello");

    const added = await execOnce(execClient, execPb, callRequest(execPb, mcpPb, { server: ECHO, tool: "add", args: { left: 2, right: 3 }, toolCallId: "call-2" }));
    assert.equal(added.value.result.value.content[0].content.value.text, "5");

    // A tool that reports a tool-level error keeps isError, so the model sees a
    // failed call instead of a successful one.
    const failed = await execOnce(execClient, execPb, callRequest(execPb, mcpPb, { server: ECHO, tool: "fail", args: {}, toolCallId: "call-3" }));
    assert.equal(failed.value.result.case, "success");
    assert.equal(failed.value.result.value.isError, true);

    // Unknown server and unknown tool are distinct answers, each naming what is
    // available.
    const noServer = await execOnce(execClient, execPb, callRequest(execPb, mcpPb, { server: "absent", tool: "echo", args: {}, toolCallId: "call-4" }));
    assert.equal(noServer.value.result.case, "serverNotFound");
    assert.deepEqual([...noServer.value.result.value.availableServers].sort(), ["broken", ECHO]);
    const noTool = await execOnce(execClient, execPb, callRequest(execPb, mcpPb, { server: ECHO, tool: "absent", args: {}, toolCallId: "call-5" }));
    assert.equal(noTool.value.result.case, "toolNotFound");
    assert.deepEqual([...noTool.value.result.value.availableTools].sort(), ["add", "echo", "fail"]);

    // kickOnly answers from the last listing without asking the server again.
    const kicked = await execOnce(execClient, execPb, stateRequest(execPb, mcpPb, [ECHO], true));
    assert.equal(kicked.value.result.value.servers[0].tools.length, 3);

    // A config that drops a server disconnects it.
    const emptied = await load({});
    assert.deepEqual([...emptied.loadedServerNames], []);
    const afterDrop = await execOnce(execClient, execPb, stateRequest(execPb, mcpPb, [ECHO]));
    assert.equal(afterDrop.value.result.case, "error");

    // The proto shape the host decodes is the one the daemon answers with.
    assert.deepEqual(mcpPb.McpStateExecResult.fields.list().map((field) => field.name), ["success", "error", "rejected"]);
    const serverFields = mcpPb.McpStateServer.fields.list().map((field) => field.name);
    for (const field of ["server_identifier", "server_name", "tools", "instructions", "status", "error_message"]) {
      assert.ok(serverFields.includes(field), `McpStateServer must carry ${field}`);
    }
  } finally {
    await daemon.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(buildRoot, { recursive: true, force: true });
  }
});
