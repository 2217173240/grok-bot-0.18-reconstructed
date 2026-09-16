import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SandSettingsStore } from "../../shared/node/settings/sand-settings-store.js";
import type { RecreateResult } from "./box-recreate-commands.js";
import type { SandRemoteHostConnector } from "./box-host-connector.js";
import type { GatewayConnection } from "./gateway-descriptor-cache.js";
import { isLocalAdminEnabled } from "../../shared/node/local-admin.js";
import { appendLocalIntercept } from "../../shared/node/local-admin-intercept.js";
import { ensureLocalAdminHost, stopLocalAdminHost } from "./local-admin-host.js";

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
export type DockerImageChoice =
  | { readonly selection: "explicit"; readonly image: string }
  | { readonly selection: "self-built"; readonly image: string }
  | { readonly selection: "official-fallback"; readonly image: string; readonly reason: "self-built-image-missing" };

export function decideDockerImage(env: NodeJS.ProcessEnv, selfBuiltImagePresent: boolean): DockerImageChoice {
  const explicit = env[SAND_LOCAL_ADMIN_IMAGE_ENV]?.trim();
  if (explicit != null && explicit.length > 0) return { selection: "explicit", image: explicit };
  return selfBuiltImagePresent
    ? { selection: "self-built", image: SELF_BUILT_EXEC_BOX_IMAGE }
    : { selection: "official-fallback", image: LOCAL_DOCKER_BOX_IMAGE, reason: "self-built-image-missing" };
}

// The reachability seam for the fallback honesty contract: a default-path
// fallback MUST map to an intercept record; explicit and native choices map to
// none. Undefined means "nothing to annotate", never "annotation optional".
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

async function resolveDockerImageForComputer(env: NodeJS.ProcessEnv = process.env): Promise<DockerImageChoice> {
  const present = await runDocker(["image", "inspect", "--format", "1", SELF_BUILT_EXEC_BOX_IMAGE]);
  return decideDockerImage(env, present.ok);
}

