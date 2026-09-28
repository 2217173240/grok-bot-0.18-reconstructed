import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".cache"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".cache/launch-inference-"));
const output = path.join(directory, "connector.mjs");
await build({ entryPoints: [path.join(root, "source/electron-main/box/local-docker-host-connector.ts")], outfile: output, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
const { localDockerRunPlan, localDockerInferenceEnvironment, localDockerInferenceConfigHash, LOCAL_DOCKER_INFERENCE_CONFIG_LABEL } = await import(output);
after(() => rm(directory, { recursive: true, force: true }));

const inferenceEnv = {
  ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
  SAND_CLAUDE_MODEL: "glm-5.3-flash",
  ANTHROPIC_MODEL: "glm-5.3-flash",
  CLAUDE_CODE_SUBAGENT_MODEL: "glm-5.3-flash",
};
for (const family of ["FABLE", "HAIKU", "OPUS", "SONNET"]) {
  inferenceEnv[`ANTHROPIC_DEFAULT_${family}_MODEL`] = "glm-5.3-flash";
  inferenceEnv[`ANTHROPIC_DEFAULT_${family}_MODEL_NAME`] = "GLM Vision";
}
const planFor = (env, hostTurn = true) => localDockerRunPlan({
  image: "grok-bot-exec-box:arm64", hostMainPath: directory, boxExecDaemonDir: directory,
  token: "", hostSha256: "host", boxExecDaemonSha256: "daemon", workspaceHostPath: directory,
  hostTurn, inferenceEnv: env,
});
const values = (args, flag) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);

test("Docker 启动参数与配置变化检测使用相同的模型白名单", () => {
  const plan = planFor({ ...inferenceEnv, ANTHROPIC_API_KEY: "excluded", UNRELATED: "excluded" });
  const env = values(plan.args, "--env");
  for (const [name, value] of Object.entries(inferenceEnv)) assert.ok(env.includes(`${name}=${value}`));
  assert.ok(!env.some(value => value.includes("excluded")));
  const hash = localDockerInferenceConfigHash(inferenceEnv, true);
  assert.ok(values(plan.args, "--label").includes(`${LOCAL_DOCKER_INFERENCE_CONFIG_LABEL}=${hash}`));
  assert.equal(hash, localDockerInferenceConfigHash({ ...inferenceEnv, UNRELATED: "changed" }, true));
  for (const name of Object.keys(inferenceEnv)) {
    assert.notEqual(hash, localDockerInferenceConfigHash({ ...inferenceEnv, [name]: "changed" }, true));
    const removed = { ...inferenceEnv };
    delete removed[name];
    assert.notEqual(hash, localDockerInferenceConfigHash(removed, true));
  }
  assert.equal(localDockerInferenceConfigHash(inferenceEnv, false), localDockerInferenceConfigHash({}, false));
  assert.ok(!values(planFor(inferenceEnv, false).args, "--env").some(value => value.startsWith("ANTHROPIC_")));
});

test("真实 Docker 重建后模型映射与配置标识同步更新", { skip: process.env.SAND_TEST_DOCKER_IMAGE == null }, async () => {
  const run = promisify(execFile);
  const name = `grok-inference-config-${process.pid}`;
  const docker = async args => (await run("docker", args)).stdout;
  const create = async env => {
    const plan = planFor(env);
    const permitted = new Set(localDockerInferenceEnvironment(env));
    const args = plan.args.flatMap((arg, index) => arg === "--env" && permitted.has(plan.args[index + 1]) || arg === "--label" && plan.args[index + 1].startsWith(`${LOCAL_DOCKER_INFERENCE_CONFIG_LABEL}=`) ? [arg, plan.args[index + 1]] : []);
    await docker(["run", "--detach", "--name", name, ...args, "--entrypoint", "node", process.env.SAND_TEST_DOCKER_IMAGE, "-e", "setInterval(() => {}, 1000)"]);
  };
  try {
    await create(inferenceEnv);
    const inspect = async () => JSON.parse(await docker(["inspect", "--format", "{{json .Config}}", name]));
    const first = await inspect();
    assert.equal(first.Labels[LOCAL_DOCKER_INFERENCE_CONFIG_LABEL], localDockerInferenceConfigHash(inferenceEnv, true));
    for (const expected of localDockerInferenceEnvironment(inferenceEnv)) assert.ok(first.Env.includes(expected));
    const changed = { ...inferenceEnv, ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.2" };
    assert.notEqual(first.Labels[LOCAL_DOCKER_INFERENCE_CONFIG_LABEL], localDockerInferenceConfigHash(changed, true));
    await docker(["rm", "--force", name]);
    await create(changed);
    const second = await inspect();
    assert.equal(second.Labels[LOCAL_DOCKER_INFERENCE_CONFIG_LABEL], localDockerInferenceConfigHash(changed, true));
    assert.ok(second.Env.includes("ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.2"));
  } finally {
    await docker(["rm", "--force", name]);
  }
});
