import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

async function fixture(t) {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/inference-resync-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, "resync.mjs");
  await build({
    stdin: { resolveDir: root, loader: "ts", contents: `
      export { createCoordinatorResyncChain } from "./source/electron-main/coordinator/coordinator-resync.ts";
      export { createProductionCoordinatorAuxiliaryPorts } from "./source/electron-main/coordinator/production-root-auxiliary-provider.ts";
      export { SandSettingsStore } from "./source/shared/node/settings/sand-settings-store.ts";
      export { SettingsService } from "./source/host/extensions/settings/settings-service.ts";
      export { CoordinatorGatewayClient, createCoordinatorGatewayClientTiming } from "./source/node-agent-coordinator/gateway/gateway-client.ts";
      export { SAND_GATEWAY_COMMANDS } from "./source/host/gateway-protocol.ts";
    ` },
    outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent",
  });
  const api = await import(pathToFileURL(outfile).href);
  const settingsPath = path.join(directory, "desktop.json");
  const settings = new api.SandSettingsStore(settingsPath);
  const hostPath = path.join(directory, "host.json");
  const host = new api.SettingsService(hostPath);
  host.setHostSettings({ inferenceProvider: "openrouter", commandCodeModel: "deepseek/deepseek-v4-flash" });
  const requests = [];
  let gate;
  let rejectRouting = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const method = new URL(request.url, "http://localhost").pathname.slice("/api/".length);
    const update = JSON.parse(body);
    requests.push({ method, update });
    if (method === "setHostSettings" && (update.inferenceProvider !== undefined || update.commandCodeModel !== undefined)) {
      if (gate !== undefined) {
        const pending = gate;
        gate = undefined;
        pending.received.resolve();
        await pending.release.promise;
      }
      if (rejectRouting) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "routing update unavailable" }));
        return;
      }
    }
    assert.ok(method === "getHostSettings" || method === "setHostSettings");
    const result = api.SAND_GATEWAY_COMMANDS[method](host, body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const client = new api.CoordinatorGatewayClient({
    resolveConnection: async () => ({ baseUrl: `http://127.0.0.1:${server.address().port}` }),
    timing: api.createCoordinatorGatewayClientTiming(),
    onEvent: event => assert.fail(`unexpected stream event: ${JSON.stringify(event)}`),
  });
  t.after(() => client.close());
  // 只取得生产组合中的 routing 读取方法；Electron 原生端口不参与此测试。
  const routing = api.createProductionCoordinatorAuxiliaryPorts({
    settings: { settingsStore: new api.SandSettingsStore(settingsPath) },
    requireNotifications: () => undefined,
  }, null).resync.getInferenceRouting;
  const completed = [];
  const failures = [];
  const tail = [];
  const readHost = () => client.command("getHostSettings", {});
  const chain = api.createCoordinatorResyncChain({
    legs: { getHostSettings: readHost, setHostSettings: update => client.command("setHostSettings", update) },
    getMcpCustomInstructionsAccountScope: settings.getMcpCustomInstructionsAccountScope.bind(settings),
    getMcpCustomInstructionsByServerId: settings.getMcpCustomInstructionsByServerId.bind(settings),
    getMcpDisabledToolsByServerId: settings.getMcpDisabledToolsByServerId.bind(settings),
    setMcpCustomInstructionsByServerId: settings.setMcpCustomInstructionsByServerId.bind(settings),
    setMcpDisabledToolsByServerId: settings.setMcpDisabledToolsByServerId.bind(settings),
    detectTimeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    getUserTimeZoneOverride: settings.getUserTimeZoneOverride.bind(settings),
    getComputerUseModel: settings.getComputerUseModel.bind(settings),
    getAutoReviewInstructions: settings.getAutoReviewInstructions.bind(settings),
    getLocalToolPermission: settings.getLocalToolPermission.bind(settings),
    getWebauthnProxyEnabled: settings.getWebauthnProxyEnabled.bind(settings),
    getFeatureFlagOverrides: () => undefined,
    getInferenceRouting: routing,
    pushBoxSecrets: async () => { tail.push("box_secrets"); await readHost(); },
    syncWindowFocused: async () => { tail.push("window_focus"); await readHost(); },
    onCompleted: summary => completed.push(summary),
    reportFailure: (step, error) => failures.push({ step, error }),
  });
  return {
    settings, chain, completed, failures, tail,
    routingRequests: () => requests.filter(({ method, update }) => method === "setHostSettings" && ("inferenceProvider" in update || "commandCodeModel" in update)).map(({ update }) => update),
    persistedHost: () => new api.SettingsService(hostPath).getHostSettings(),
    rejectRouting: value => { rejectRouting = value; },
    holdRouting: () => {
      gate = { received: Promise.withResolvers(), release: Promise.withResolvers() };
      return gate;
    },
  };
}

