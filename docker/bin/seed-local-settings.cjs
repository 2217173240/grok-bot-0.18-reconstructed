const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { parseArgs } = require("node:util");

function optionalStat(file) {
  try { return fs.lstatSync(file); }
  catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function seedLocalSettings(dataRoot, { provider, commandCodeModel, uid, gid }) {
  if (typeof provider !== "string" || !provider.trim()) throw new Error("provider 必须是非空字符串");
  if (commandCodeModel !== undefined && (typeof commandCodeModel !== "string" || !commandCodeModel.trim())) {
    throw new Error("commandCodeModel 必须是非空字符串");
  }
  if ((uid !== undefined || gid !== undefined) &&
      (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0)) {
    throw new Error("uid 和 gid 必须同时提供非负整数");
  }
  const directoryStat = optionalStat(dataRoot);
  if (directoryStat && !directoryStat.isDirectory()) throw new Error("数据目录必须是常规目录");
  const destination = path.join(dataRoot, "settings.json");
  const previousStat = optionalStat(destination);
  if (previousStat && !previousStat.isFile()) throw new Error("settings.json 必须是常规文件");
  let settings = {};
  let previousBytes;
  if (previousStat) {
    const descriptor = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const openedStat = fs.fstatSync(descriptor);
      if (!openedStat.isFile() || openedStat.ino !== previousStat.ino || openedStat.dev !== previousStat.dev) {
        throw new Error("settings.json 在读取之前发生变化");
      }
      previousBytes = fs.readFileSync(descriptor, "utf8");
      try {
        settings = JSON.parse(previousBytes);
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error("settings.json 包含无效 JSON");
        throw error;
      }
    } finally { fs.closeSync(descriptor); }
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("settings.json 必须包含 JSON object");
    }
  }
  settings.inferenceProvider = provider;
  if (commandCodeModel !== undefined) settings.commandCodeModel = commandCodeModel;
  const bytes = JSON.stringify(settings, null, 2) + "\n";
  // 已有内容通过验证以后才修复数据目录的属主。
  if (!directoryStat) fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  if (uid !== undefined && (!directoryStat || directoryStat.uid !== uid || directoryStat.gid !== gid)) {
    fs.chownSync(dataRoot, uid, gid);
  }
  if (bytes === previousBytes && (previousStat.mode & 0o7777) === 0o600 &&
      (uid === undefined || (previousStat.uid === uid && previousStat.gid === gid))) return;

  const temporary = path.join(dataRoot, `.settings-${randomUUID()}.tmp`);
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
    fs.writeFileSync(descriptor, bytes, "utf8");
    fs.fchmodSync(descriptor, 0o600);
    if (uid !== undefined) fs.fchownSync(descriptor, uid, gid);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const currentStat = optionalStat(destination);
    if (previousStat ? !currentStat || !currentStat.isFile() || currentStat.ino !== previousStat.ino || currentStat.dev !== previousStat.dev : currentStat) {
      throw new Error("settings.json 在写入之前发生变化");
    }
    fs.renameSync(temporary, destination);
    created = false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created) fs.unlinkSync(temporary);
  }
}

module.exports = { seedLocalSettings };

if (require.main === module) {
  const { values } = parseArgs({ options: {
    provider: { type: "string" },
    "command-code-model": { type: "string" },
  } });
  if (!values.provider) throw new Error("需要 --provider 参数");
  const uid = Number(execFileSync("id", ["-u", "box"], { encoding: "utf8" }).trim());
  const gid = Number(execFileSync("id", ["-g", "box"], { encoding: "utf8" }).trim());
  seedLocalSettings("/home/box/sand-data", { provider: values.provider, commandCodeModel: values["command-code-model"], uid, gid });
}
