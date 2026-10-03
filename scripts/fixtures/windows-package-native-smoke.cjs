const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

async function main() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(process.versions.electron, "42.1.0", "必须使用最终打包 Electron 执行 native 验证");
  assert.equal(process.versions.modules, "146");
  const [archive, reportPath] = process.argv.slice(2);
  const deps = path.join(archive, "dist", "deps");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE smoke (value TEXT NOT NULL)");
    database.prepare("INSERT INTO smoke VALUES (?)").run("Windows native SQLite");
    assert.equal(database.prepare("SELECT value FROM smoke").get().value, "Windows native SQLite");
  } finally { database.close(); }
  const Parser = require(path.join(deps, "tree-sitter"));
  const Bash = require(path.join(deps, "tree-sitter-bash"));
  const parser = new Parser();
  parser.setLanguage(Bash);
  const tree = parser.parse("printf '%s' windows-native-smoke\n");
  assert.equal(tree.rootNode.type, "program");
  assert.equal(tree.rootNode.hasError, false);
  assert.equal(tree.rootNode.namedChildren[0].type, "command");
  const { cursor_proclist_scan_async } = require(path.join(deps, "cursor-proclist"));
  const processes = await cursor_proclist_scan_async([process.pid]);
  assert(Array.isArray(processes));
  assert(processes.some(row => row[0] === process.pid), "native process scan 未包含当前 Electron 进程");
  fs.writeFileSync(reportPath, JSON.stringify({ electron: process.versions.electron, modules: process.versions.modules, platform: process.platform, arch: process.arch, sqlite: true, treeSitterBash: true, processScan: true }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
