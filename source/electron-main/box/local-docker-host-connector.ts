import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SandSettingsStore } from "../../shared/node/settings/sand-settings-store.js";
import type { RecreateResult } from "./box-recreate-commands.js";
import { EnvDescriptorHostConnector, type SandRemoteHostConnector } from "./box-host-connector.js";
import type { GatewayConnection } from "./gateway-descriptor-cache.js";
import { isCommandCodeModelId } from "../../shared/inference-router.js";
import { isLocalAdminEnabled } from "../../shared/node/local-admin.js";
import { appendLocalIntercept } from "../../shared/node/local-admin-intercept.js";
import { LOCAL_MCP_SERVERS_FILENAME } from "../../shared/node/mcp/local-mcp-servers.js";
import { SAND_BOX_DATA_ROOT } from "../../host/host-paths.js";
import { stopLocalAdminHost } from "./local-admin-host.js";

export const LOCAL_DOCKER_BOX_IMAGE = "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest";
// SAND_LOCAL_ADMIN_IMAGE switches the local-admin computer to a self-built
// arm64-native image (see docker/): the host process IS the container process
// and spawns the reconstructed exec-daemon itself — no amd64 emulation and no
// image supervisor.
export const SAND_LOCAL_ADMIN_IMAGE_ENV = "SAND_LOCAL_ADMIN_IMAGE";
export const SELF_BUILT_EXEC_BOX_IMAGE = "grok-bot-exec-box:arm64";

// How the computer's image was chosen. The official image runs amd64 under
// QEMU; keeping it as the no-build default preserves out-of-the-box usability,
// but the choice must never be silent — the fallback carries a ledger record
// and a status line so a 5-16x execution penalty is a fact the user can act on.
// A present-but-stale self-built image is a separate case: it is an honest
// error, never a downgrade — an expired pin that silently fell into the
// fallback would trade an actionable failure for a silent one.
export const SELF_BUILT_DEPS_PIN_LABEL = "com.grok-bot.local-vm.deps-pin";

export interface SelfBuiltImageProbe {
  readonly present: boolean;
  /** The image's baked deps-pin label; undefined when absent or unlabelled. */
  readonly depsPin: string | undefined;
}

export type DockerImageChoice =
  | { readonly selection: "explicit"; readonly image: string }
  | { readonly selection: "self-built"; readonly image: string }
  | { readonly selection: "self-built-stale"; readonly image: string; readonly reason: "deps-pin-mismatch"; readonly expectedDepsPin: string; readonly imageDepsPin: string | undefined }
  | { readonly selection: "official-fallback"; readonly image: string; readonly reason: "self-built-image-missing" };

export function decideDockerImage(env: NodeJS.ProcessEnv, probe: SelfBuiltImageProbe, expectedDepsPin?: string): DockerImageChoice {
  const explicit = env[SAND_LOCAL_ADMIN_IMAGE_ENV]?.trim();
  if (isLocalAdminEnabled(env) && env.SAND_LOCAL_ADMIN_TURN === "host") {
    if (explicit === LOCAL_DOCKER_BOX_IMAGE) throw new Error("The official image does not support local in-box turns. Build docker/build-arm64-box.sh and select the local image.");
    if (!explicit && !probe.present) throw new Error("The sandbox image is not built locally. Run docker/build-arm64-box.sh before starting local in-box turns.");
  }
  if (explicit != null && explicit.length > 0) return { selection: "explicit", image: explicit };
  if (!probe.present) return { selection: "official-fallback", image: LOCAL_DOCKER_BOX_IMAGE, reason: "self-built-image-missing" };
  // Stale is not missing: pin mismatch selects the stale error even though a
  // QEMU-capable image exists — the caller must fail with the rebuild action.
  if (expectedDepsPin != null && probe.depsPin !== expectedDepsPin) {
    return { selection: "self-built-stale", image: SELF_BUILT_EXEC_BOX_IMAGE, reason: "deps-pin-mismatch", expectedDepsPin, imageDepsPin: probe.depsPin };
  }
  return { selection: "self-built", image: SELF_BUILT_EXEC_BOX_IMAGE };
}

// The reachability seam for the fallback honesty contract: a default-path
// fallback MUST map to an intercept record; explicit, native, and stale
// choices map to none. Undefined means "nothing to annotate", never
// "annotation optional".
export function officialImageQemuFallbackRecord(choice: DockerImageChoice): Readonly<Record<string, unknown>> | undefined {
  if (choice.selection !== "official-fallback") return undefined;
  return {
    kind: "docker",
    event: "official-image-qemu-fallback",
    image: choice.image,
    reason: choice.reason,
    hint: "build the native image with docker/build-arm64-box.sh (5-16x faster than the emulated official image)",
  };
}

async function resolveDockerImageForComputer(env: NodeJS.ProcessEnv = process.env, expectedDepsPin?: string): Promise<DockerImageChoice> {
  const inspected = await runDocker(["image", "inspect", "--format", `{{index .Config.Labels "${SELF_BUILT_DEPS_PIN_LABEL}"}}`, SELF_BUILT_EXEC_BOX_IMAGE]);
  const trimmed = inspected.output.trim();
  const probe: SelfBuiltImageProbe = inspected.ok
    ? { present: true, depsPin: trimmed.length > 0 ? trimmed : undefined }
    : { present: false, depsPin: undefined };
  return decideDockerImage(env, probe, expectedDepsPin);
}

