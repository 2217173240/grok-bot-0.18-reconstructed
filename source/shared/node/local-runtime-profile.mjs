// @ts-check
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** @typedef {import('./local-runtime-profile.d.mts').LocalRuntimeProfile} LocalRuntimeProfile */
/** @typedef {import('./local-runtime-profile.d.mts').LocalRuntimeOptions} LocalRuntimeOptions */
/** @typedef {import('./local-runtime-profile.d.mts').DockerProfile} DockerProfile */
/** @typedef {import('./local-runtime-profile.d.mts').LocalDockerPlatform} LocalDockerPlatform */
/** @typedef {{ docker?: { context?: string, host?: string, colimaProfile?: string }, image?: string }} RuntimeSettings */

/** @param {string} message @returns {never} */
function fail(message) { throw new Error(`Local runtime configuration: ${message}`); }
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** @param {unknown} value @param {string} name */
function text(value, name) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) fail(`${name} must be a non-empty single-line string`);
  return value.trim();
}
/** @param {unknown} value @param {NodeJS.Platform} platform */
function colimaProfile(value, platform) {
  if (platform !== "darwin") fail("colimaProfile requires macOS");
  const name = text(value, "colimaProfile");
  if (name === "." || name === ".." || /[\\/]/.test(name)) fail("colimaProfile must be a profile name");
  return name;
}
/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} name */
function fields(value, allowed, name) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${name} contains an unknown field`);
}

/** @param {string} dataRoot @param {NodeJS.Platform} platform @returns {RuntimeSettings} */
function readRuntime(dataRoot, platform) {
  const file = path.join(dataRoot, "runtime.json");
  let raw;
  try { raw = readFileSync(file, "utf8"); }
  catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  /** @type {unknown} */
  let value;
  try { value = JSON.parse(raw); }
  catch { fail(`runtime.json is not valid JSON: ${file}`); }
  if (!object(value) || value.version !== 1) fail("runtime.json requires an object with version=1");
  fields(value, ["version", "docker", "image"], "runtime.json");
  /** @type {RuntimeSettings} */
  const result = {};
  if (value.docker !== undefined) {
    if (!object(value.docker)) fail("runtime.json docker must be an object");
    fields(value.docker, ["context", "host", "colimaProfile"], "runtime.json docker");
    const keys = Object.keys(value.docker);
    if (keys.length !== 1) fail("runtime.json docker must select exactly one of context, host, colimaProfile");
    if (value.docker.context !== undefined) result.docker = { context: text(value.docker.context, "docker.context") };
    else if (value.docker.host !== undefined) result.docker = { host: text(value.docker.host, "docker.host") };
    else result.docker = { colimaProfile: colimaProfile(value.docker.colimaProfile, platform) };
  }
  if (value.image !== undefined) result.image = text(value.image, "image");
  return result;
}

/** @param {NodeJS.Platform} [platform] @param {string} [arch] @returns {LocalDockerPlatform} */
export function localDockerPlatform(platform = process.platform, arch = process.arch) {
  if (!(platform === "darwin" && arch === "arm64" || platform === "win32" && arch === "x64" || platform === "linux" && (arch === "arm64" || arch === "x64"))) {
    fail(`unsupported host ${platform}/${arch}`);
  }
  const suffix = arch === "arm64" ? "arm64" : "amd64";
  return { image: `grok-bot-exec-box:${suffix}`, dockerPlatform: arch === "arm64" ? "linux/arm64" : "linux/amd64", dataVolume: `grok-bot-local-vm-data-${suffix}` };
}

/** @param {LocalRuntimeOptions} [options] @returns {LocalRuntimeProfile} */
export function resolveLocalRuntimeProfile(options = {}) {
  const { env = process.env, platform = process.platform, arch = process.arch, homeDir = env.HOME ?? homedir() } = options;
  const target = localDockerPlatform(platform, arch);
  const paths = platform === "win32" ? path.win32 : path.posix;
  const dataRoot = resolveLocalDataRoot(options);
  const persisted = readRuntime(dataRoot, platform);
  /** @type {DockerProfile} */
  let docker;
  if (env.DOCKER_CONTEXT?.trim()) docker = { kind: "context", value: text(env.DOCKER_CONTEXT, "DOCKER_CONTEXT"), source: "DOCKER_CONTEXT" };
  else if (env.DOCKER_HOST?.trim()) docker = { kind: "host", value: text(env.DOCKER_HOST, "DOCKER_HOST"), source: "DOCKER_HOST" };
  else if (env.GROKBOT_COLIMA_PROFILE?.trim()) docker = { kind: "host", value: `unix://${paths.join(homeDir, ".colima", colimaProfile(env.GROKBOT_COLIMA_PROFILE, platform), "docker.sock")}`, source: "GROKBOT_COLIMA_PROFILE" };
  else if (persisted.docker?.context !== undefined) docker = { kind: "context", value: persisted.docker.context, source: "runtime.json" };
  else if (persisted.docker?.host !== undefined) docker = { kind: "host", value: persisted.docker.host, source: "runtime.json" };
  else if (persisted.docker?.colimaProfile !== undefined) docker = { kind: "host", value: `unix://${paths.join(homeDir, ".colima", persisted.docker.colimaProfile, "docker.sock")}`, source: "runtime.json" };
  else if (platform === "darwin") docker = { kind: "host", value: `unix://${paths.join(homeDir, ".colima", "grokbot", "docker.sock")}`, source: "project-colima" };
  else if (platform === "win32") docker = { kind: "context", value: undefined, source: "docker-active-context" };
  else docker = { kind: "host", value: "unix:///var/run/docker.sock", source: "linux-default" };
  const explicitImage = env.SAND_LOCAL_ADMIN_IMAGE?.trim() || env.GROKBOT_IMAGE?.trim();
  const image = explicitImage ? text(explicitImage, "image") : persisted.image ?? target.image;
  if (/\s/.test(image) || image.startsWith("-") || image === "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest") fail("image must select a local execution image");
  return Object.freeze({
    host: Object.freeze({ platform, arch }), dataRoot, docker: Object.freeze(docker),
    container: Object.freeze({ platform: target.dockerPlatform, image, dataVolume: target.dataVolume }),
    sources: Object.freeze({ dataRoot: options.dataRoot !== undefined ? "option" : env.SAND_DATA_ROOT !== undefined ? "SAND_DATA_ROOT" : env.GROKBOT_DATA_ROOT !== undefined ? "GROKBOT_DATA_ROOT" : "platform-default", image: env.SAND_LOCAL_ADMIN_IMAGE?.trim() ? "SAND_LOCAL_ADMIN_IMAGE" : env.GROKBOT_IMAGE?.trim() ? "GROKBOT_IMAGE" : persisted.image !== undefined ? "runtime.json" : "platform-default" }),
  });
}

