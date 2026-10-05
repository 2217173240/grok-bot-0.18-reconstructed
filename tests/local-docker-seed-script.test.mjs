import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const modulePath = path.join(root, "docker/bin/seed-local-settings.cjs");
const { seedLocalSettings } = createRequire(import.meta.url)(modulePath);
fs.mkdirSync(path.join(root, ".cache"), { recursive: true });
const directory = fs.mkdtempSync(path.join(root, ".cache/docker-seed-"));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
const identity = { uid: process.getuid(), gid: process.getgid() };

function fixture(content) {
  const dataRoot = fs.mkdtempSync(path.join(directory, "data-"));
  const file = path.join(dataRoot, "settings.json");
  if (content !== undefined) fs.writeFileSync(file, content);
  return { dataRoot, file };
}

test("创建设置内容并设定文件权限及属主", () => {
  const dataRoot = path.join(directory, "new", "data");
  seedLocalSettings(dataRoot, { provider: "claude-code", ...identity });
  const file = path.join(dataRoot, "settings.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { inferenceProvider: "claude-code" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(file).uid, identity.uid);
  assert.equal(fs.statSync(file).gid, identity.gid);
  assert.deepEqual(fs.readdirSync(dataRoot), ["settings.json"]);
});

test("保留未知字段及未传入的model，明确传入时更新model，重复执行保持文件", () => {
  const { dataRoot, file } = fixture(JSON.stringify({ custom: { enabled: true }, commandCodeModel: "existing", version: 7 }));
  seedLocalSettings(dataRoot, { provider: "claude-code", ...identity });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    custom: { enabled: true }, commandCodeModel: "existing", version: 7, inferenceProvider: "claude-code",
  });
  seedLocalSettings(dataRoot, { provider: "command-code", commandCodeModel: "selected", ...identity });
  const before = fs.statSync(file);
  const bytes = fs.readFileSync(file);
  seedLocalSettings(dataRoot, { provider: "command-code", commandCodeModel: "selected", ...identity });
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.statSync(file).ino, before.ino);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.equal(JSON.parse(bytes).commandCodeModel, "selected");
});

for (const content of ["{broken", "[]", "null", "12", '"text"', "false", ""]) {
  test(`拒绝无效object并保留原文件：${JSON.stringify(content)}`, () => {
    const { dataRoot, file } = fixture(content);
    const before = fs.statSync(file);
    assert.throws(() => seedLocalSettings(dataRoot, { provider: "claude-code", ...identity }));
    assert.equal(fs.readFileSync(file, "utf8"), content);
    assert.equal(fs.statSync(file).ino, before.ino);
    assert.equal(fs.statSync(file).mode, before.mode);
    assert.deepEqual(fs.readdirSync(dataRoot), ["settings.json"]);
  });
}

test("损坏JSON的错误和stack不包含设置原文", () => {
  const marker = "seed-sensitive-marker-827ac3";
  const content = Buffer.from(`{"headers": ${marker}}`);
  const { dataRoot, file } = fixture(content);
  assert.throws(() => seedLocalSettings(dataRoot, { provider: "claude-code", ...identity }), error => {
    assert.equal(error.message, "settings.json 包含无效 JSON");
    assert.ok(!String(error).includes(marker));
    assert.ok(!error.stack.includes(marker));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(fs.readFileSync(file), content);
});

test("拒绝settings符号链接、目录及FIFO，以及数据目录符号链接", () => {
  const { dataRoot, file } = fixture();
  const target = path.join(directory, "target.json");
  fs.writeFileSync(target, "{}");
  fs.symlinkSync(target, file);
  assert.throws(() => seedLocalSettings(dataRoot, { provider: "claude-code" }), /常规文件/);
  assert.equal(fs.readFileSync(target, "utf8"), "{}");
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(directory, "missing.json"), file);
  assert.throws(() => seedLocalSettings(dataRoot, { provider: "claude-code" }), /常规文件/);
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => seedLocalSettings(dataRoot, { provider: "claude-code" }), /常规文件/);
  fs.rmdirSync(file);
  const fifo = spawnSync("mkfifo", [file], { encoding: "utf8" });
  assert.equal(fifo.status, 0, fifo.stderr);
  assert.throws(() => seedLocalSettings(dataRoot, { provider: "claude-code" }), /常规文件/);
  const link = path.join(directory, "linked-data");
  fs.symlinkSync(dataRoot, link);
  assert.throws(() => seedLocalSettings(link, { provider: "claude-code" }), /常规目录/);
});

test("现有设置收紧为0600，其他数据权限保持不变", () => {
  const { dataRoot, file } = fixture('{"inferenceProvider":"claude-code"}');
  const unrelated = path.join(dataRoot, "other.txt");
  fs.writeFileSync(unrelated, "other", { mode: 0o644 });
  fs.chmodSync(file, 0o666);
  const before = fs.statSync(unrelated);
  seedLocalSettings(dataRoot, { provider: "claude-code", ...identity });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(unrelated).mode, before.mode);
  assert.equal(fs.statSync(unrelated).uid, before.uid);
});

test("不可读设置报错并保留原字节", { skip: process.getuid() === 0 }, () => {
  const { dataRoot, file } = fixture('{"kept":true}');
  fs.chmodSync(file, 0o000);
  try {
    assert.throws(() => seedLocalSettings(dataRoot, { provider: "claude-code", ...identity }), { code: "EACCES" });
    assert.equal(fs.statSync(file).mode & 0o777, 0);
  } finally { fs.chmodSync(file, 0o600); }
  assert.equal(fs.readFileSync(file, "utf8"), '{"kept":true}');
});

test("目录写入失败时保留原文件", { skip: process.getuid() === 0 }, () => {
  const { dataRoot, file } = fixture('{"kept":true}');
  const before = fs.statSync(file);
  fs.chmodSync(dataRoot, 0o500);
  try {
    assert.throws(() => seedLocalSettings(dataRoot, { provider: "claude-code", ...identity }), { code: "EACCES" });
    assert.equal(fs.readFileSync(file, "utf8"), '{"kept":true}');
    assert.equal(fs.statSync(file).ino, before.ino);
    assert.deepEqual(fs.readdirSync(dataRoot), ["settings.json"]);
  } finally { fs.chmodSync(dataRoot, 0o700); }
});

test("数据验证先于属主修改", { skip: process.getuid() === 0 }, () => {
  const { dataRoot, file } = fixture("null");
  assert.throws(() => seedLocalSettings(dataRoot, { provider: "claude-code", uid: identity.uid + 1, gid: identity.gid }), /JSON object/);
  assert.equal(fs.readFileSync(file, "utf8"), "null");
  assert.equal(fs.statSync(dataRoot).uid, identity.uid);
});

test("子进程加载模块并执行文件写入", () => {
  const { dataRoot, file } = fixture();
  const result = spawnSync(process.execPath, ["-e", "require(process.argv[1]).seedLocalSettings(process.argv[2], {provider: process.argv[3]})", modulePath, dataRoot, "command-code"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).inferenceProvider, "command-code");
});

test("CLI拒绝缺失provider和自定义数据目录参数", () => {
  for (const args of [[], ["--data-root", directory, "--provider", "claude-code"]]) {
    const result = spawnSync(process.execPath, [modulePath, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /provider|Unknown option/);
  }
});
