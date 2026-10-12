import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

test("运行标志原子发布，预置符号链接不能改写外部目标", { skip: process.platform === "win32", timeout: 30_000 }, async t => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "marker-boundaries-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, "markers.cjs");
  const modules = {
    makeCopyInStatusWriter: "source/host/extensions/box-store-sync/box-copy-in.ts",
    createUaTokenKillSwitchReconciler: "source/host/extensions/browser-ua/ua-token-kill-switch-service.ts",
    createUaOwnerStampWriter: "source/host/extensions/browser-ua/ua-owner-stamp-service.ts",
    applyWebAuthnProxyMarker: "source/host/extensions/webauthn-proxy/webauthn-proxy-marker.ts",
    writeBoxReadyStageMarker: "source/host/sand-host.ts",
    writeFileAtomicSync: "source/shared/node/atomic-write.ts",
  };
  await build({ stdin: { contents: Object.entries(modules).map(([name, file]) => `export { ${name} } from ${JSON.stringify(`./${file}`)};`).join("\n"), resolveDir: root, loader: "ts" }, outfile, bundle: true, packages: "external", platform: "node", format: "cjs", logLevel: "silent" });
  const api = require(outfile);
  const token = `header.${Buffer.from(JSON.stringify({ sub: "marker-test-user" })).toString("base64url")}.signature`;
  const stamp = `${createHash("sha256").update("marker-test-user").digest("hex").slice(0, 16)}\n`;
  const policyCommand = path.join(directory, "missing-policy-command");
  const cases = [
    { name: "copy-in", contents: '{"phase":"done"}', write: file => api.makeCopyInStatusWriter(file)({ phase: "done" }, { force: true }) },
    { name: "ua-disabled", contents: "1\n", write: file => api.createUaTokenKillSwitchReconciler({ path: file, isKillSwitchEnabled: () => true, log: message => assert.fail(message) })() },
    { name: "ua-owner", contents: stamp, write: file => api.createUaOwnerStampWriter({ path: file, log: message => assert.fail(message) })(token) },
    { name: "webauthn", contents: "", write: file => assert.equal(api.applyWebAuthnProxyMarker(true, file, policyCommand), "applied") },
    { name: "box-ready", contents: "boot-test-id", write: file => api.writeBoxReadyStageMarker("boot-test-id", file) },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const folder = path.join(directory, entry.name);
      await mkdir(folder);
      const target = path.join(folder, "target");
      const marker = path.join(folder, "marker");
      await writeFile(target, "preserved");
      await symlink(target, marker);
      await symlink(target, `${marker}.tmp`);
      await entry.write(marker);
      assert.equal(await readFile(target, "utf8"), "preserved");
      assert.equal((await lstat(marker)).isSymbolicLink(), false);
      assert.equal(await readFile(marker, "utf8"), entry.contents);
      assert.equal((await stat(marker)).mode & 0o777, 0o644 & ~process.umask());
      assert.deepEqual((await readdir(folder)).sort(), ["marker", "marker.tmp", "target"]);
    });
  }

  await t.test("WebAuthn 清除悬空链接，启用时替换链接且保留同步错误", async () => {
    const marker = path.join(directory, "dangling-marker");
    const missing = path.join(directory, "missing-target");
    await symlink(missing, marker);
    assert.equal(api.applyWebAuthnProxyMarker(false, marker, policyCommand), "applied");
    await assert.rejects(lstat(marker), { code: "ENOENT" });
    await symlink(missing, marker);
    assert.equal(api.applyWebAuthnProxyMarker(true, marker, policyCommand), "applied");
    assert.equal(await readFile(marker, "utf8"), "");
    await assert.rejects(lstat(missing), { code: "ENOENT" });
    assert.equal(api.applyWebAuthnProxyMarker(true, marker, policyCommand), "unchanged");
    assert.equal(api.applyWebAuthnProxyMarker(false, marker, policyCommand), "applied");
    assert.equal(api.applyWebAuthnProxyMarker(false, marker, policyCommand), "unchanged");
    await mkdir(marker);
    assert.throws(() => api.applyWebAuthnProxyMarker(false, marker, policyCommand));
  });

  await t.test("失败保留既有错误策略并清理随机临时文件", async () => {
    const folder = path.join(directory, "failure");
    const target = path.join(folder, "directory-target");
    await mkdir(target, { recursive: true });
    assert.throws(() => api.writeFileAtomicSync(target, "blocked"));
    await assert.rejects(api.writeBoxReadyStageMarker("blocked", target));
    const logs = [];
    await api.createUaTokenKillSwitchReconciler({ path: target, isKillSwitchEnabled: () => true, log: message => logs.push(message) })();
    await api.createUaOwnerStampWriter({ path: target, log: message => logs.push(message) })(token);
    assert.equal(logs.length, 2);
    api.makeCopyInStatusWriter(target)({ phase: "done" }, { force: true });
    assert.deepEqual(await readdir(folder), ["directory-target"]);
    assert.deepEqual(await readdir(target), []);
  });
});
