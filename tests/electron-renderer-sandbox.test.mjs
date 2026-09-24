import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build, transform } from "esbuild";
import { parse } from "acorn";
import { simple } from "acorn-walk";

const root = path.resolve(import.meta.dirname, "..");

test("主窗口与 Dev Controls 的生产配置启用 renderer sandbox", async () => {
  for (const filename of ["main.ts", "dev/dev-controls-window.ts"]) {
    const source = await readFile(path.join(root, "source/electron-main", filename), "utf8");
    const { code } = await transform(source, { loader: "ts", format: "esm" });
    const tree = parse(code, { ecmaVersion: "latest", sourceType: "module" });
    let windowOptions = 0;
    simple(tree, { CallExpression(node) {
      if (node.callee.type === "MemberExpression") {
        const method = node.callee.property.name;
        if (method === "appendSwitch") {
          const argument = node.arguments[0];
          assert.ok(!argument || argument.type !== "Literal" || !["no-sandbox", "disable-gpu-sandbox"].includes(argument.value), filename);
        }
        if (method === "createBrowserWindow") {
          const options = node.arguments[0];
          assert.ok(options && options.type === "ObjectExpression", filename);
          const preferences = options.properties.find((property) => property.type === "Property" && property.key.name === "webPreferences");
          assert.ok(preferences && preferences.value.type === "ObjectExpression", filename);
          const values = new Map(preferences.value.properties.filter((property) => property.type === "Property").map((property) => [property.key.name, property.value.value]));
          assert.equal(values.get("sandbox"), true, filename);
          assert.equal(values.get("nodeIntegration"), false, filename);
          assert.equal(values.get("contextIsolation"), true, filename);
          assert.ok(values.has("preload"), filename);
          windowOptions += 1;
        }
      }
    } });
    assert.equal(windowOptions, 1, filename);
  }
});

test("VNC 与普通 webview 执行 sandbox 配置并保留 preload 和导航规则", async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "renderer-sandbox-"));
  try {
    const outfile = path.join(directory, "vnc-trust.mjs");
    await build({ entryPoints: [path.join(root, "source/electron-main/vnc/vnc-trust.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    const { createBoxVncTrustRegistry, BOX_VNC_PARTITION } = await import(pathToFileURL(outfile).href);
    const registry = createBoxVncTrustRegistry({
      preloadDistDir: directory,
      onAssetFailure: assert.fail,
      routeHostInput: () => { throw new Error("本测试没有 host input"); },
    });
    for (const partition of [BOX_VNC_PARTITION, "persist:preview", undefined]) {
      for (const src of ["http://127.0.0.1:6080/vnc.html?network_token=test-token", "https://desktop.example/vnc.html", "about:blank", "file:///etc/passwd", "javascript:alert(1)", "invalid URL"]) {
        const preferences = { sandbox: false, nodeIntegration: true, contextIsolation: false, preload: "/untrusted/preload.cjs" };
        const params = { partition, src };
        registry.hardenAttach(preferences, params);
        assert.deepEqual(preferences, {
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(directory, partition === BOX_VNC_PARTITION ? "preload-vnc.cjs" : "preload-webview.cjs"),
        });
        const allowed = /^(http:|https:|about:)/.test(src);
        assert.equal(params.src, allowed ? src : undefined);
      }
    }
    assert.equal(registry.isTrustedBoxDesktopFrameUrl("https://desktop.example/vnc.html"), true);
    assert.equal(registry.isTrustedBoxDesktopFrameUrl("https://unregistered.example/vnc.html"), false);
    assert.equal(registry.isTrustedBoxDesktopFrameUrl("https://desktop.example/index.html"), false);
    assert.deepEqual(registry.getTokenInfo("127.0.0.1:6080"), { seeded: true, source: "url" });
    assert.equal(registry.beforeSendHeaders({ url: "http://127.0.0.1:6080/app/ui.js", requestHeaders: {} })["x-anyrun-network-token"], "test-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
