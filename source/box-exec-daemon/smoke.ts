import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import type { MethodInfoServerStreaming, ServiceType } from "@bufbuild/protobuf";

import { ExecService } from "../packages/proto/generated/agent/v1/exec_service_connect.js";
import { ExecStreamElement } from "../packages/proto/generated/agent/v1/exec_service_pb.js";
import { ExecServerMessage } from "../packages/proto/generated/agent/v1/exec_pb.js";
import {
  ShellArgs,
  ShellCommandParsingResult,
  ShellCommandParsingResult_ExecutableCommand
} from "../packages/proto/generated/agent/v1/shell_exec_pb.js";

// In-box daemon smoke: one real exec over the production wire.
//
// Runs INSIDE the box (docker exec — the daemon port is deliberately not
// published to the host) against 127.0.0.1:1337, using the same transport
// shape, Bearer credential, and ExecService shellArgs stream the host uses,
// so a pass covers the daemon protocol, the token, and the workspace mapping
// — not just "a shell exists in the container".
//
// Contract: diagnostics go to stderr; stdout carries the command's stdout
// EXACTLY, so callers can assert exact marker output. Exit 0 only when the
// daemon reports a zero-exit success result.
const DAEMON_SMOKE_URL = "http://127.0.0.1:1337";
const DAEMON_SMOKE_COMMAND_TIMEOUT_MS = 15_000;
const DAEMON_SMOKE_STREAM_TIMEOUT_MS = 20_000;

// The generated descriptor is a plain object literal; give the client factory
// the method-level typing it needs (the same dance generated-production.ts
// performs at the host-bundle boundary).
type ExecServiceDescriptor = ServiceType & {
  readonly methods: { readonly exec: MethodInfoServerStreaming<ExecServerMessage, ExecStreamElement> };
};
const execServiceDescriptor = ExecService as unknown as ExecServiceDescriptor;

function smokeToken(env: NodeJS.ProcessEnv): string {
  // Mirrors resolveExecDaemonAuthTokenFromEnv: SAND_BOX_EXEC_DAEMON_AUTH_TOKEN
  // wins, SAND_GATEWAY_TOKEN is the fallback, and a missing token must fail
  // instead of inventing a default credential.
  const token = env.SAND_BOX_EXEC_DAEMON_AUTH_TOKEN?.trim() || env.SAND_GATEWAY_TOKEN?.trim() || "";
  if (token.length === 0) throw new Error("no daemon token in the box environment (SAND_BOX_EXEC_DAEMON_AUTH_TOKEN / SAND_GATEWAY_TOKEN)");
  return token;
}

export async function daemonSmokeExec(command: string): Promise<string> {
  const transport = createConnectTransport({
    httpVersion: "1.1",
    baseUrl: DAEMON_SMOKE_URL,
    useBinaryFormat: true,
    interceptors: [next => async request => {
      request.header.set("Authorization", `Bearer ${smokeToken(process.env)}`);
      return await next(request);
    }],
  });
  const client = createClient(execServiceDescriptor, transport);
  const request = new ExecServerMessage({
    id: 0,
    message: {
      case: "shellArgs",
      value: new ShellArgs({
        command,
        workingDirectory: "/workspace",
        timeout: DAEMON_SMOKE_COMMAND_TIMEOUT_MS,
        skipApproval: true,
        toolCallId: "daemon-smoke",
        parsingResult: new ShellCommandParsingResult({
          parsingFailed: false,
          executableCommands: [new ShellCommandParsingResult_ExecutableCommand({ name: command, args: [], fullText: command })],
          hasRedirects: false,
          hasCommandSubstitution: false,
        }),
      }),
    },
  });
  let sawResult = false;
  for await (const element of client.exec(request, { timeoutMs: DAEMON_SMOKE_STREAM_TIMEOUT_MS, signal: AbortSignal.timeout(DAEMON_SMOKE_STREAM_TIMEOUT_MS) })) {
    if (element.element.case !== "execClientMessage") {
      if (element.element.case === "execClientControlMessage" && element.element.value.message.case === "throw") {
        const thrown = element.element.value.message.value;
        throw new Error(thrown.error);
      }
      continue;
    }
    const message = element.element.value.message;
    if (message.case !== "shellResult") continue;
    sawResult = true;
    const result = message.value.result;
    if (result.case === "success") {
      if (result.value.exitCode !== 0) throw new Error(`daemon reported success with exit code ${result.value.exitCode}`);
      return result.value.stdout;
    }
    if (result.case === "failure") throw new Error(`command failed (exit ${result.value!.exitCode}): ${result.value!.stderr || result.value!.interleavedOutput}`);
    throw new Error(`daemon shell result was ${result.case}: ${JSON.stringify(result.value?.toJson())}`);
  }
  throw new Error(sawResult ? "daemon stream closed after the shell result" : "daemon stream closed without a shell result");
}

void (async () => {
  const command = process.argv.slice(2).join(" ");
  if (command.trim().length === 0) {
    console.error("usage: daemon-smoke.cjs <command>");
    process.exit(2);
  }
  try {
    const stdout = await daemonSmokeExec(command);
    process.stdout.write(stdout);
    process.exit(0);
  } catch (error) {
    console.error(`daemon-smoke: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
})();