// Where the local-admin computer executes. Docker is the default when its
// daemon is reachable (isolation + GNU semantics + the native lab); the
// Mac-side host process is the fallback when it is not.
export function resolveLocalAdminBox(env: NodeJS.ProcessEnv, dockerAvailable: boolean): "docker" | "mac-host" {
  const explicit = env.SAND_LOCAL_ADMIN_BOX?.trim().toLowerCase();
  if (explicit === "host" || explicit === "mac" || explicit === "mac-host") return "mac-host";
  if (explicit === "docker") return "docker";
  return dockerAvailable ? "docker" : "mac-host";
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
  readonly workspaceVolume?: string;
  readonly dataVolume?: string;
  readonly authMounts?: readonly string[];
  readonly inferenceCredential?: InferenceCredential;
  readonly inferenceFileDir?: string;
}): LocalDockerRunPlan {
  const image = options.image ?? LOCAL_DOCKER_BOX_IMAGE;
  const custom = image !== LOCAL_DOCKER_BOX_IMAGE;
  // Fresh volume names for the self-built image: the official image's
  // volumes are root-owned and the box user cannot mkdir inside them.
  const workspaceVolume = options.workspaceVolume ?? (custom ? "grok-bot-local-vm-workspace-arm64" : "grok-bot-local-vm-workspace");
  const dataVolume = options.dataVolume ?? (custom ? "grok-bot-local-vm-data-arm64" : "grok-bot-local-vm-data");
  const hasCredential = options.inferenceCredential != null;
  const common = [
    "run", "--detach", "--name", LOCAL_DOCKER_BOX_CONTAINER,
    "--label", LOCAL_DOCKER_OWNER_LABEL, "--label", `com.grok-bot.local-vm.host-sha256=${options.hostSha256}`,
    "--label", `com.grok-bot.local-vm.box-exec-daemon-sha256=${options.boxExecDaemonSha256}`,
    "--label", `com.grok-bot.local-vm.inference-credential=${hasCredential ? "1" : "0"}`,
    "--label", `com.grok-bot.local-vm.schema-version=${LOCAL_DOCKER_SCHEMA_VERSION}`,
    "--restart", "unless-stopped",
    "--env", "SAND_GATEWAY_BIND_HOST=0.0.0.0", "--env", "SAND_HOST_PORT=1340", "--env", `SAND_GATEWAY_TOKEN=${options.token}`, "--env", "SAND_GATEWAY_REQUIRE_AUTH=1",
    ...(hasCredential ? ["--env", "SAND_DEV_INFERENCE_TOKEN_FILE=/run/grok-bot/inference.json", "--env", `SAND_BACKEND_URL=${options.inferenceCredential!.backendUrl}`] : []),
    "--publish", "127.0.0.1:1340:1340",
    "--volume", `${workspaceVolume}:/workspace`,
    "--volume", `${dataVolume}:/home/box/sand-data`,
    "--mount", `type=bind,src=${options.hostMainPath},dst=/home/box/sand-host/host-main.cjs,readonly`,
    "--mount", `type=bind,src=${options.boxExecDaemonDir},dst=/home/box/box-exec-daemon,readonly`,
    ...(options.inferenceFileDir == null ? [] : ["--mount", `type=bind,src=${options.inferenceFileDir},dst=/run/grok-bot,readonly`]),
    ...(options.authMounts ?? []),
  ];
  if (custom) {
    // Self-built image: native arm64, host as the container process, daemon
    // spawned by the host (no SAND_USE_EXISTING_BOX_EXEC_DAEMON). Fresh
    // volume names: the official image writes its volumes as root, and the
    // box user here cannot mkdir inside them.
    return {
      image,
      custom,
      args: [...common,
        "--env", "SAND_DATA_ROOT=/home/box/sand-data",
        "--env", "NODE_PATH=/home/box/deps/node_modules", "--env", "SAND_TREE_SITTER_NODE_DEPS=/home/box/deps/node_modules",
        "--entrypoint", "/usr/local/bin/node",
        image, "/home/box/sand-host/host-main.cjs"],
    };
  }
  // Official image: amd64 via QEMU, supervisor entrypoint, pre-provisioned daemon.
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
export const LOCAL_DOCKER_SCHEMA_VERSION = "6";
// v2 stages host-main.cjs under sand-host/ because the stock host resolves its
// box-exec-daemon at dirname(argv[1])/../box-exec-daemon/main.cjs — the in-box
// sibling layout. v1 (flat) directories are never reused.
export const LOCAL_HOST_RUNTIME_LAYOUT_VERSION = "2";
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

export function resolveDockerHost(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string | undefined {
  const configured = env.DOCKER_HOST?.trim();
  if (configured != null && configured.length > 0) return configured;
  const sockets = [
    "/var/run/docker.sock",
    join(homeDir, ".colima", "docker.sock"),
    join(homeDir, ".colima", "default", "docker.sock"),
  ];
  try {
    for (const profile of readdirSync(join(homeDir, ".colima"))) {
      sockets.push(join(homeDir, ".colima", profile, "docker.sock"));
    }
  } catch {}
  for (const socket of sockets) {
    if (existsSync(socket)) return `unix://${socket}`;
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

async function inspectContainer(): Promise<{ exists: boolean; running: boolean; owned: boolean; image: string; hostSha256: string; hasInferenceCredential: boolean; schemaVersion: string }> {
  const result = await runDocker(["inspect", "--format", "{{json .}}", LOCAL_DOCKER_BOX_CONTAINER]);
  if (!result.ok) return { exists: false, running: false, owned: false, image: "", hostSha256: "", hasInferenceCredential: false, schemaVersion: "" };
  try {
    const value = JSON.parse(result.output) as { State?: { Running?: unknown }; Config?: { Image?: unknown; Labels?: Record<string, unknown> } };
    return {
      exists: true,
      running: value.State?.Running === true,
      owned: value.Config?.Labels?.["com.grok-bot.local-vm"] === "1",
      image: typeof value.Config?.Image === "string" ? value.Config.Image : "",
      hostSha256: typeof value.Config?.Labels?.["com.grok-bot.local-vm.host-sha256"] === "string" ? value.Config.Labels["com.grok-bot.local-vm.host-sha256"] as string : "",
      hasInferenceCredential: value.Config?.Labels?.["com.grok-bot.local-vm.inference-credential"] === "1",
      schemaVersion: typeof value.Config?.Labels?.["com.grok-bot.local-vm.schema-version"] === "string" ? value.Config.Labels["com.grok-bot.local-vm.schema-version"] as string : "",
    };
  } catch { throw new Error("Docker returned malformed container inspection data."); }
}

export async function getLocalDockerStatus(settingsPath: string): Promise<LocalDockerStatus> {
  const daemon = await runDocker(["info", "--format", "{{.ServerVersion}}"]).catch(() => ({ ok: false, output: "Docker is not installed." }));
  if (!daemon.ok) return { available: false, running: false, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: LOCAL_DOCKER_BOX_IMAGE, detail: daemon.output || "Docker is not running." };
  const inspected = await inspectContainer();
  if (!inspected.exists) return { available: true, running: false, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: LOCAL_DOCKER_BOX_IMAGE, detail: "Ready to create the local VM." };
  if (!inspected.owned) return { available: true, running: inspected.running, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: inspected.image, detail: `Container ${LOCAL_DOCKER_BOX_CONTAINER} exists but is not owned by Grok Bot.` };
  const ready = inspected.running && await gatewayReady(await readOrCreateToken(settingsPath));
  return { available: true, running: inspected.running, ready, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: inspected.image, detail: ready ? "Local Docker VM is ready." : inspected.running ? "Container is starting." : "Local Docker VM is stopped." };
}

let ensureInFlight: Promise<GatewayConnection> | undefined;
// Written once per process: the image choice is re-derived on every connect,
// the QEMU-fallback annotation is not — reconnects must not spam the ledger.
let officialImageFallbackAnnotated = false;

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function stageCurrentHostBundle(settingsPath: string): Promise<LocalHostBundle> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
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
  return {
    path: await persistRuntime("sand-host/host-main.cjs", hostBytes),
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
  const imageChoice = await resolveDockerImageForComputer();
  // Annotated, not silent: the default path without the self-built image runs
  // the emulated official image. One record per process — reconnects must not
  // spam the bounded ledger with the same fact.
  const fallbackRecord = officialImageQemuFallbackRecord(imageChoice);
  if (fallbackRecord != null && !officialImageFallbackAnnotated) {
    officialImageFallbackAnnotated = true;
    appendLocalIntercept(fallbackRecord);
  }
  const image = imageChoice.image;
  if (imageChoice.selection === "explicit") {
    const present = await runDocker(["image", "inspect", "--format", "1", image]);
    if (!present.ok) throw new Error(`The local computer image ${image} is not built locally. Build it with docker/build-arm64-box.sh; refusing to silently fall back to the emulated official image.`);
  }
  const hostBundle = await stageCurrentHostBundle(settingsPath);
  const inferenceFile = inferenceCredential == null ? undefined : await persistInferenceCredential(settingsPath, inferenceCredential);
  const inspected = await inspectContainer();
  if (inspected.exists && !inspected.owned) throw new Error(`Local Docker VM cannot use ${LOCAL_DOCKER_BOX_CONTAINER}: an unowned container already has that name.`);
  if (inspected.exists && inspected.image !== image) throw new Error(`Local Docker VM container uses unexpected image ${inspected.image}. Remove it explicitly before changing images.`);
  if (inspected.exists && (inspected.schemaVersion !== LOCAL_DOCKER_SCHEMA_VERSION || inspected.hostSha256 !== hostBundle.sha256 || (inferenceCredential != null && !inspected.hasInferenceCredential))) {
    const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
    if (!removed.ok) throw new Error(`Could not replace the local VM with the current app runtime: ${removed.output}`);
  }
  const shouldReplace = inspected.exists && (inspected.schemaVersion !== LOCAL_DOCKER_SCHEMA_VERSION || inspected.hostSha256 !== hostBundle.sha256 || (inferenceCredential != null && !inspected.hasInferenceCredential));
  const current = shouldReplace ? await inspectContainer() : inspected;
  if (current.exists && !current.running) {
    const started = await runDocker(["start", LOCAL_DOCKER_BOX_CONTAINER]);
    if (!started.ok) throw new Error(`Could not start the local Docker VM: ${started.output}`);
  } else if (!current.exists) {
    const authMounts = await localAuthMountArguments();
    const plan = localDockerRunPlan({
      image,
      hostMainPath: hostBundle.path,
      boxExecDaemonDir: dirname(hostBundle.boxExecDaemonPath),
      token,
      hostSha256: hostBundle.sha256,
      boxExecDaemonSha256: hostBundle.boxExecDaemonSha256,
      authMounts,
      ...(inferenceCredential == null ? {} : { inferenceCredential }),
      ...(inferenceFile == null ? {} : { inferenceFileDir: dirname(inferenceFile) }),
    });
    const created = await runDocker(plan.args);
    if (!created.ok) throw new Error(`Could not create the local Docker VM: ${created.output}`);
  }
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await gatewayReady(token)) return { baseUrl: LOCAL_DOCKER_GATEWAY_URL, token };
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

export async function stopLocalDockerBox(): Promise<void> {
  const inspected = await inspectContainer();
  if (!inspected.exists || !inspected.running) return;
  if (!inspected.owned) throw new Error(`Refusing to stop unowned container ${LOCAL_DOCKER_BOX_CONTAINER}.`);
  const stopped = await runDocker(["stop", LOCAL_DOCKER_BOX_CONTAINER]);
  if (!stopped.ok) throw new Error(`Could not stop the local Docker VM: ${stopped.output}`);
}

export function createSettingsRoutedHostConnector(
  remote: SandRemoteHostConnector,
  settings: SandSettingsStore,
): SandRemoteHostConnector {
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
  const probeDockerAvailable = cachedProbe(60_000, async () => (await runDocker(["info", "--format", "{{.ServerVersion}}"])).ok);
  const localConnect = (): Promise<GatewayConnection> => {
    if (ensureInFlight == null) ensureInFlight = (async () => {
      if (isLocalAdminEnabled()) {
        // Docker is the default computer (isolation + GNU semantics + the
        // native lab); the Mac-side host process is the no-Docker fallback.
        // One breaker governs whichever local computer is in play.
        if (Date.now() < localHostBreakerOpenUntilMs) {
          const message = `Local computer circuit breaker is open after ${localHostConsecutiveFailures} consecutive failures; last error: ${localHostLastFailure} Retry from the computer settings or restart the app.`;
          appendLocalIntercept({ kind: "local-computer", event: "breaker-open", remainingMs: localHostBreakerOpenUntilMs - Date.now() });
          throw new Error(message);
        }
        const box = resolveLocalAdminBox(process.env, await probeDockerAvailable());
        try {
          const connection = box === "docker"
            ? await (stopLocalAdminHost(), ensureLocalDockerBox(settings.settingsPath, undefined))
            : await ensureMacHostComputer();
          resetLocalHostBreaker();
          return connection;
        } catch (error) {
          localHostLastFailure = error instanceof Error ? error.message : String(error);
          localHostConsecutiveFailures += 1;
          if (localHostConsecutiveFailures >= LOCAL_HOST_AUTO_FAILURE_LIMIT) {
            localHostBreakerOpenUntilMs = Date.now() + LOCAL_HOST_BREAKER_OPEN_MS;
            appendLocalIntercept({ kind: "local-computer", event: "breaker-opened", failures: localHostConsecutiveFailures, openMs: LOCAL_HOST_BREAKER_OPEN_MS });
          }
          appendLocalIntercept({ kind: box === "docker" ? "docker" : "local-host", event: "connect-failed", error: localHostLastFailure });
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
    async function ensureMacHostComputer(): Promise<GatewayConnection> {
      const token = await readOrCreateToken(settings.settingsPath);
      const hostBundle = await stageCurrentHostBundle(settings.settingsPath);
      return await ensureLocalAdminHost({ settingsPath: settings.settingsPath, hostMainPath: hostBundle.path, token });
    }
  };
  return {
    connect: async () => (isLocalAdminEnabled() || settings.getBoxRuntime() === "local-docker") ? await localConnect() : await remote.connect(),
    ...(remote.issueLocalExecDaemonCredential == null ? {} : { issueLocalExecDaemonCredential: remote.issueLocalExecDaemonCredential.bind(remote) }),
    ...(remote.issueInferenceCredential == null ? {} : { issueInferenceCredential: remote.issueInferenceCredential.bind(remote) }),
    recreate: async (args): Promise<RecreateResult> => {
      if (isLocalAdminEnabled()) {
        if ((await probeDockerAvailable()) && resolveLocalAdminBox(process.env, true) === "docker") {
          const restarted = await runDocker(["restart", LOCAL_DOCKER_BOX_CONTAINER]).catch(() => ({ ok: false, output: "container not created yet" }));
          if (!restarted.ok) await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]).catch(() => undefined);
          resetLocalHostBreaker();
          await localConnect();
          return { status: "started-untrackable" };
        }
        stopLocalAdminHost();
        resetLocalHostBreaker();
        await localConnect();
        return { status: "started-untrackable" };
      }
      if (settings.getBoxRuntime() !== "local-docker") {
        if (remote.recreate == null) throw new Error("Remote computer recreation is unavailable.");
        return await remote.recreate(args);
      }
      const stopped = await runDocker(["restart", LOCAL_DOCKER_BOX_CONTAINER]);
      if (!stopped.ok) throw new Error(`Could not restart the local Docker VM: ${stopped.output}`);
      await localConnect();
      return { status: "started-untrackable" };
    },
    forceRecreate: async (): Promise<RecreateResult> => {
      if (isLocalAdminEnabled()) {
        stopLocalAdminHost();
        resetLocalHostBreaker();
        if ((await probeDockerAvailable()) && resolveLocalAdminBox(process.env, true) === "docker") await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]).catch(() => undefined);
        await localConnect();
        return { status: "started-untrackable" };
      }
      if (settings.getBoxRuntime() !== "local-docker") {
        if (remote.forceRecreate == null) return { status: "rejected", reason: "Remote computer reset is unavailable." };
        return await remote.forceRecreate();
      }
      const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
      if (!removed.ok && !/no such container/i.test(removed.output)) return { status: "rejected", reason: removed.output };
      await localConnect();
      return { status: "started-untrackable" };
    },
  };
}
