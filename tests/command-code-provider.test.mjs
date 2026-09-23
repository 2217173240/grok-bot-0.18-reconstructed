import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

async function bundledModule(source, workspace, name) {
  const outfile = path.join(workspace, `${name}.mjs`);
  await build({ entryPoints: [path.join(root, source)], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
  return import(pathToFileURL(outfile).href);
}

async function withWorkspace(run) {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const workspace = await mkdtemp(path.join(root, ".cache/command-code-"));
  try { await run(workspace); }
  finally { await rm(workspace, { recursive: true, force: true }); }
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${server.address().port}/models`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error == null ? resolve() : reject(error)));
}

test("Command Code filters the catalog and reports offline and timeout failures", async () => {
  await withWorkspace(async workspace => {
    const { fetchCommandCodeModels } = await bundledModule("source/shared/node/command-code-models.ts", workspace, "models");
    const catalog = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [
        { id: "openai/gpt-5", name: "GPT 5", context_length: 128000, supported_endpoints: ["/chat/completions"] },
        { id: "openai/gpt-5", supported_endpoints: ["/chat/completions"] },
        { id: "anthropic/claude", supported_endpoints: ["/messages"] },
        { id: "invalid id", supported_endpoints: ["/chat/completions"] },
      ] }));
    });
    const url = await listen(catalog);
    try {
      assert.deepEqual(await fetchCommandCodeModels({ url }), [{ id: "openai/gpt-5", name: "GPT 5", contextLength: 128000 }]);
    } finally { await close(catalog); }
    await assert.rejects(fetchCommandCodeModels({ url }), /fetch failed/);

    const stalled = createServer(() => {});
    const stalledUrl = await listen(stalled);
    try {
      await assert.rejects(fetchCommandCodeModels({ url: stalledUrl, timeoutMs: 40 }), error => error?.name === "TimeoutError");
    } finally { await close(stalled); }
  });
});

test("Command Code rejects a missing key and an invalid model override before an API call", async () => {
  await withWorkspace(async workspace => {
    const { createProviderPromptSession } = await bundledModule("source/host/extensions/inference/provider-session.ts", workspace, "provider");
    const previous = {
      dataRoot: process.env.SAND_DATA_ROOT,
      key: process.env.COMMAND_CODE_API_KEY,
      model: process.env.SAND_COMMANDCODE_MODEL,
    };
    try {
      process.env.SAND_DATA_ROOT = workspace;
      delete process.env.COMMAND_CODE_API_KEY;
      delete process.env.SAND_COMMANDCODE_MODEL;
      const session = createProviderPromptSession("command-code");
      assert.equal(session.getModelId(), "deepseek/deepseek-v4-flash");
      assert.throws(() => session.getExecutor().stream({ signal: AbortSignal.timeout(100) }), /COMMAND_CODE_API_KEY/);
      process.env.COMMAND_CODE_API_KEY = "   ";
      assert.throws(() => session.getExecutor().stream({ signal: AbortSignal.timeout(100) }), /COMMAND_CODE_API_KEY/);
      process.env.SAND_COMMANDCODE_MODEL = "invalid model id";
      assert.throws(() => createProviderPromptSession("command-code"), /SAND_COMMANDCODE_MODEL/);
    } finally {
      if (previous.dataRoot === undefined) delete process.env.SAND_DATA_ROOT; else process.env.SAND_DATA_ROOT = previous.dataRoot;
      if (previous.key === undefined) delete process.env.COMMAND_CODE_API_KEY; else process.env.COMMAND_CODE_API_KEY = previous.key;
      if (previous.model === undefined) delete process.env.SAND_COMMANDCODE_MODEL; else process.env.SAND_COMMANDCODE_MODEL = previous.model;
    }
  });
});

test("Command Code model survives host settings persistence and appears in the settings snapshot", async () => {
  await withWorkspace(async workspace => {
    const { SettingsService } = await bundledModule("source/host/extensions/settings/settings-service.ts", workspace, "settings");
    const settingsPath = path.join(workspace, "settings.json");
    const service = new SettingsService(settingsPath);
    assert.equal(service.getHostSettings().commandCodeModel, undefined);
    assert.equal(service.setHostSettings({ commandCodeModel: "openai/gpt-5" }).commandCodeModel, "openai/gpt-5");
    assert.equal(new SettingsService(settingsPath).getHostSettings().commandCodeModel, "openai/gpt-5");
    assert.equal(service.setHostSettings({ commandCodeModel: "invalid model" }).commandCodeModel, "openai/gpt-5");
  });
});