test("重新连接读取已保存的 provider 和 Command Code model", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.settings.setInferenceProvider("command-code");
  f.settings.setCommandCodeModel("openai/gpt-5");
  await f.chain.onTransportConnected();
  assert.deepEqual(f.routingRequests(), [{ inferenceProvider: "command-code", commandCodeModel: "openai/gpt-5" }]);
  assert.equal(f.persistedHost().inferenceProvider, "command-code");
  assert.equal(f.persistedHost().commandCodeModel, "openai/gpt-5");
  assert.deepEqual(f.completed[0].failedSteps, []);
});

test("没有桌面选择时保留 host 的路由设置", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.chain.onTransportConnected();
  assert.deepEqual(f.routingRequests(), []);
  assert.equal(f.persistedHost().inferenceProvider, "openrouter");
  assert.equal(f.persistedHost().commandCodeModel, "deepseek/deepseek-v4-flash");
  assert.deepEqual(f.completed[0].failedSteps, []);
});

test("只保存 Command Code model 时保留 host 的 provider", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.settings.setCommandCodeModel("openai/gpt-5");
  await f.chain.onTransportConnected();
  assert.deepEqual(f.routingRequests(), [{ commandCodeModel: "openai/gpt-5" }]);
  assert.equal(f.persistedHost().inferenceProvider, "openrouter");
  assert.equal(f.persistedHost().commandCodeModel, "openai/gpt-5");
  assert.deepEqual(f.completed[0].failedSteps, []);
});

test("HTTP 失败报告 inference_router 并继续执行，重新连接恢复同步", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.settings.setInferenceProvider("command-code");
  f.rejectRouting(true);
  await f.chain.onTransportConnected();
  assert.deepEqual(f.completed[0].failedSteps, ["inference_router"]);
  assert.deepEqual(f.failures.map(({ step }) => step), ["inference_router"]);
  assert.match(f.failures[0].error.message, /routing update unavailable/);
  assert.deepEqual(f.tail, ["box_secrets", "window_focus"]);
  assert.equal(f.persistedHost().inferenceProvider, "openrouter");
  f.rejectRouting(false);
  await f.chain.onTransportConnected();
  assert.equal(f.persistedHost().inferenceProvider, "command-code");
  assert.equal(f.persistedHost().commandCodeModel, "deepseek/deepseek-v4-flash");
  assert.deepEqual(f.completed[1].failedSteps, []);
});

test("重新连接中的旧设置完成后按顺序发送新的桌面选择", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.settings.setInferenceProvider("command-code");
  f.settings.setCommandCodeModel("openai/gpt-5");
  const gate = f.holdRouting();
  const reconnect = f.chain.onTransportConnected();
  await gate.received.promise;
  f.settings.setInferenceProvider("claude-code");
  f.settings.setCommandCodeModel("openai/gpt-5-mini");
  const provider = f.chain.pushHostSettings({ inferenceProvider: "claude-code" });
  const model = f.chain.pushHostSettings({ commandCodeModel: "openai/gpt-5-mini" });
  gate.release.resolve();
  await Promise.all([reconnect, provider, model]);
  assert.deepEqual(f.routingRequests(), [
    { inferenceProvider: "command-code", commandCodeModel: "openai/gpt-5" },
    { inferenceProvider: "claude-code" },
    { commandCodeModel: "openai/gpt-5-mini" },
  ]);
  assert.equal(f.persistedHost().inferenceProvider, "claude-code");
  assert.equal(f.persistedHost().commandCodeModel, "openai/gpt-5-mini");
  await f.chain.onTransportConnected();
  assert.deepEqual(f.routingRequests().at(-1), { inferenceProvider: "claude-code", commandCodeModel: "openai/gpt-5-mini" });
});
