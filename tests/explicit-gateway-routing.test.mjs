import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("显式 gateway 保持目标与鉴权，不要求云端签发能力", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/gateway-routing-"));
  const previous = process.env.SAND_LOCAL_ADMIN;
  process.env.SAND_LOCAL_ADMIN = "1";
  try {
    const outfile = path.join(directory, "routing.mjs");
    await build({ stdin: {
      contents: 'export { EnvDescriptorHostConnector } from "./source/electron-main/box/box-host-connector.ts"; export { createSettingsRoutedHostConnector } from "./source/electron-main/box/local-docker-host-connector.ts"; export { SandSettingsStore } from "./source/shared/node/settings/sand-settings-store.ts";',
      resolveDir: root, loader: "ts",
    }, outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    const { EnvDescriptorHostConnector, createSettingsRoutedHostConnector, SandSettingsStore } = await import(pathToFileURL(outfile).href);
    const settings = new SandSettingsStore(path.join(directory, "settings.json"));
    settings.setBoxRuntime("local-docker");
    const explicit = new EnvDescriptorHostConnector({ SAND_HOST_GATEWAY_URL: "http://127.0.0.1:1340", SAND_HOST_GATEWAY_TOKEN: "test-gateway-token" });
    const connector = createSettingsRoutedHostConnector(explicit, settings);
    assert.equal(connector, explicit);
    assert.deepEqual(await connector.connect(), { baseUrl: "http://127.0.0.1:1340", token: "test-gateway-token" });
    assert.equal(connector.issueLocalExecDaemonCredential, undefined);
    assert.equal(connector.recreate, undefined);
  } finally {
    if (previous === undefined) delete process.env.SAND_LOCAL_ADMIN;
    else process.env.SAND_LOCAL_ADMIN = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