/** @param {LocalRuntimeOptions} [options] */
export function resolveLocalDataRoot(options = {}) {
  const { env = process.env, platform = process.platform, homeDir = env.HOME ?? homedir() } = options;
  const rootInput = options.dataRoot ?? env.SAND_DATA_ROOT ?? env.GROKBOT_DATA_ROOT;
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (rootInput !== undefined) {
    if (!rootInput.trim() || /[\r\n\0]/.test(rootInput)) fail("data root must be a non-empty path");
    return paths.resolve(rootInput);
  }
  return platform === "win32" ? paths.join(text(env.LOCALAPPDATA, "LOCALAPPDATA"), "GrokBotLocal") : paths.join(homeDir, ".grokbot-local");
}

/** @param {LocalRuntimeProfile} profile @param {unknown} info */
export function validateDockerRuntime(profile, info) {
  if (!object(info)) fail("Docker info must be an object");
  if (info.OSType !== "linux") throw new Error("Local execution requires Docker Linux containers");
  const actual = typeof info.Architecture === "string" ? info.Architecture.toLowerCase() : "";
  const expected = profile.container.platform === "linux/arm64" ? ["arm64", "aarch64"] : ["amd64", "x86_64", "x64"];
  if (!expected.includes(actual)) throw new Error(`Docker architecture ${actual || "unknown"} does not match ${profile.container.platform}`);
  return true;
}

/** @param {LocalRuntimeProfile} profile @param {NodeJS.ProcessEnv} [env] @returns {NodeJS.ProcessEnv} */
export function dockerEnvironment(profile, env = process.env) {
  const result = { ...env };
  delete result.DOCKER_HOST;
  delete result.DOCKER_CONTEXT;
  if (profile.docker.kind === "host") result.DOCKER_HOST = profile.docker.value;
  else if (profile.docker.value !== undefined) result.DOCKER_CONTEXT = profile.docker.value;
  return result;
}

/** @param {LocalRuntimeProfile} profile @param {unknown} image @param {string | undefined} expectedDepsPin */
export function validateDockerImage(profile, image, expectedDepsPin) {
  if (!object(image) || `${image.Os}/${image.Architecture}` !== profile.container.platform) throw new Error(`Execution image must match ${profile.container.platform}`);
  const config = object(image.Config) ? image.Config : undefined;
  const labels = object(config?.Labels) ? config.Labels : undefined;
  const actualPin = labels?.["com.grok-bot.local-vm.deps-pin"];
  if (typeof actualPin !== "string" || !/^[a-f0-9]{64}$/.test(actualPin) || expectedDepsPin !== undefined && actualPin !== expectedDepsPin) {
    throw new Error(`Execution image dependencies do not match this app; rebuild with node docker/build-box.mjs --platform ${profile.container.platform}`);
  }
}
