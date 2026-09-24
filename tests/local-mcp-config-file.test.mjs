import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

async function withConfig(callback) {
  const root = path.resolve(import.meta.dirname, "..");
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "mcp-config-"));
  try {
    const output = path.join(directory, "config.mjs");
    await build({ entryPoints: [path.join(root, "source/shared/node/mcp/local-mcp-servers.ts")], outfile: output, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    await callback(await import(pathToFileURL(output).href), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("空目录中的旧配置迁移后，界面新增保留已有服务器", async () => {
  await withConfig(async (api, directory) => {
    await mkdir(path.join(directory, "mcp-config", "shared"), { recursive: true });
    const legacy = path.join(directory, "mcp-servers.json");
    const original = { mcpServers: { existing: { command: "node", args: ["server.js"] } } };
    await writeFile(legacy, JSON.stringify(original), { mode: 0o600 });
    assert.equal(await api.readLocalMcpServersConfig(directory), null);
    const writer = api.createLocalMcpServersFileWriter(directory);
    const { config } = await writer.getConfigForEdit();
    assert.deepEqual(config, original);
    config.mcpServers.extra = { command: "python3" };
    await writer.setConfig(config);
    assert.deepEqual(await api.readLocalMcpServersConfig(directory), config);
    await assert.rejects(stat(legacy), { code: "ENOENT" });
    assert.equal((await stat(path.join(directory, "mcp-config"))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, "mcp-config", "shared"))).mode & 0o777, 0o755);
    assert.equal((await stat(api.localMcpServersPath(directory))).mode & 0o777, 0o644);
  });
});

test("初始化后的配置删除保持为空，旧文件保持原内容", async () => {
  await withConfig(async (api, directory) => {
    const writer = api.createLocalMcpServersFileWriter(directory);
    await writer.setConfig({ mcpServers: { current: { command: "node" } } });
    const legacy = path.join(directory, "mcp-servers.json");
    const old = JSON.stringify({ mcpServers: { old: { command: "python3" } } });
    await writeFile(legacy, old);
    await rm(api.localMcpServersPath(directory));
    assert.equal(await api.readLocalMcpServersConfig(directory), null);
    assert.deepEqual((await writer.getConfigForEdit()).config, { mcpServers: {} });
    assert.equal(await readFile(legacy, "utf8"), old);
    api.prepareLocalMcpPluginsDir(directory);
    assert.equal(await api.readLocalMcpServersConfig(directory), null);
  });
});

test("旧配置的符号链接与目录明确报告错误", async () => {
  await withConfig(async (api, directory) => {
    const legacy = path.join(directory, "mcp-servers.json");
    const linked = path.join(directory, "external.json");
    await writeFile(linked, JSON.stringify({ mcpServers: {} }));
    await symlink(linked, legacy);
    await assert.rejects(api.readLocalMcpServersConfig(directory), /must be a regular file/);
    await assert.rejects(api.createLocalMcpServersFileWriter(directory).getConfigForEdit(), /must be a regular file/);
    await rm(legacy);
    await mkdir(legacy);
    await assert.rejects(api.readLocalMcpServersConfig(directory), /must be a regular file/);
    await assert.rejects(api.createLocalMcpServersFileWriter(directory).getConfigForEdit(), /must be a regular file/);
    assert.equal(await readFile(linked, "utf8"), JSON.stringify({ mcpServers: {} }));
  });
});

test("损坏的旧配置保持原内容，私有目录拒绝符号链接", async () => {
  await withConfig(async (api, directory) => {
    const legacy = path.join(directory, "mcp-servers.json");
    await writeFile(legacy, "{broken", { mode: 0o600 });
    await assert.rejects(api.createLocalMcpServersFileWriter(directory).getConfigForEdit(), /not valid JSON/);
    assert.equal(await readFile(legacy, "utf8"), "{broken");
    const linkedRoot = path.join(directory, "linked");
    await mkdir(linkedRoot);
    await symlink(path.join(directory, "mcp-config"), path.join(linkedRoot, "mcp-config"));
    assert.throws(() => api.prepareLocalMcpPluginsDir(linkedRoot), /must be a directory/);
  });
});

test("Docker box 用户读取首次创建及原子替换配置，绑定只读且 plugins 可写", { skip: process.env.RUN_LOCAL_DOCKER_E2E !== "1" }, async () => {
  await withConfig(async (api, directory) => {
    await chmod(directory, 0o755);
    const shared = api.prepareLocalMcpPluginsDir(directory);
    await copyFile(path.join(directory, "config.mjs"), path.join(shared, "reader.mjs"));
    const name = `grok-pr75-mcp-${process.pid}-${Date.now()}`;
    const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
    const run = code => docker("exec", "--user", "box", name, "node", "-e", code);
    try {
      docker("run", "--detach", "--name", name, "--network", "none", "--user", "box", "--tmpfs", "/home/box/sand-data:mode=1777", "--mount", `type=bind,src=${shared},dst=/home/box/sand-data/mcp-config/shared,readonly`, "--entrypoint", "node", process.env.MCP_DOCKER_IMAGE ?? "grok-bot-exec-box:arm64", "-e", "setInterval(() => {}, 60000)");
      assert.equal(run("console.log(require('fs').existsSync('/home/box/sand-data/mcp-config/shared/mcp-servers.json'))"), "false");
      const writer = api.createLocalMcpServersFileWriter(directory);
      const config = { mcpServers: { first: { command: "node" } } };
      const previousUmask = process.umask(0o077);
      try { await writer.setConfig(config); } finally { process.umask(previousUmask); }
      const assertVisible = async expected => {
        const deadline = Date.now() + 5000;
        const json = JSON.stringify(expected);
        // Colima 的文件属性缓存可能短暂保留原子替换前的长度。
        while (true) {
          const observed = run("import('/home/box/sand-data/mcp-config/shared/reader.mjs').then(async api => console.log(JSON.stringify(await api.readLocalMcpServersConfig('/home/box/sand-data')))).catch(error => console.log(JSON.stringify({error:error.message})))");
          if (observed === json) return;
          if (Date.now() >= deadline) assert.equal(observed, json);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      };
      await assertVisible(config);
      config.mcpServers.second = { command: "python3" };
      await writer.setConfig(config);
      await assertVisible(config);
      const target = api.localMcpServersPath(directory);
      const replacement = `${target}.editor`;
      config.mcpServers.editor = { command: "echo" };
      await writeFile(replacement, JSON.stringify(config), { mode: 0o644 });
      await rename(replacement, target);
      await assertVisible(config);
      await writeFile(target, "{broken");
      await assertVisible({ error: "mcp-servers.json is not valid JSON." });
      assert.equal(await readFile(target, "utf8"), "{broken");
      await writer.setConfig(config);
      await assertVisible(config);
      assert.equal(run("const fs=require('fs'); for (const p of ['/home/box/sand-data/mcp-config/shared/mcp-servers.json','/home/box/sand-data/mcp-config/shared/extra']) { try {fs.writeFileSync(p,'bad');process.exit(1)} catch(e) {if(e.code!=='EROFS' && e.code!=='EACCES') throw e;} } console.log('readonly')"), "readonly");
      run("require('fs').writeFileSync('/home/box/sand-data/mcp-servers.json', JSON.stringify({mcpServers:{old:{command:'node'}}}))");
      await rm(target);
      await assertVisible(null);
      assert.equal(run("const fs=require('fs'); fs.mkdirSync('/home/box/sand-data/plugins/cache',{recursive:true}); fs.writeFileSync('/home/box/sand-data/plugins/cache/test','ok'); console.log(fs.readFileSync('/home/box/sand-data/plugins/cache/test','utf8'))"), "ok");
    } finally {
      const removed = spawnSync("docker", ["rm", "--force", name], { encoding: "utf8" });
      assert.equal(removed.status, 0, removed.stderr);
    }
  });
});

test("真实 MCP 配置文件保留 HTTP headers，损坏内容禁止作为空配置读取", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "mcp-config-"));
  try {
    const output = path.join(directory, "config.mjs");
    await build({ entryPoints: [path.join(root, "source/shared/node/mcp/local-mcp-servers.ts")], outfile: output, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    const api = await import(pathToFileURL(output).href);
    assert.equal(await api.readLocalMcpServersConfig(directory), null);
    const configuration = { mcpServers: { endpoint: { url: "http://127.0.0.1:1234/mcp", headers: { "X-Workspace": "test" }, type: "http" } } };
    const writer = api.createLocalMcpServersFileWriter(directory);
    await writer.setConfig(configuration);
    assert.deepEqual(await api.readLocalMcpServersConfig(directory), configuration);
    assert.deepEqual((await writer.getConfigForEdit()).config, configuration);
    const target = path.join(directory, "mcp-config", "shared", "mcp-servers.json");
    await writeFile(target, "{broken");
    await assert.rejects(api.readLocalMcpServersConfig(directory), /not valid JSON/);
    await assert.rejects(writer.getConfigForEdit(), /not valid JSON/);
    assert.equal(await readFile(target, "utf8"), "{broken");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
