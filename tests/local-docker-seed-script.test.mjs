import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const connector = readFileSync(path.join(root, "source/electron-main/box/local-docker-host-connector.ts"), "utf8");

// 容器创建时把这段脚本交给 `docker run --entrypoint node -e`。它必须是合法 JavaScript：
// 模板字面量里的转义如果写成 "\n" 而不是 "\\n"，生成的脚本会带真实换行并直接解析失败，
// 容器就再也建不起来。这里按源码原文重建脚本并断言它可解析。
function mergeScriptTemplate() {
  const line = connector.split("\n").find(entry => entry.includes("const mergeScript ="));
  assert.ok(line, "没有找到 mergeScript 的构造位置");
  const start = line.indexOf("`");
  const end = line.lastIndexOf("`");
  assert.ok(start !== -1 && end > start, "mergeScript 不是模板字面量");
  return line.slice(start + 1, end);
}

function build(provider, commandCodeModel) {
  return new Function("provider", "commandCodeModel", `return \`${mergeScriptTemplate()}\`;`)(provider, commandCodeModel);
}

test("容器设置写入脚本是单行合法 JavaScript", () => {
  for (const commandCodeModel of [undefined, "command-code-model"]) {
    const script = build("claude-code", commandCodeModel);
    assert.ok(!script.includes("\n"), "生成的脚本不能包含真实换行");
    assert.doesNotThrow(() => new Function(script), "生成的脚本必须可解析");
    assert.match(script, /JSON\.stringify\(s,null,2\)\+"\\n"\)/, "写文件时必须以换行结束");
    assert.match(script, /s\.inferenceProvider="claude-code"/);
    if (commandCodeModel === undefined) assert.ok(!script.includes("commandCodeModel"));
    else assert.match(script, /s\.commandCodeModel="command-code-model"/);
  }
});
