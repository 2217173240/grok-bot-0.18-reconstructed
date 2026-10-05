import assert from "node:assert/strict";
import { createClient, Code } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ExecService } from "../../source/packages/proto/generated/agent/v1/exec_service_connect.js";
import { ExecServerMessage } from "../../source/packages/proto/generated/agent/v1/exec_pb.js";
import { ReadArgs } from "../../source/packages/proto/generated/agent/v1/read_exec_pb.js";
import { ShellArgs, ShellCommandParsingResult, ShellCommandParsingResult_ExecutableCommand } from "../../source/packages/proto/generated/agent/v1/shell_exec_pb.js";

const [mode, marker, expectedArch] = process.argv.slice(2);
assert(["write", "verify"].includes(mode));
assert(/^[a-f0-9-]{36}$/.test(marker));
assert(["arm64", "x64"].includes(expectedArch));
const token = process.env.SAND_GATEWAY_TOKEN;
assert(token?.length >= 32);

function clientFor(credential) {
  return createClient(ExecService, createConnectTransport({ httpVersion: "1.1", baseUrl: "http://127.0.0.1:1337", useBinaryFormat: true, interceptors: [next => async request => { request.header.set("Authorization", `Bearer ${credential}`); return next(request); }] }));
}

async function execute(client, message, expected) {
  for await (const element of client.exec(new ExecServerMessage({ id: 1, message }), { timeoutMs: 20000, signal: AbortSignal.timeout(20000) })) {
    if (element.element.case === "execClientControlMessage" && element.element.value.message.case === "throw") throw new Error(element.element.value.message.value.error);
    if (element.element.case !== "execClientMessage" || element.element.value.message.case !== expected) continue;
    const result = element.element.value.message.value.result;
    assert.equal(result.case, "success", `RPC result: ${JSON.stringify(result.value?.toJson())}`);
    return result.value;
  }
  throw new Error(`Daemon stream omitted ${expected}`);
}

async function main() {
const readArgs = { case: "readArgs", value: new ReadArgs({ path: "/workspace/package-smoke.txt", toolCallId: "linux-package-read" }) };
await assert.rejects(execute(clientFor("invalid-package-smoke-token"), readArgs, "readResult"), error => error.code === Code.Unauthenticated);
const client = clientFor(token);
const javascript = mode === "write"
  ? `const fs=require('node:fs');fs.writeFileSync('/workspace/package-smoke.txt',${JSON.stringify(marker)});fs.writeFileSync('/home/box/sand-data/package-smoke.txt',${JSON.stringify(marker)});console.log(JSON.stringify({platform:process.platform,arch:process.arch,marker:fs.readFileSync('/home/box/sand-data/package-smoke.txt','utf8')}))`
  : `const fs=require('node:fs');console.log(JSON.stringify({platform:process.platform,arch:process.arch,marker:fs.readFileSync('/home/box/sand-data/package-smoke.txt','utf8')}))`;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const command = `node -e ${quote(javascript)}`;
const shell = await execute(client, { case: "shellArgs", value: new ShellArgs({ command, workingDirectory: "/workspace", timeout: 15000, skipApproval: true, toolCallId: "linux-package-shell", parsingResult: new ShellCommandParsingResult({ parsingFailed: false, executableCommands: [new ShellCommandParsingResult_ExecutableCommand({ name: "node", args: ["-e", javascript], fullText: command })], hasRedirects: false, hasCommandSubstitution: false }) }) }, "shellResult");
assert.equal(shell.exitCode, 0);
assert.deepEqual(JSON.parse(shell.stdout), { platform: "linux", arch: expectedArch, marker });
const read = await execute(client, readArgs, "readResult");
assert.equal(read.output.case, "content");
assert.equal(read.output.value, marker);
console.log(JSON.stringify({ mode, platform: "linux", arch: expectedArch, shell: true, read: true, daemonAuthentication: true, dataVolume: true, marker }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
