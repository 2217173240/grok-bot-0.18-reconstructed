import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

test("路径读取以真实文件验证正常读取、类型和链接拒绝", async (t) => {
  const tempRoot = path.join(root, ".cache", "ci-tmp");
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(path.join(tempRoot, "round2-paths-"));
  const outfile = path.join(dir, "runtime.mjs");
  await build({ stdin: { contents: `
    export * from "./source/packages/agent-store-sync/path-sync-request.ts";
    export * from "./source/packages/cursor-plugins/loader.ts";
    export * from "./tests/fixtures/box-exec-cancellation-runtime.ts";
    export { ReadArgs } from "./source/packages/proto/generated/agent/v1/read_exec_pb.ts";
  `, resolveDir: root }, outfile, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
  const api = await import(pathToFileURL(outfile).href);
  try {
    await t.test("路径同步请求保留正常入队/确认，并拒绝非文件", async () => {
      const filesDir = path.join(dir, "store", "files");
      await mkdir(filesDir, { recursive: true });
      const id = await api.enqueuePathSyncRequest({ filesDir, relPaths: ["hello.txt"], now: () => 100 });
      assert.ok(id);
      assert.deepEqual(api.listPathSyncRequests({ filesDir, now: () => 100 }).map(r => r.id), [id]);
      assert.equal(await api.waitForPathSyncRequestAck({ filesDir, requestId: id, now: () => 100, shouldAbort: () => true }), "aborted");
      api.ackPathSyncRequests({ filesDir, requestIds: [id] });
      assert.equal(await api.waitForPathSyncRequestAck({ filesDir, requestId: id }), "acked");
      const requestsDir = path.join(dir, "store", ".sync", "path-sync-requests");
      await mkdir(path.join(requestsDir, "directory.json"));
      assert.deepEqual(api.listPathSyncRequests({ filesDir }), []);
      if (process.platform !== "win32") {
        const outside = path.join(dir, "outside.json");
        await writeFile(outside, JSON.stringify({ v: 1, id: "outside", relPaths: ["secret"], createdAtMs: 100 }));
        await symlink(outside, path.join(requestsDir, "aaaa.json"));
        assert.deepEqual(api.listPathSyncRequests({ filesDir, now: () => 100 }), []);
        await symlink(outside, path.join(requestsDir, "bbbb.json"));
        assert.equal(await api.waitForPathSyncRequestAck({ filesDir, requestId: "bbbb", now: () => 100 }), "stale");
      }
    });

    await t.test("插件读取限制大小和类型，hooks 拒绝末级链接", async () => {
      const plugin = path.join(dir, "plugin");
      await mkdir(path.join(plugin, "hooks"), { recursive: true });
      await writeFile(path.join(plugin, "ok.md"), "safe content");
      const fetcher = api.createLocalPluginFileFetcher(plugin);
      assert.equal((await fetcher.fetchFile("ok.md")).content, "safe content");
      await assert.rejects(fetcher.fetchFile("hooks"));
      await writeFile(path.join(plugin, "large.md"), Buffer.alloc(10 * 1024 * 1024 + 1));
      await assert.rejects(fetcher.fetchFile("large.md"), /maximum size/);
      await writeFile(path.join(plugin, "hooks", "hooks.json"), "{bad json");
      const load = () => api.loadCursorPluginFromPath(plugin, "cursor-third-party", { name: "fixture", version: "1" });
      assert.match((await load()).hooks.error.message, /invalid JSON/);
      if (process.platform !== "win32") {
        await symlink(path.join(plugin, "ok.md"), path.join(plugin, "alias.md"));
        assert.equal((await fetcher.fetchFile("alias.md")).content, "safe content");
        const outside = path.join(dir, "outside-hooks.json");
        await writeFile(outside, "{bad json");
        await rm(path.join(plugin, "hooks", "hooks.json"));
        await symlink(outside, path.join(plugin, "hooks", "hooks.json"));
        assert.equal((await load()).hooks, undefined);
      }
    });

    await t.test("daemon 实际 RPC 拒绝目录和越界链接，文本仍可读取", async () => {
      const workspaceRoot = path.join(dir, "workspace");
      const daemon = await api.startBoxExecDaemon({ port: 0, authToken: "test-paths", workspaceRoot, terminalsDirectory: path.join(dir, "terminals") });
      try {
        const endpoint = new URL(daemon.url), ports = api.productionBoxGeneratedPorts;
        const transport = api.createBoxTransport({ host: endpoint.hostname, port: Number(endpoint.port), authToken: "test-paths" }, ports.createTransport);
        const client = ports.createExecClient(transport);
        const read = async (file) => {
          for await (const envelope of client.exec(api.createContext(), new api.ExecServerMessage({ id: 1, message: { case: "readArgs", value: new api.ReadArgs({ path: file }) } }))) {
            if (envelope.element.case === "execClientMessage" && envelope.element.value.message.case === "readResult") return envelope.element.value.message.value.result;
          }
          assert.fail("missing read result");
        };
        await writeFile(path.join(workspaceRoot, "ok.txt"), "safe daemon text");
        assert.equal((await read("/workspace/ok.txt")).value.output.value, "safe daemon text");
        assert.equal((await read("/workspace")).case, "invalidFile");
        if (process.platform !== "win32") {
          await symlink(path.join(dir, "outside.json"), path.join(workspaceRoot, "escape"));
          assert.equal((await read("/workspace/escape")).case, "rejected");
        }
      } finally { await daemon.stop(); }
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