// The app's expected deps pin, stamped at package time next to the bundle.
// The connector's compiled location varies by layout (bundled inside
// app.asar/dist/electron-main, mirrored in app.asar.unpacked, or a bare
// esbuild output during tests), so search upward for the stamp instead of
// guessing one relative depth. No stamp (dev/test bundles) means the pin
// cannot be verified — the connector then runs the present image rather than
// guessing staleness.
let expectedDepsPinRead = false;
let expectedDepsPinValue: string | undefined;
async function readExpectedDepsPin(): Promise<string | undefined> {
  if (!expectedDepsPinRead) {
    expectedDepsPinRead = true;
    let directory = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth += 1) {
      for (const candidate of [join(directory, "build-stamp.json"), join(directory, "Resources", "build-stamp.json")]) {
        try {
          const parsed = JSON.parse(await readFile(candidate, "utf8")) as { depsPin?: unknown };
          if (typeof parsed.depsPin === "string" && /^[0-9a-f]{64}$/.test(parsed.depsPin)) {
            expectedDepsPinValue = parsed.depsPin;
            return expectedDepsPinValue;
          }
        } catch {}
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return expectedDepsPinValue;
}

export function resolveLocalAdminBox(env: NodeJS.ProcessEnv, dockerAvailable: boolean): "docker" {
  const explicit = env.SAND_LOCAL_ADMIN_BOX?.trim().toLowerCase();
  if (explicit && explicit !== "docker") throw new Error(`Unsupported SAND_LOCAL_ADMIN_BOX: ${explicit}`);
  if (!dockerAvailable) throw new Error("Docker sandbox is unavailable. Start Docker or Colima before connecting.");
  return "docker";
}

export interface LocalDockerRunPlan {
  readonly image: string;
  readonly args: readonly string[];
  readonly custom: boolean;
}

export function localDockerRunPlan(options: {
  readonly image?: string;
  readonly hostMainPath: string;
  readonly boxExecDaemonDir: string;
  readonly token: string;
  readonly hostSha256: string;
  readonly boxExecDaemonSha256: string;
  readonly workspaceHostPath?: string;
  readonly dataVolume?: string;
  readonly depsPin?: string;
  readonly desktop?: boolean;
  readonly hostTurn?: boolean;
  readonly anthropicTokenPath?: string;
  readonly authMounts?: readonly string[];
  readonly inferenceCredential?: InferenceCredential;
  readonly inferenceFileDir?: string;
  /**
   * The user's plugin definitions. Bound rather than copied so the computer
   * always sees the current file: the config push compares the parsed payload,
   * and a stale copy would silently diverge from what the operator edited.
   */
  readonly mcpServersHostPath?: string;
}): LocalDockerRunPlan {
  const image = options.image ?? LOCAL_DOCKER_BOX_IMAGE;
  const custom = image !== LOCAL_DOCKER_BOX_IMAGE;
  const dataVolume = options.dataVolume ?? (custom ? "grok-bot-local-vm-data-arm64" : "grok-bot-local-vm-data");
  const hasCredential = options.inferenceCredential != null;
  // One workspace, one owner — on BOTH images: /workspace is a bind mount of
  // the Mac-side directory (Finder-visible, Archive's MAC_BOT_WORKSPACE_HOST
  // lesson), and every file-facing surface in the box is pinned to it: the
  // daemon's workspaceRoot, the Claude SDK cwd, and the upload root. The
  // fallback image converges on the same contract instead of reinstating the
  // dual track. SAND_WORKSPACE_HOST tells in-box code where the same
  // directory lives on the Mac so it can report a path the caller can open.
  if (options.workspaceHostPath == null || options.workspaceHostPath.length === 0) {
    throw new Error("The local computer requires a Mac-side workspace directory to bind-mount at /workspace.");
  }
  const common = [
    "run", "--detach", "--name", LOCAL_DOCKER_BOX_CONTAINER,
    "--label", LOCAL_DOCKER_OWNER_LABEL, "--label", `com.grok-bot.local-vm.host-sha256=${options.hostSha256}`,
    "--label", `${LOCAL_DOCKER_BOX_EXEC_DAEMON_SHA_LABEL}=${options.boxExecDaemonSha256}`,
    "--label", `com.grok-bot.local-vm.inference-credential=${hasCredential ? "1" : "0"}`,
    "--label", `com.grok-bot.local-vm.schema-version=${LOCAL_DOCKER_SCHEMA_VERSION}`,
    "--label", `${LOCAL_DOCKER_DESKTOP_LABEL}=${options.desktop === true ? "1" : "0"}`,
    "--label", `${LOCAL_DOCKER_HOST_TURN_LABEL}=${options.hostTurn === true ? "1" : "0"}`,
    "--label", `${SELF_BUILT_DEPS_PIN_LABEL}=${options.depsPin ?? "unknown"}`,
    // Memory cap: ~200MB base + ~800MB per Chromium, inside a 6GiB Colima VM
    // — the desktop plane gets headroom for several browsers, the exec plane
    // stays lean. The cap keeps a runaway browser from starving the host.
    "--memory", options.desktop === true ? "4g" : "2g",
    "--restart", "unless-stopped",
    "--env", "SAND_GATEWAY_BIND_HOST=0.0.0.0", "--env", "SAND_HOST_PORT=1340", "--env", `SAND_GATEWAY_TOKEN=${options.token}`, "--env", "SAND_GATEWAY_REQUIRE_AUTH=1",
    "--env", "SAND_WORKSPACE_ROOT=/workspace", "--env", "SAND_AGENT_WORKSPACE=/workspace", "--env", `SAND_WORKSPACE_HOST=${options.workspaceHostPath}`,
    // Awaiting-human deadline override (tests/gates drive a short one);
    // unset keeps the 15-minute default.
    ...(process.env.SAND_AWAITING_HUMAN_TIMEOUT_MS == null ? [] : ["--env", `SAND_AWAITING_HUMAN_TIMEOUT_MS=${process.env.SAND_AWAITING_HUMAN_TIMEOUT_MS}`]),
    // Browser egress proxy (Archive's MAC_BOT_PROXY semantics): an HTTP proxy
    // port fixes DNS poisoning (CONNECT resolves at the far end); Chromium
    // bypasses loopback by default, so the CDP/noVNC surfaces stay local.
    ...(process.env.SAND_BOT_PROXY == null || process.env.SAND_BOT_PROXY.trim() === "" ? [] : ["--env", `MAC_BOT_PROXY=${process.env.SAND_BOT_PROXY.trim()}`]),
    // Gate pins: the transcript journal carries a stock first-checkpoint
    // defect (no recover seeding) that hard-fails every fresh conversation
    // at settle — pinned off; audit/review/network are backend-facing and
    // blocked here. NOT pinned: notify_bus and send_message_delivery_owed
    // carry the UI's live event flow (pinning them blinded the renderer —
    // caught live).
    "--env", "SAND_FEATURE_GATE_OVERRIDES=sand_new_transcript_journal=0,sand_action_audit_logs=0,sand_auto_review=0,sand_agent_network=0",
    // Host-turn plane (turns execute inside the box): the SDK-vendored CLI
    // plus the inference endpoint ride in as env; the token arrives as a
    // read-only file mount at the path claudeChildEnv resolves.
    "--env", "SAND_LOCAL_ADMIN=1",
    "--env", "SAND_HOST_IN_BOX=1",
    ...(options.hostTurn !== true ? [] : [
      "--env", "CLAUDE_CODE_PATH=/home/box/deps/node_modules/@anthropic-ai/claude-agent-sdk/cli.js",
      ...(process.env.ANTHROPIC_BASE_URL == null ? [] : ["--env", `ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL}`]),
      ...(process.env.SAND_CLAUDE_MODEL == null ? [] : ["--env", `SAND_CLAUDE_MODEL=${process.env.SAND_CLAUDE_MODEL}`]),
      ...(options.anthropicTokenPath == null ? [] : ["--mount", `type=bind,src=${options.anthropicTokenPath},dst=/home/box/sand-data/anthropic-token,readonly`]),
    ]),
    ...(hasCredential ? ["--env", "SAND_DEV_INFERENCE_TOKEN_FILE=/run/grok-bot/inference.json", "--env", `SAND_BACKEND_URL=${options.inferenceCredential!.backendUrl}`] : []),
    "--publish", "127.0.0.1:1340:1340",
    "--mount", `type=bind,src=${options.workspaceHostPath},dst=/workspace`,
    "--volume", `${dataVolume}:/home/box/sand-data`,
    ...(options.mcpServersHostPath == null ? [] : ["--mount", `type=bind,src=${options.mcpServersHostPath},dst=${SAND_BOX_DATA_ROOT}/${LOCAL_MCP_SERVERS_FILENAME},readonly`]),
    "--mount", `type=bind,src=${options.hostMainPath},dst=/home/box/sand-host,readonly`,
    "--mount", `type=bind,src=${options.boxExecDaemonDir},dst=/home/box/box-exec-daemon,readonly`,
    ...(options.inferenceFileDir == null ? [] : ["--mount", `type=bind,src=${options.inferenceFileDir},dst=/run/grok-bot,readonly`]),
    ...(options.authMounts ?? []),
  ];
  if (custom) {
    // Self-built image: native arm64, daemon spawned by the host (no
    // SAND_USE_EXISTING_BOX_EXEC_DAEMON). Desktop opt-in switches the
    // entrypoint to box-init-exec: desktop plane in the background, host as
    // the foreground via exec (B1 topology — the container lifecycle equals
    // the host lifecycle and desktop deaths surface via probes, not restarts).
    // Display env inheritance is baked into box-init-exec (DISPLAY=:1).
    const desktopEntrypoint = options.desktop === true
      ? [
          // Archive's measured trade-off: under the default docker seccomp
          // profile Chromium's own sandbox cannot start (it dies instantly,
          // leaving zombies); with seccomp relaxed the browser sandbox WORKS
          // and a hostile page never gets the whole container (which holds
          // the cookie library). Exec-plane containers keep default seccomp.
          "--security-opt", "seccomp=unconfined",
          "--entrypoint", "/usr/local/bin/box-init-exec",
          "--publish", "127.0.0.1:6080:6080", "--publish", "127.0.0.1:6081:6081",
        ]
      : ["--entrypoint", "/usr/local/bin/node"];
    return {
      image,
      custom,
      args: [...common,
        "--env", "SAND_DATA_ROOT=/home/box/sand-data",
        "--env", "NODE_PATH=/home/box/deps/node_modules", "--env", "SAND_TREE_SITTER_NODE_DEPS=/home/box/deps/node_modules",
        ...desktopEntrypoint,
        image, "/home/box/sand-host/host-main.cjs"],
    };
  }
  // Official image: amd64 via QEMU, supervisor entrypoint, pre-provisioned daemon
  // (its workspaceRoot is already /workspace, so only the agent-side pins are
  // new here; the workspace mount and the dual-track removal are shared).
  return {
    image,
    custom,
    args: [...common,
      "--platform", "linux/amd64",
      "--env", "SAND_SUPERVISOR_ENABLED=1", "--env", "SAND_BOX_AUTO_UPDATE=0", "--env", "SAND_USE_EXISTING_BOX_EXEC_DAEMON=1", "--env", "SAND_TREE_SITTER_NODE_DEPS=/home/box/deps", "--env", "NODE_PATH=/home/box/deps",
      "--publish", "127.0.0.1:1337:1337", "--publish", "127.0.0.1:1339:1339",
      "--publish", "127.0.0.1:6080:6080", "--publish", "127.0.0.1:6081:6081", "--publish", "127.0.0.1:8790:8790",
      image],
  };
}
export const LOCAL_DOCKER_BOX_CONTAINER = "grok-bot-local-vm";
export const LOCAL_DOCKER_GATEWAY_URL = "http://127.0.0.1:1340";
export const LOCAL_DOCKER_OWNER_LABEL = "com.grok-bot.local-vm=1";
// Schema 12: the staged host runtime mounts as a DIRECTORY (the host spawns
// agent-isolation and extension workers relative to argv[1] at runtime; the
// single-file mount left them missing and killed in-box turns). Drift
// replaces existing schema-11 containers.
export const LOCAL_DOCKER_SCHEMA_VERSION = "18";
export const LOCAL_DOCKER_DESKTOP_LABEL = "com.grok-bot.local-vm.desktop";
// The host-turn mount plane (token bind) only applies at docker run; the
// label lets drift replace a container whose mounts no longer match.
export const LOCAL_DOCKER_HOST_TURN_LABEL = "com.grok-bot.local-vm.host-turn";
// The executable that actually runs in-box commands is bound from a
// content-addressed directory named after BOTH the host bundle and this daemon,
// so a rebuild of the daemon alone makes the container's mount stale. The host
// hash below covers only host-main.cjs, so the daemon hash needs its own label
// and its own drift comparison.
export const LOCAL_DOCKER_BOX_EXEC_DAEMON_SHA_LABEL = "com.grok-bot.local-vm.box-exec-daemon-sha256";
export const SAND_LOCAL_ADMIN_DESKTOP_ENV = "SAND_LOCAL_ADMIN_DESKTOP";

// The desktop plane is the DEFAULT for the self-built computer (the goal is
// the complete bot; both gate profiles are green). SAND_LOCAL_ADMIN_DESKTOP=0
// opts back to the headless exec plane; the official image never gets a
// desktop (its branch does not know the contract).
export function resolveDesktopMode(env: NodeJS.ProcessEnv, customImage: boolean): boolean {
  if (env[SAND_LOCAL_ADMIN_DESKTOP_ENV]?.trim() === "0") return false;
  return customImage;
}
// v2 stages host-main.cjs under sand-host/ because the stock host resolves its
// box-exec-daemon at dirname(argv[1])/../box-exec-daemon/main.cjs — the in-box
// sibling layout. v1 (flat) directories are never reused.
export const LOCAL_HOST_RUNTIME_LAYOUT_VERSION = "3";
// A local host that exits is a deterministic failure (layout, deps, port);
// identical automatic respawns are mechanical retries. Three strikes open a
// 60s breaker; the user-driven recreate paths reset it.
const LOCAL_HOST_AUTO_FAILURE_LIMIT = 3;
const LOCAL_HOST_BREAKER_OPEN_MS = 60_000;
const READY_TIMEOUT_MS = 180_000;
const OPTIONAL_CREDENTIAL_TIMEOUT_MS = 3_000;

export interface LocalDockerStatus {
  readonly available: boolean;
  readonly running: boolean;
  readonly ready: boolean;
  readonly containerName: string;
  readonly image: string;
  readonly detail: string;
}

interface CommandResult { readonly ok: boolean; readonly output: string }
interface InferenceCredential { readonly accessToken: string; readonly backendUrl: string; readonly expiresAtMs: number }
interface LocalHostBundle { readonly path: string; readonly sha256: string; readonly boxExecDaemonPath: string; readonly boxExecDaemonSha256: string }

export const DOCKER_PROFILE_ENV = "GROKBOT_COLIMA_PROFILE";
export const DEFAULT_DOCKER_PROFILE = "grokbot";

// The Colima profile this project uses. Naming it here keeps the choice explicit
// instead of borrowing whatever profile another project happens to have left on
// the machine; an operator who keeps their runtime under a different name sets
// GROKBOT_COLIMA_PROFILE.
export function colimaProfileName(env: NodeJS.ProcessEnv = process.env): string {
  const named = env[DOCKER_PROFILE_ENV]?.trim();
  return named != null && named.length > 0 ? named : DEFAULT_DOCKER_PROFILE;
}

// 候选顺序与 scripts/lib/docker-socket.sh 一致，独立于主机上的 socket 状态。
export function dockerSocketCandidates(env: NodeJS.ProcessEnv, homeDir: string, profiles: readonly string[]): string[] {
  return [
    join(homeDir, ".colima", colimaProfileName(env), "docker.sock"),
    "/var/run/docker.sock",
    join(homeDir, ".colima", "docker.sock"),
    join(homeDir, ".colima", "default", "docker.sock"),
    ...[...profiles].sort().map((profile) => join(homeDir, ".colima", profile, "docker.sock")),
  ];
}

export function resolveDockerHost(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string | undefined {
  const configured = env.DOCKER_HOST?.trim();
  if (configured != null && configured.length > 0) return configured;
  let profiles: string[] = [];
  try {
    profiles = readdirSync(join(homeDir, ".colima"));
  } catch {}
  for (const socket of dockerSocketCandidates(env, homeDir, profiles)) {
    try {
      if (statSync(socket).isSocket()) return `unix://${socket}`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM" || code === "ELOOP") continue;
      throw error;
    }
  }
  return undefined;
}

function dockerSpawnEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const dockerHost = resolveDockerHost(env);
  return dockerHost == null || env.DOCKER_HOST?.trim() ? env : { ...env, DOCKER_HOST: dockerHost };
}

function runDocker(args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"], env: dockerSpawnEnv() });
    let output = "";
    const append = (chunk: Buffer): void => { output += chunk.toString(); if (output.length > 200_000) output = output.slice(-200_000); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => resolve({ ok: false, output: `${output}\n${error.message}`.trim() }));
    child.once("close", (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}

function credentialPath(settingsPath: string): string {
  return join(dirname(settingsPath), "local-docker-vm.json");
}

function inferenceCredentialPath(settingsPath: string): string {
  return join(dirname(settingsPath), "local-docker-credential", "inference.json");
}

async function persistInferenceCredential(settingsPath: string, credential: InferenceCredential): Promise<string> {
  const target = inferenceCredentialPath(settingsPath);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify({ accessToken: credential.accessToken, expiresAtMs: credential.expiresAtMs })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
  return target;
}

async function readOrCreateToken(settingsPath: string): Promise<string> {
  const target = credentialPath(settingsPath);
  try {
    const parsed = JSON.parse(await readFile(target, "utf8")) as { token?: unknown };
    if (typeof parsed.token === "string" && parsed.token.length >= 32) return parsed.token;
  } catch {}
  const token = randomBytes(32).toString("hex");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ schemaVersion: 1, token }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600);
  return token;
}

async function gatewayReady(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${LOCAL_DOCKER_GATEWAY_URL}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch { return false; }
}

export interface LocalDockerDesktopProcesses {
  readonly router: number;
  readonly sessionSync: number;
}

export function parseLocalDockerDesktopProcessCounts(output: string): LocalDockerDesktopProcesses {
  const counts = /^(\d+)\n(\d+)$/.exec(output);
  if (counts == null) throw new Error(`Could not inspect local Docker desktop processes: ${output || "empty process counts"}`);
  return { router: Number(counts[1]), sessionSync: Number(counts[2]) };
}

// pgrep 的表达式包含方括号，避免把执行探测的 shell 自身计入进程。
// 两个计数必须来自同一次成功的 docker exec；探测失败不能解释成进程退出。
export async function probeLocalDockerDesktopProcesses(containerName: string): Promise<LocalDockerDesktopProcesses> {
  const result = await runDocker(["exec", containerName, "sh", "-c", 'pgrep -fc "[s]and-window-router.mjs"; pgrep -fc "[s]ession-sync.mjs"; true']);
  if (!result.ok) throw new Error(`Could not inspect local Docker desktop processes: ${result.output || "docker exec failed"}`);
  return parseLocalDockerDesktopProcessCounts(result.output);
}

export function desktopProcessRebuildReason(processes: LocalDockerDesktopProcesses): string | undefined {
  if (processes.router === 1 && processes.sessionSync === 1) return undefined;
  return `Local Docker VM desktop processes are unhealthy (router: ${processes.router}, session-sync: ${processes.sessionSync}). Use Reset Grok Bot's Computer to rebuild the container with one owner of each process.`;
}

async function inspectContainer(): Promise<{ exists: boolean; running: boolean; owned: boolean; image: string; hostSha256: string; boxExecDaemonSha256: string; hasInferenceCredential: boolean; schemaVersion: string; depsPin: string; desktop: boolean; hostTurn: boolean }> {
  const result = await runDocker(["inspect", "--format", "{{json .}}", LOCAL_DOCKER_BOX_CONTAINER]);
  if (!result.ok) return { exists: false, running: false, owned: false, image: "", hostSha256: "", boxExecDaemonSha256: "", hasInferenceCredential: false, schemaVersion: "", depsPin: "", desktop: false, hostTurn: false };
  try {
    const value = JSON.parse(result.output) as { State?: { Running?: unknown }; Config?: { Image?: unknown; Labels?: Record<string, unknown> } };
    return {
      exists: true,
      running: value.State?.Running === true,
      owned: value.Config?.Labels?.["com.grok-bot.local-vm"] === "1",
      image: typeof value.Config?.Image === "string" ? value.Config.Image : "",
      hostSha256: typeof value.Config?.Labels?.["com.grok-bot.local-vm.host-sha256"] === "string" ? value.Config.Labels["com.grok-bot.local-vm.host-sha256"] as string : "",
      boxExecDaemonSha256: typeof value.Config?.Labels?.[LOCAL_DOCKER_BOX_EXEC_DAEMON_SHA_LABEL] === "string" ? value.Config.Labels[LOCAL_DOCKER_BOX_EXEC_DAEMON_SHA_LABEL] as string : "",
      hasInferenceCredential: value.Config?.Labels?.["com.grok-bot.local-vm.inference-credential"] === "1",
      schemaVersion: typeof value.Config?.Labels?.["com.grok-bot.local-vm.schema-version"] === "string" ? value.Config.Labels["com.grok-bot.local-vm.schema-version"] as string : "",
      depsPin: typeof value.Config?.Labels?.[SELF_BUILT_DEPS_PIN_LABEL] === "string" ? value.Config.Labels[SELF_BUILT_DEPS_PIN_LABEL] as string : "",
      desktop: value.Config?.Labels?.[LOCAL_DOCKER_DESKTOP_LABEL] === "1",
      hostTurn: value.Config?.Labels?.[LOCAL_DOCKER_HOST_TURN_LABEL] === "1",
    };
  } catch { throw new Error("Docker returned malformed container inspection data."); }
}

export async function getLocalDockerStatus(settingsPath: string): Promise<LocalDockerStatus> {
  const daemon = await runDocker(["info", "--format", "{{.ServerVersion}}"]).catch(() => ({ ok: false, output: "Docker is not installed." }));
  if (!daemon.ok) return { available: false, running: false, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: LOCAL_DOCKER_BOX_IMAGE, detail: daemon.output || "Docker is not running." };
  const inspected = await inspectContainer();
  if (!inspected.exists) return { available: true, running: false, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: LOCAL_DOCKER_BOX_IMAGE, detail: "Ready to create the local VM." };
  if (!inspected.owned) return { available: true, running: inspected.running, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: inspected.image, detail: `Container ${LOCAL_DOCKER_BOX_CONTAINER} exists but is not owned by Grok Bot.` };
  const gateway = inspected.running && await gatewayReady(await readOrCreateToken(settingsPath));
  let detail = gateway ? "Local Docker VM is ready." : inspected.running ? "Container is starting." : "Local Docker VM is stopped.";
  let desktopHealthy = true;
  if (gateway && inspected.desktop) {
    try {
      const reason = desktopProcessRebuildReason(await probeLocalDockerDesktopProcesses(LOCAL_DOCKER_BOX_CONTAINER));
      if (reason != null) { desktopHealthy = false; detail = reason; }
    } catch (error) {
      desktopHealthy = false;
      detail = error instanceof Error ? error.message : String(error);
    }
  }
  return { available: true, running: inspected.running, ready: gateway && desktopHealthy, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: inspected.image, detail };
}

let ensureInFlight: Promise<GatewayConnection> | undefined;
// Written once per process: the image choice is re-derived on every connect,
// the QEMU-fallback annotation is not — reconnects must not spam the ledger.
let officialImageFallbackAnnotated = false;

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

// Staging is content addressed, so every distinct host bundle leaves its own
// v<layout>-<hostSha>-<daemonSha> directory behind and nothing ever removed the
// older ones. Keep the newest few and drop anything older, including
// directories from earlier layout versions.
export const LOCAL_HOST_RUNTIME_RETAINED_DIRECTORIES = 3;
const LOCAL_HOST_RUNTIME_DIRECTORY_PATTERN = /^v(\d+)-[0-9a-f]{64}-[0-9a-f]{64}$/;

// Recency is not a safety argument: the running container's mount is normally
// the newest directory, but that only holds while drift detection keeps the
// container current. Reading the live mount directly makes the rule independent
// of that assumption, so a container still pointed at an older directory keeps
// it. Returns the directory the owned container currently mounts, if any.
export async function readMountedLocalHostRuntime(): Promise<string | undefined> {
  const result = await runDocker(["inspect", "--format", "{{json .}}", LOCAL_DOCKER_BOX_CONTAINER]);
  if (!result.ok) return undefined;
  try {
    const value = JSON.parse(result.output) as { Config?: { Labels?: Record<string, unknown> }; Mounts?: Array<{ Source?: unknown; Destination?: unknown }> };
    if (value.Config?.Labels?.["com.grok-bot.local-vm"] !== "1") return undefined;
    const mount = (value.Mounts ?? []).find((candidate) => candidate.Destination === "/home/box/sand-host");
    return typeof mount?.Source === "string" && mount.Source.length > 0 ? dirname(mount.Source) : undefined;
  } catch {
    return undefined;
  }
}

export async function pruneLocalHostRuntimeStaging(runtimeRoot: string, protectedPaths: readonly string[] = []): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(runtimeRoot);
  } catch {
    return [];
  }
  const protectedSet = new Set(protectedPaths);
  const staged: { path: string; modifiedAt: number }[] = [];
  for (const name of entries) {
    if (!LOCAL_HOST_RUNTIME_DIRECTORY_PATTERN.test(name)) continue;
    const path = join(runtimeRoot, name);
    if (protectedSet.has(path)) continue;
    try {
      const info = await stat(path);
      if (!info.isDirectory()) continue;
      staged.push({ path, modifiedAt: info.mtimeMs });
    } catch {}
  }
  staged.sort((left, right) => right.modifiedAt - left.modifiedAt);
  const removed: string[] = [];
  for (const candidate of staged.slice(LOCAL_HOST_RUNTIME_RETAINED_DIRECTORIES)) {
    try {
      await rm(candidate.path, { recursive: true, force: true });
      removed.push(candidate.path);
    } catch {}
  }
  return removed;
}

