// @ts-check
import { spawn } from "node:child_process";
import { dockerEnvironment, resolveLocalRuntimeProfile, validateDockerRuntime } from "./local-runtime-profile.mjs";

/** @typedef {import('./local-runtime-profile.d.mts').LocalRuntimeOptions} LocalRuntimeOptions */
/** @typedef {import('./local-runtime-profile.d.mts').LocalRuntimeProfile} LocalRuntimeProfile */
/** @typedef {import('./local-docker-client.d.mts').DockerCommandResult} DockerCommandResult */

/** @param {readonly string[]} args @param {NodeJS.ProcessEnv} env @returns {Promise<DockerCommandResult>} */
function execute(args, env) {
  return new Promise(resolve => {
    const child = spawn("docker", [...args], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
    child.stdout.on("data", (/** @type {Buffer} */ bytes) => { stdout = (stdout + bytes.toString("utf8")).slice(-200_000); });
    child.stderr.on("data", (/** @type {Buffer} */ bytes) => { stderr = (stderr + bytes.toString("utf8")).slice(-200_000); });
    child.once("error", error => {
      clearTimeout(timer);
      const code = "code" in error ? String(error.code) : "spawn-failed";
      resolve({ ok: false, output: `Could not start Docker CLI (${code})` });
    });
    child.once("close", code => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, output: timedOut ? "Docker command timed out after 30 seconds; check the selected runtime" : code === 0 ? stdout.trim() : `${stdout}\n${stderr}`.trim() });
    });
  });
}

/** @param {LocalRuntimeOptions} [options] */
export function createLocalDockerClient(options = {}) {
  const initial = resolveLocalRuntimeProfile(options);
  const baseEnv = { ...(options.env ?? process.env) };
  /** @type {Promise<{profile: LocalRuntimeProfile, env: NodeJS.ProcessEnv}> | undefined} */
  let selected;
  const connection = () => {
    selected ??= (async () => {
    let profile = initial;
    let env = dockerEnvironment(profile, baseEnv);
    // 固定当前 context 名称，运行过程中外部切换 context 不改变本次连接。
    if (profile.docker.kind === "context" && profile.docker.value === undefined) {
      const result = await execute(["context", "show"], env);
      if (!result.ok || !result.output || /[\r\n\0]/.test(result.output)) throw new Error(`Could not resolve the current Docker context: ${result.output}`);
      profile = Object.freeze({ ...profile, docker: Object.freeze({ kind: "context", value: result.output, source: profile.docker.source }) });
      env = dockerEnvironment(profile, baseEnv);
    }
    return { profile, env };
    })();
    const pending = selected;
    return pending.catch(error => { if (selected === pending) selected = undefined; throw error; });
  };
  return {
    async profile() { return (await connection()).profile; },
    /** @param {readonly string[]} args */
    async run(args) { return execute(args, (await connection()).env); },
    async inspect() {
      const { profile, env } = await connection();
      const result = await execute(["info", "--format", "{{json .}}"], env);
      if (!result.ok) throw new Error(`Selected Docker runtime is unavailable: ${result.output}`);
      /** @type {unknown} */
      let info;
      try { info = JSON.parse(result.output); }
      catch { throw new Error("Docker info returned invalid JSON"); }
      validateDockerRuntime(profile, info);
      return profile;
    },
  };
}
