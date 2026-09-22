// Regression guard for the box daemon's MCP load handler.
//
// The daemon hosts no MCP servers: nothing spawns the stdio servers a config
// names, and the exec surface answers mcpArgs and mcpStateExecArgs with
// BOX_EXEC_UNSUPPORTED. The load handler nevertheless returned an empty success,
// so the caller recorded the config as pushed and went looking for tools that
// had never been loaded — the quietest possible way to lose a feature. It now
// refuses when a config names servers, and keeps succeeding for the genuine
// no-op of an empty config. This drives the real daemon over its real wire.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

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

test("the box daemon refuses MCP servers it cannot host, and accepts an empty config", async () => {
  const { Code, ConnectError, createClient } = await import("@connectrpc/connect");
  const { createConnectTransport } = await import("@connectrpc/connect-node");
  const buildRoot = await mkdtemp(path.join(repositoryRoot, ".tmp-box-daemon-mcp-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "grok-box-daemon-workspace-"));
  const token = "gate-test-token";
  const server = await loadModule(buildRoot, "source/box-exec-daemon/server.ts", "server.mjs");
  const control = await loadModule(buildRoot, "source/packages/proto/generated/agent/v1/control_service_connect.ts", "control-service.mjs");
  const controlPb = await loadModule(buildRoot, "source/packages/proto/generated/agent/v1/control_service_pb.ts", "control-service-pb.mjs");
  const daemon = await server.startBoxExecDaemon({ port: 0, authToken: token, workspaceRoot });
  try {
    const client = createClient(control.ControlService, createConnectTransport({ baseUrl: daemon.url }));
    const load = (mcpConfigJson) => client.loadMcpServers(
      new controlPb.LoadMcpServersRequest({ mcpConfigJson }),
      { headers: { authorization: `Bearer ${token}` } },
    );

    // An empty config asks for nothing, so succeeding is the honest answer.
    const empty = await load(JSON.stringify({ mcpServers: {} }));
    assert.deepEqual([...empty.loadedServerNames], []);
    const absent = await load("{}");
    assert.deepEqual([...absent.loadedServerNames], []);

    // A config that names servers is refused, and the refusal names them so the
    // operator can see which plugin was dropped rather than finding an empty
    // tool list later.
    await assert.rejects(
      () => load(JSON.stringify({ mcpServers: { demo: { command: "node", args: ["server.js"] }, second: { command: "node" } } })),
      (error) => {
        assert.ok(error instanceof ConnectError);
        assert.equal(error.code, Code.Unimplemented);
        assert.match(error.rawMessage, /demo, second/);
        return true;
      },
    );

    // A malformed payload is a caller bug, reported as one instead of being
    // treated as nothing to load.
    await assert.rejects(
      () => load("{ not json"),
      (error) => error instanceof ConnectError && error.code === Code.InvalidArgument,
    );

    // The token still guards the endpoint.
    await assert.rejects(
      () => client.loadMcpServers(new controlPb.LoadMcpServersRequest({ mcpConfigJson: "{}" })),
      (error) => error instanceof ConnectError && error.code === Code.Unauthenticated,
    );
  } finally {
    await daemon.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(buildRoot, { recursive: true, force: true });
  }
});