// Exported so the staging contract can be driven directly: the tree walk and its
// completeness check are the only guards between a short runtime tree and an
// in-box turn that dies later on a missing worker.
export async function stageCurrentHostBundle(settingsPath: string): Promise<LocalHostBundle> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  // Directories the host resolves relative to argv[1] at RUNTIME. A short tree
  // is indistinguishable from a good one once staged (the directory name is
  // derived from the entry file and the daemon alone), and the failure would
  // only appear later as MODULE_NOT_FOUND inside an in-box turn.
  const REQUIRED_HOST_TREE_DIRECTORIES = ["agent-isolation", "extensions"] as const;
  const readRuntimeTree = async (relative: string): Promise<readonly { name: string; bytes: Buffer }[]> => {
    const readDir = async (prefix: string): Promise<{ name: string; bytes: Buffer }[]> => {
      const candidates = [resolve(moduleDirectory, `../${join(relative, prefix)}`), resolve(moduleDirectory, `../../${join(relative, prefix)}`)];
      const entries: { name: string; bytes: Buffer }[] = [];
      for (const candidate of candidates) {
        // A candidate that simply is not there is not a failure, since the
        // runtime lives at different depths in a packaged app and in tests. A
        // candidate that IS there but cannot be walked is a failure: returning
        // the part collected so far would silently stage an incomplete tree.
        let items: Dirent[];
        try {
          items = await readdir(candidate, { withFileTypes: true });
        } catch (error) {
          if ((error as { code?: unknown }).code === "ENOENT") continue;
          throw new Error(`Staging the reconstructed runtime failed while reading ${candidate}: ${String((error as Error).message ?? error)}`);
        }
        for (const item of items) {
          const name = join(prefix, item.name);
          if (item.isDirectory()) entries.push(...await readDir(name));
          else if (item.isFile()) entries.push({ name, bytes: await readFile(join(candidate, item.name)) });
        }
        return entries;
      }
      return entries;
    };
    return await readDir("");
  };
  const readRuntime = async (relative: string): Promise<Buffer> => {
    const candidates = [resolve(moduleDirectory, `../${relative}`), resolve(moduleDirectory, `../../${relative}`)];
    for (const candidate of candidates) {
      try { return await readFile(candidate); } catch {}
    }
    throw new Error(`The reconstructed runtime is unavailable at ${candidates.join(" or ")}; refusing to start a stock local VM.`);
  };
  const hostBytes = await readRuntime("host/host-main.cjs");
  const boxExecDaemonBytes = await readRuntime("box-exec-daemon/main.cjs");
  const sha256 = createHash("sha256").update(hostBytes).digest("hex");
  const boxExecDaemonSha256 = createHash("sha256").update(boxExecDaemonBytes).digest("hex");
  const directory = join(dirname(settingsPath), "local-docker-runtime", `v${LOCAL_HOST_RUNTIME_LAYOUT_VERSION}-${sha256}-${boxExecDaemonSha256}`);
  // The host spawns sibling artifacts relative to argv[1] at RUNTIME
  // (agent-isolation workers, extension workers — caught live when an in-box
  // turn died on agent-store-worker.cjs). Staging must carry the whole tree,
  // not the single entry file.
  const hostTree = await readRuntimeTree("host");
  // Fail at staging time, not inside an in-box turn: the host resolves these
  // directories relative to argv[1], and the staged directory's name says
  // nothing about whether they made it in.
  const stagedNames = new Set(hostTree.map((entry) => entry.name));
  if (!stagedNames.has("host-main.cjs")) {
    throw new Error("Staging the reconstructed runtime failed: host-main.cjs is missing from the host tree.");
  }
  const missingDirectories = REQUIRED_HOST_TREE_DIRECTORIES.filter(
    (directory) => ![...stagedNames].some((name) => name.startsWith(`${directory}/`)),
  );
  if (missingDirectories.length > 0) {
    throw new Error(`Staging the reconstructed runtime failed: the host tree is missing ${missingDirectories.join(", ")}; the in-box turn would die on a missing worker.`);
  }
  const persistRuntime = async (name: string, bytes: Buffer): Promise<string> => {
    const target = join(directory, name);
    await mkdir(dirname(target), { recursive: true });
    try {
      const existing = await readFile(target);
      if (!existing.equals(bytes)) throw new Error(`Content-addressed local runtime ${target} has unexpected bytes.`);
    } catch (error) {
      if (error instanceof Error && !Reflect.has(error, "code")) throw error;
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, target);
    }
    return target;
  };
  await mkdir(directory, { recursive: true });
  const hostMainPath = await persistRuntime("sand-host/host-main.cjs", hostBytes);
  for (const sibling of hostTree) {
    if (sibling.name === "host-main.cjs") continue;
    await persistRuntime(join("sand-host", sibling.name), sibling.bytes);
  }
  // Independent of whether this app instance already had its runtime staged:
  // the pruning compares directory timestamps every time, so repeated starts
  // converge on the same set. The container's current mount is read rather than
  // assumed, so pruning cannot delete a directory a running container still
  // reads even if that directory has aged out of the retained window.
  const mountedRuntime = await readMountedLocalHostRuntime();
  await pruneLocalHostRuntimeStaging(dirname(directory), mountedRuntime == null ? [] : [mountedRuntime]);
  return {
    // The mount unit is the sand-host DIRECTORY: the host resolves worker
    // artifacts relative to argv[1] at runtime, so single-file mounts leave
    // it without agent-isolation/ and extension workers.
    path: dirname(hostMainPath),
    sha256,
    boxExecDaemonPath: await persistRuntime("box-exec-daemon/main.cjs", boxExecDaemonBytes),
    boxExecDaemonSha256,
  };
}

