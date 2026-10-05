import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const connectorPath = path.join(root, "source/electron-main/box/local-docker-host-connector.ts");
await mkdir(path.join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".cache/docker-seed-"));
await build({
  entryPoints: [connectorPath, path.join(root, "source/host/host-paths.ts")],
  outdir: directory, outbase: path.join(root, "source"), outExtension: { ".js": ".mjs" },
  bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { SAND_BOX_UID, SAND_BOX_GID } = await import(pathToFileURL(path.join(directory, "electron-main/box/local-docker-host-connector.mjs")).href);
const { SAND_BOX_DATA_ROOT } = await import(pathToFileURL(path.join(directory, "host/host-paths.mjs")).href);
test.after(() => rm(directory, { recursive: true, force: true }));

// 容器创建时把这段程序交给 `docker run --entrypoint node -e`。它必须是合法 JavaScript：
// 模板字面量里的转义如果写成 "\n" 而不是 "\\n"，生成的程序会带真实换行并直接解析失败，
// 容器就再也建不起来。挂载目标同理：挂到镜像里不存在的路径，新建的卷根目录归 root，
// box 用户写不进去，同一个卷交给生产容器后也不可写。这里按源码原文重建程序并断言。
function mergeScriptTemplate() {
  const line = readFileSync(connectorPath, "utf8").split("\n").find(entry => entry.includes("const mergeScript ="));
  assert.ok(line, "没有找到 mergeScript 的构造位置");
  const start = line.indexOf("`");
  const end = line.lastIndexOf("`");
  assert.ok(start !== -1 && end > start, "mergeScript 不是模板字面量");
  return line.slice(start + 1, end);
}

function buildSeedScript(provider, commandCodeModel) {
  const template = mergeScriptTemplate();
  return new Function(
    "provider", "commandCodeModel", "SAND_BOX_DATA_ROOT", "SAND_BOX_UID", "SAND_BOX_GID",
    `return \`${template}\`;`,
  )(provider, commandCodeModel, SAND_BOX_DATA_ROOT, SAND_BOX_UID, SAND_BOX_GID);
}

test("容器设置写入程序是单行合法 JavaScript，写到生产数据目录", () => {
  for (const commandCodeModel of [undefined, "command-code-model"]) {
    const script = buildSeedScript("claude-code", commandCodeModel);
    assert.ok(!script.includes("\n"), "生成的程序不能包含真实换行");
    assert.doesNotThrow(() => new Function(script), "生成的程序必须可解析");
    assert.match(script, new RegExp(`const d=${JSON.stringify(SAND_BOX_DATA_ROOT).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "必须挂载并使用生产数据目录");
    assert.doesNotMatch(script, /"\/data/, "不能再写到镜像里不存在的 /data");
    assert.match(script, /JSON\.stringify\(s,null,2\)\+"\\n"\)/, "写文件时必须以换行结束");
    assert.match(script, new RegExp(`fs\\.chownSync\\(d,${SAND_BOX_UID},${SAND_BOX_GID}\\)`), "必须把数据目录交还 box 用户");
    assert.match(script, new RegExp(`fs\\.chownSync\\(p,${SAND_BOX_UID},${SAND_BOX_GID}\\)`), "必须把设置文件交还 box 用户");
    assert.match(script, /s\.inferenceProvider="claude-code"/);
    if (commandCodeModel === undefined) assert.ok(!script.includes("commandCodeModel"));
    else assert.match(script, /s\.commandCodeModel="command-code-model"/);
  }
});

test("种子步骤以 root 运行并按生产路径挂载数据卷", () => {
  const source = readFileSync(connectorPath, "utf8");
  const run = source.split("\n").find(entry => entry.includes("const seeded = await runDocker("));
  assert.ok(run, "没有找到种子步骤的 docker run");
  assert.match(run, /"--user", "root"/, "种子需要 root 才能纠正卷根属主");
  assert.match(run, /`\$\{dataVolume\}:\$\{SAND_BOX_DATA_ROOT\}`/, "数据卷必须挂到生产数据目录");
});
