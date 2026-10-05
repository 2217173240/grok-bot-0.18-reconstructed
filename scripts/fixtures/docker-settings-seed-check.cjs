const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = "/home/box/sand-data";
const file = path.join(root, "settings.json");
const snapshotFile = path.join(root, "seed-smoke-snapshot.json");
const unrelatedFile = path.join(root, "seed-smoke-unrelated.txt");
const action = process.argv[1];
const marker = process.argv[2];
const boxUid = Number(execFileSync("id", ["-u", "box"], { encoding: "utf8" }).trim());
const boxGid = Number(execFileSync("id", ["-g", "box"], { encoding: "utf8" }).trim());

function readSettings() { return JSON.parse(fs.readFileSync(file, "utf8")); }
function checkOwnership() {
  for (const target of [root, file]) {
    const stat = fs.statSync(target);
    assert.equal(stat.uid, boxUid, "box uid");
    assert.equal(stat.gid, boxGid, "box gid");
  }
  assert.equal(fs.statSync(file).mode & 0o7777, 0o600, "settings mode");
}
function snapshot() {
  const stat = fs.statSync(file);
  fs.writeFileSync(snapshotFile, JSON.stringify({
    bytes: fs.readFileSync(file).toString("base64"), ino: stat.ino, mtimeMs: stat.mtimeMs,
    uid: stat.uid, gid: stat.gid, mode: stat.mode,
  }), { mode: 0o600 });
}
function checkSnapshot() {
  const expected = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
  const stat = fs.statSync(file);
  assert.ok(fs.readFileSync(file).equals(Buffer.from(expected.bytes, "base64")), "settings bytes changed");
  for (const field of ["ino", "mtimeMs", "uid", "gid", "mode"]) assert.equal(stat[field], expected[field], field);
  assert.ok(!fs.readdirSync(root).some(name => name.startsWith(".settings-") && name.endsWith(".tmp")), "temporary files remain");
}

switch (action) {
  case "fresh":
    assert.deepEqual(readSettings(), { inferenceProvider: "claude-code" });
    checkOwnership();
    break;
  case "box-write": {
    assert.equal(process.getuid(), boxUid);
    const writable = path.join(root, "seed-smoke-box-write.txt");
    fs.writeFileSync(writable, "box writable");
    assert.equal(fs.readFileSync(writable, "utf8"), "box writable");
    fs.unlinkSync(writable);
    fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
    break;
  }
  case "existing":
    fs.writeFileSync(file, JSON.stringify({ inferenceProvider: "claude-code", commandCodeModel: "existing-model", custom: { preserved: true }, version: 7 }));
    fs.chmodSync(file, 0o644);
    fs.chownSync(file, 0, 0);
    fs.chownSync(root, 0, 0);
    fs.writeFileSync(unrelatedFile, "untouched", { mode: 0o640 });
    fs.chownSync(unrelatedFile, 0, 0);
    assert.equal(fs.statSync(root).uid, 0);
    assert.equal(fs.statSync(file).uid, 0);
    break;
  case "merged":
    assert.deepEqual(readSettings(), { inferenceProvider: "command-code", commandCodeModel: "existing-model", custom: { preserved: true }, version: 7 });
    checkOwnership();
    assert.equal(fs.statSync(unrelatedFile).uid, 0);
    assert.equal(fs.statSync(unrelatedFile).gid, 0);
    assert.equal(fs.statSync(unrelatedFile).mode & 0o777, 0o640);
    assert.equal(fs.readFileSync(unrelatedFile, "utf8"), "untouched");
    snapshot();
    break;
  case "unchanged":
    checkSnapshot();
    break;
  case "model":
    assert.deepEqual(readSettings(), { inferenceProvider: "command-code", commandCodeModel: "selected-model", custom: { preserved: true }, version: 7 });
    checkOwnership();
    break;
  case "corrupt":
    assert.ok(marker, "sensitive marker required");
    fs.writeFileSync(file, `{"headers": ${marker}}`);
    snapshot();
    break;
  case "readonly":
    fs.writeFileSync(file, JSON.stringify({ inferenceProvider: "claude-code", custom: { preserved: true } }));
    checkOwnership();
    snapshot();
    break;
  default:
    throw new Error("Unknown seed smoke check");
}