async function localAuthMountArguments(): Promise<string[]> {
  const mounts: string[] = [];
  for (const [source, destination] of [[join(homedir(), ".codex"), "/root/.codex"], [join(homedir(), ".claude"), "/root/.claude"]] as const) {
    if (await isDirectory(source)) mounts.push("--mount", `type=bind,src=${source},dst=${destination},readonly`);
  }
  return mounts;
}

async function ensureLocalDockerBox(settingsPath: string, inferenceCredential?: InferenceCredential): Promise<GatewayConnection> {
  const token = await readOrCreateToken(settingsPath);
  const daemon = await runDocker(["info", "--format", "{{.ServerVersion}}"]).catch(() => ({ ok: false, output: "Docker is not installed." }));
  if (!daemon.ok) throw new Error(`Local Docker VM is selected, but Docker is unavailable: ${daemon.output || "start Docker and try again"}`);
  const expectedDepsPin = await readExpectedDepsPin();
  const imageChoice = await resolveDockerImageForComputer(process.env, expectedDepsPin);
  // Stale is not missing: a present image whose dependency pin disagrees with
  // this app is refused with the rebuild action — it must never reach the
  // annotated QEMU fallback, which is reserved for a genuinely missing image.
  if (imageChoice.selection === "self-built-stale") {
    appendLocalIntercept({ kind: "docker", event: "stale-image-refused", image: imageChoice.image, expectedDepsPin: imageChoice.expectedDepsPin, imageDepsPin: imageChoice.imageDepsPin ?? "(unlabelled)" });
    throw new Error(`The self-built computer image is stale: its dependency pin ${imageChoice.imageDepsPin ?? "(unlabelled)"} does not match this app's ${imageChoice.expectedDepsPin}. Rebuild it with docker/build-arm64-box.sh; refusing to run outdated dependencies or to silently fall back to the emulated official image.`);
  }
  const image = imageChoice.image;
  if (imageChoice.selection === "explicit") {
    const present = await runDocker(["image", "inspect", "--format", "1", image]);
    if (!present.ok) throw new Error(`The local computer image ${image} is not built locally. Build it with docker/build-arm64-box.sh; refusing to silently fall back to the emulated official image.`);
  }
  const hostBundle = await stageCurrentHostBundle(settingsPath);
  const inferenceFile = inferenceCredential == null ? undefined : await persistInferenceCredential(settingsPath, inferenceCredential);
  // Desktop mode: default for the self-built image once the dual gate
  // profiles were green (S-4); SAND_LOCAL_ADMIN_DESKTOP=0 opts out.
  const desktop = resolveDesktopMode(process.env, image !== LOCAL_DOCKER_BOX_IMAGE);
  // Host-turn wiring mounts only when the turn plane actually runs in the box.
  const hostTurn = process.env.SAND_LOCAL_ADMIN_TURN === "host" && image !== LOCAL_DOCKER_BOX_IMAGE;
  const anthropicTokenPath = existsSync(join(dirname(settingsPath), "anthropic-token")) ? join(dirname(settingsPath), "anthropic-token") : undefined;
  const inspected = await inspectContainer();
  if (inspected.exists && !inspected.owned) throw new Error(`Local Docker VM cannot use ${LOCAL_DOCKER_BOX_CONTAINER}: an unowned container already has that name.`);
  if (inspected.exists && inspected.image !== image) throw new Error(`Local Docker VM container uses unexpected image ${inspected.image}. Remove it explicitly before changing images.`);
  // Annotated, not silent — but only once every refusal guard has passed: the
  // record claims the official image is about to run, and writing it before
  // the guards made the ledger narrate a fallback that never happened (seen
  // when the image tag was removed while its container kept running). One
  // record per process; reconnects must not spam the bounded ledger.
  const fallbackRecord = officialImageQemuFallbackRecord(imageChoice);
  if (fallbackRecord != null && !officialImageFallbackAnnotated) {
    officialImageFallbackAnnotated = true;
    appendLocalIntercept(fallbackRecord);
  }
  // Pin drift on an existing container means it predates the current app's
  // dependencies: replace it, the same as a schema or host-bundle change. A
  // desktop-mode mismatch replaces too — the entrypoint only applies at run.
  const pinDrifted = expectedDepsPin != null && inspected.depsPin !== expectedDepsPin;
  // The mount is the content-addressed directory v<layout>-<hostSha>-<daemonSha>,
  // so a rebuilt daemon with an unchanged host bundle is drift just as much as a
  // rebuilt host: without this the container keeps the old daemon mounted while
  // reporting itself current, and staged-runtime pruning may then delete the
  // directory it is still reading.
  const daemonDrifted = inspected.boxExecDaemonSha256 !== hostBundle.boxExecDaemonSha256;
  const drifted = inspected.exists && (inspected.schemaVersion !== LOCAL_DOCKER_SCHEMA_VERSION || inspected.hostSha256 !== hostBundle.sha256 || daemonDrifted || pinDrifted || inspected.desktop !== desktop || inspected.hostTurn !== hostTurn || (inferenceCredential != null && !inspected.hasInferenceCredential));
  if (drifted) {
    const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
    if (!removed.ok) throw new Error(`Could not replace the local VM with the current app runtime: ${removed.output}`);
  }
  const shouldReplace = drifted;
  const current = shouldReplace ? await inspectContainer() : inspected;
  if (current.exists && !current.running) {
    const started = await runDocker(["start", LOCAL_DOCKER_BOX_CONTAINER]);
    if (!started.ok) throw new Error(`Could not start the local Docker VM: ${started.output}`);
  } else if (!current.exists) {
    // The workspace bind mount must exist on the Mac before docker run: a
    // docker-created directory would be root-owned and awkward outside Docker.
    const workspaceHostPath = join(dirname(settingsPath), "box-workspace");
    await mkdir(workspaceHostPath, { recursive: true });
    // Seed the box's settings into the data volume (idempotent, only when
    // absent): without a settings file the in-box host defaults its inference
    // provider to cursor and host turns die against the blocked backend
    // (observed live). The provider mirrors the Mac's setting; the file lives
    // in the volume, so container replacement keeps it.
    const dataVolume = image !== LOCAL_DOCKER_BOX_IMAGE ? "grok-bot-local-vm-data-arm64" : "grok-bot-local-vm-data";
    let provider = "claude-code";
    let commandCodeModel: string | undefined;
    try {
      const macSettings = JSON.parse(await readFile(settingsPath, "utf8")) as { inferenceProvider?: unknown; commandCodeModel?: unknown };
      if (typeof macSettings.inferenceProvider === "string" && macSettings.inferenceProvider.length > 0) provider = macSettings.inferenceProvider;
      if (isCommandCodeModelId(macSettings.commandCodeModel)) commandCodeModel = macSettings.commandCodeModel;
    } catch {}
    // Force-merge the provider key (the host persists the file itself, and a
    // pre-existing provider-less file from an older boot would survive a
    // write-only-if-absent seed — observed live). The Mac is the source of
    // truth; the merge runs only at container creation.
    const mergeScript = `const fs=require("node:fs");const p="/data/settings.json";let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch{};s.inferenceProvider=${JSON.stringify(provider)};${commandCodeModel === undefined ? "" : `s.commandCodeModel=${JSON.stringify(commandCodeModel)};`}fs.writeFileSync(p,JSON.stringify(s,null,2)+"\n");`;
    await runDocker(["run", "--rm", "--volume", `${dataVolume}:/data`, "--entrypoint", "/usr/local/bin/node", image, "-e", mergeScript]);
    const authMounts = await localAuthMountArguments();
    // Plugin definitions are the one input the box cannot obtain for itself.
    // Binding the user's file means the computer always reads the current
    // version, and an installation that never wrote one simply has no mount.
    const mcpServersCandidate = join(dirname(settingsPath), LOCAL_MCP_SERVERS_FILENAME);
    const mcpServersHostPath = (await stat(mcpServersCandidate).catch(() => null))?.isFile() === true ? mcpServersCandidate : undefined;
    const plan = localDockerRunPlan({
      image,
      hostMainPath: hostBundle.path,
      boxExecDaemonDir: dirname(hostBundle.boxExecDaemonPath),
      token,
      hostSha256: hostBundle.sha256,
      boxExecDaemonSha256: hostBundle.boxExecDaemonSha256,
      workspaceHostPath,
      ...(desktop ? { desktop } : {}),
      ...(hostTurn ? { hostTurn } : {}),
      ...(anthropicTokenPath == null ? {} : { anthropicTokenPath }),
      ...(expectedDepsPin == null ? {} : { depsPin: expectedDepsPin }),
      authMounts,
      ...(inferenceCredential == null ? {} : { inferenceCredential }),
      ...(inferenceFile == null ? {} : { inferenceFileDir: dirname(inferenceFile) }),
      ...(mcpServersHostPath == null ? {} : { mcpServersHostPath }),
    });
    const created = await runDocker(plan.args);
    if (!created.ok) throw new Error(`Could not create the local Docker VM: ${created.output}`);
    // Dual-path report: the same directory seen from both sides, so tool
    // output that mentions /workspace is actionable on the Mac.
    if (plan.custom) appendLocalIntercept({ kind: "docker", event: "workspace-bind-mount", containerPath: "/workspace", hostPath: workspaceHostPath });
  }
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await gatewayReady(token)) {
      if (desktop) {
        const reason = desktopProcessRebuildReason(await probeLocalDockerDesktopProcesses(LOCAL_DOCKER_BOX_CONTAINER));
        if (reason != null) throw new Error(reason);
      }
      return { baseUrl: LOCAL_DOCKER_GATEWAY_URL, token };
    }
    const state = await inspectContainer();
    if (!state.running) {
      const logs = await runDocker(["logs", "--tail", "80", LOCAL_DOCKER_BOX_CONTAINER]);
      throw new Error(`Local Docker VM stopped before its gateway became ready.\n${logs.output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Local Docker VM did not expose its gateway within three minutes.");
}

export async function startLocalDockerBox(settingsPath: string): Promise<GatewayConnection> {
  return await ensureLocalDockerBox(settingsPath);
}

export interface LocalBoxStopFacts { exists: boolean; running: boolean; owned: boolean }
export interface LocalBoxStopVerdict { stopped: boolean; reason?: string }

// `docker stop` returning success proves the request was accepted, not that the
// container is down: a restart policy, a concurrent start, or a shutdown that
// has not finished all leave it holding its ports. The caller starts the Mac
// host on the same gateway port immediately afterwards, and the host branch's
// already-ready probe cannot tell the two apart, so an unverified stop returns
// the container as if it were the Mac host. Only an observed state counts as
// proof; anything unproven stops the caller.
//
// `after` carries the post-stop observation and is present only when the
// container was seen at all. Absence is not evidence of being down, because an
// unreachable docker daemon reports the same thing as a removed container.
export function judgeLocalBoxStop(
  containerName: string,
  facts: { before: LocalBoxStopFacts; stop?: { succeeded: boolean }; after?: LocalBoxStopFacts },
): LocalBoxStopVerdict {
  const { before, stop, after } = facts;
  if (!before.exists || !before.running) return { stopped: true };
  if (!before.owned) return { stopped: false, reason: `refusing to stop unowned container ${containerName}` };
  if (after != null) return after.running ? { stopped: false, reason: `${containerName} is still running after docker stop` } : { stopped: true };
  if (stop?.succeeded === true) return { stopped: true };
  return { stopped: false, reason: `docker stop failed and ${containerName} could not be observed afterwards` };
}

export async function stopLocalDockerBox(): Promise<void> {
  const before = await inspectContainer();
  let stop: { succeeded: boolean } | undefined;
  let after: LocalBoxStopFacts | undefined;
  if (before.exists && before.running && before.owned) {
    stop = { succeeded: (await runDocker(["stop", LOCAL_DOCKER_BOX_CONTAINER])).ok };
    const observed = await inspectContainer();
    after = observed.exists ? { exists: true, running: observed.running, owned: observed.owned } : undefined;
  }
  const verdict = judgeLocalBoxStop(LOCAL_DOCKER_BOX_CONTAINER, {
    before,
    ...(stop === undefined ? {} : { stop }),
    ...(after === undefined ? {} : { after }),
  });
  if (!verdict.stopped) throw new Error(`Could not stop the local Docker VM: ${verdict.reason}`);
}

export function createSettingsRoutedHostConnector(
  remote: SandRemoteHostConnector,
  settings: SandSettingsStore,
): SandRemoteHostConnector {
  if (remote instanceof EnvDescriptorHostConnector) return remote;
  let localHostConsecutiveFailures = 0;
  let localHostLastFailure = "unknown";
  let localHostBreakerOpenUntilMs = 0;
  const resetLocalHostBreaker = (): void => {
    localHostConsecutiveFailures = 0;
    localHostBreakerOpenUntilMs = 0;
  };
  // Probe with a short cache: docker reachability and self-built image
  // presence drive the default computer choice without hammering the CLI.
  const cachedProbe = <T>(ttlMs: number, run: () => Promise<T>): (() => Promise<T>) => {
    let cached: { at: number; value: T } | undefined;
    return async () => {
      if (cached != null && Date.now() - cached.at < ttlMs) return cached.value;
      const value = await run();
      cached = { at: Date.now(), value };
      return value;
    };
  };
  // Short cache for AUTOMATIC probes (hammering the CLI per task is waste);
  // user-driven recreate/forceRecreate bypass it — acting on a cached
  // "unavailable" after the user just started Colima lands on the wrong
  // computer (mac-host) while the UI says Docker.
  const probeDocker = async (): Promise<boolean> => (await runDocker(["info", "--format", "{{.ServerVersion}}"])).ok;
  const probeDockerAvailable = cachedProbe(60_000, probeDocker);
  const localConnect = (): Promise<GatewayConnection> => {
    if (ensureInFlight == null) ensureInFlight = (async () => {
      if (isLocalAdminEnabled()) {
        // 容器连接失败时保留执行边界，由用户恢复 Docker。
        if (Date.now() < localHostBreakerOpenUntilMs) {
          const message = `Local computer circuit breaker is open after ${localHostConsecutiveFailures} consecutive failures; last error: ${localHostLastFailure} Retry from the computer settings or restart the app.`;
          appendLocalIntercept({ kind: "local-computer", event: "breaker-open", remainingMs: localHostBreakerOpenUntilMs - Date.now() });
          throw new Error(message);
        }
        resolveLocalAdminBox(process.env, await probeDockerAvailable());
        try {
          stopLocalAdminHost();
          const connection = await ensureLocalDockerBox(settings.settingsPath, undefined);
          resetLocalHostBreaker();
          return connection;
        } catch (error) {
          localHostLastFailure = error instanceof Error ? error.message : String(error);
          // Deterministic configuration errors (stale pin, image mismatch,
          // missing explicit image) are not transient failures — counting
          // them toward the breaker burned 60s of "computer broken" on what
          // is a rebuild-me instruction; they surface identically every time.
          const isConfigurationError = /is stale:|unexpected image|is not built locally|unowned container/.test(localHostLastFailure);
          if (!isConfigurationError) localHostConsecutiveFailures += 1;
          if (localHostConsecutiveFailures >= LOCAL_HOST_AUTO_FAILURE_LIMIT) {
            localHostBreakerOpenUntilMs = Date.now() + LOCAL_HOST_BREAKER_OPEN_MS;
            appendLocalIntercept({ kind: "local-computer", event: "breaker-opened", failures: localHostConsecutiveFailures, openMs: LOCAL_HOST_BREAKER_OPEN_MS });
          }
          appendLocalIntercept({ kind: "docker", event: "connect-failed", error: localHostLastFailure });
          throw error;
        }
      }
      const issued = remote.issueInferenceCredential == null ? undefined : await Promise.race([
        remote.issueInferenceCredential(),
        new Promise<undefined>((resolve) => setTimeout(resolve, OPTIONAL_CREDENTIAL_TIMEOUT_MS)),
      ]);
      try {
        return await ensureLocalDockerBox(settings.settingsPath, issued);
      } catch (error) {
        appendLocalIntercept({ kind: "docker", event: "connect-failed", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    })().finally(() => { ensureInFlight = undefined; });
    return ensureInFlight;
  };
  return {
    connect: async () => (isLocalAdminEnabled() || settings.getBoxRuntime() === "local-docker") ? await localConnect() : await remote.connect(),
    ...(remote.issueLocalExecDaemonCredential == null ? {} : { issueLocalExecDaemonCredential: remote.issueLocalExecDaemonCredential.bind(remote) }),
    ...(remote.issueInferenceCredential == null ? {} : { issueInferenceCredential: remote.issueInferenceCredential.bind(remote) }),
    recreate: async (args): Promise<RecreateResult> => {
      if (isLocalAdminEnabled()) {
        resolveLocalAdminBox(process.env, await probeDocker());
        const inspected = await inspectContainer();
        if (inspected.exists && !inspected.owned) throw new Error(`Local Docker VM cannot use ${LOCAL_DOCKER_BOX_CONTAINER}: an unowned container already has that name.`);
        const restarted = await runDocker(["restart", LOCAL_DOCKER_BOX_CONTAINER]).catch(() => ({ ok: false, output: "container not created yet" }));
        if (!restarted.ok) await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]).catch(() => undefined);
        resetLocalHostBreaker();
        await localConnect();
        return { status: "started-untrackable" };
      }
      if (settings.getBoxRuntime() !== "local-docker") {
        if (remote.recreate == null) throw new Error("Remote computer recreation is unavailable.");
        return await remote.recreate(args);
      }
      // A missing container is not a restart failure — connect() creates it
      // (mirrors the local-admin branch's fallback instead of hard-failing).
      const inspected = await inspectContainer();
      if (inspected.exists && !inspected.owned) return { status: "rejected", reason: `Local Docker VM cannot use ${LOCAL_DOCKER_BOX_CONTAINER}: an unowned container already has that name.` };
      const stopped = await runDocker(["restart", LOCAL_DOCKER_BOX_CONTAINER]);
      if (!stopped.ok && !/no such container/i.test(stopped.output)) throw new Error(`Could not restart the local Docker VM: ${stopped.output}`);
      if (!stopped.ok) await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]).catch(() => undefined);
      await localConnect();
      return { status: "started-untrackable" };
    },
    forceRecreate: async (): Promise<RecreateResult> => {
      if (isLocalAdminEnabled()) {
        stopLocalAdminHost();
        resolveLocalAdminBox(process.env, await probeDocker());
        const inspected = await inspectContainer();
        if (inspected.exists && !inspected.owned) return { status: "rejected", reason: `Local Docker VM cannot use ${LOCAL_DOCKER_BOX_CONTAINER}: an unowned container already has that name.` };
        resetLocalHostBreaker();
        const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
        if (!removed.ok && !/no such container/i.test(removed.output)) return { status: "rejected", reason: removed.output };
        // Discard any in-flight ensure from a concurrent connect: it is
        // polling the world we just destroyed and would fail with a
        // misleading "stopped before ready" instead of building the new one.
        ensureInFlight = undefined;
        await localConnect();
        return { status: "started-untrackable" };
      }
      if (settings.getBoxRuntime() !== "local-docker") {
        if (remote.forceRecreate == null) return { status: "rejected", reason: "Remote computer reset is unavailable." };
        return await remote.forceRecreate();
      }
      const inspected = await inspectContainer();
      if (inspected.exists && !inspected.owned) return { status: "rejected", reason: `Local Docker VM cannot use ${LOCAL_DOCKER_BOX_CONTAINER}: an unowned container already has that name.` };
      const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
      if (!removed.ok && !/no such container/i.test(removed.output)) return { status: "rejected", reason: removed.output };
      await localConnect();
      return { status: "started-untrackable" };
    },
  };
}
