import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

test("桌面连接读取当前 noVNC 文件，exec-only 返回空地址", async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "desktop-url-"));
  try {
    const outfile = path.join(directory, "reader.mjs");
    await build({ entryPoints: [path.join(root, "source/host/box/local-desktop-url.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    const { readLocalDesktopUrl } = await import(pathToFileURL(outfile).href);
    const metadata = path.join(directory, ".grokbot");
    const filename = path.join(metadata, "novnc-url");
    const token = "a1".repeat(32);
    const valid = `http://127.0.0.1:6080/vnc.html?autoconnect=1&path=websockify%3Ftoken%3D${token}`;
    assert.equal(await readLocalDesktopUrl(false, directory), "");
    await assert.rejects(readLocalDesktopUrl(true, directory), /connection file is unavailable/);
    await mkdir(metadata);
    await writeFile(filename, `${valid}\n`);
    assert.equal(await readLocalDesktopUrl(true, directory), valid);
    assert.equal(await readLocalDesktopUrl(false, directory), "");
    const refreshed = valid.replace(token, "b2".repeat(32));
    await writeFile(filename, refreshed);
    assert.equal(await readLocalDesktopUrl(true, directory), refreshed);
    for (const host of ["localhost", "[::1]"]) {
      const loopback = valid.replace("127.0.0.1", host);
      await writeFile(filename, loopback);
      assert.equal(await readLocalDesktopUrl(true, directory), loopback);
    }
    for (const invalid of [
      "", "invalid URL", "http://127.0.0.1:6080/vnc.html", valid.replace("http:", "https:"),
      valid.replace("127.0.0.1", "example.com"), valid.replace(":6080", ":6081"), valid.replace("/vnc.html", "/index.html"),
      valid.replace("127.0.0.1", "user:password@127.0.0.1"), `${valid}#fragment`,
      valid.replace("websockify", "other"), valid.replace(token, "1"), valid.replace(token, "z".repeat(64)),
      valid.replace("%3Ftoken%3D", "%3Fother%3D"), `${valid}&path=websockify`,
      `${valid}&host=example.com`, `${valid}&autoconnect=0`, valid.replace("autoconnect=1", "autoconnect=0"),
      valid.replace(token, `${token.slice(0, 4)}\n${token.slice(4)}`),
    ]) {
      await writeFile(filename, invalid);
      await assert.rejects(readLocalDesktopUrl(true, directory), error => {
        assert.match(error.message, /connection file is invalid/);
        assert.ok(!error.message.includes(token));
        assert.ok(!error.message.includes("password"));
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(await readLocalDesktopUrl(false, directory), "");
    }
    await rm(filename);
    await assert.rejects(readLocalDesktopUrl(true, directory), /connection file is unavailable/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("生产 ensureReady 每次读取桌面地址，executor 和地址使用同一开关", async () => {
  const source = await readFile(path.join(root, "source/host/box/production.ts"), "utf8");
  assert.match(source, /ensureReady: async \(ctx, agentId\) => \{\s*const primary = await loopback\.ensureReady\(ctx, agentId\);\s*const vncUrl = await readLocalDesktopUrl\(desktopEnabled, workspaceRoot\);/);
  assert.match(source, /const desktopEnabled = localDesktopComputerUseEnabled\(\);\s*return createStandaloneProductionBoxInner\(\s*loopback,\s*desktopEnabled\s*\? \(accessor => generated\.withLocalDesktopComputerUse\(accessor\)\)\s*: \(accessor => generated\.withNoMonitorComputerUse\(accessor\)\),\s*desktopEnabled\s*\)/);
});
