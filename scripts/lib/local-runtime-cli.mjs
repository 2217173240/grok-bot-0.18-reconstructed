import { readFileSync } from "node:fs";
import { resolveLocalRuntimeProfile, validateDockerImage } from "../../source/shared/node/local-runtime-profile.mjs";
import { createLocalDockerClient } from "../../source/shared/node/local-docker-client.mjs";

const action = process.argv[2] ?? "env";
if (action === "env") {
  const profile = resolveLocalRuntimeProfile();
  for (const [key, value] of Object.entries(profile.docker.kind === "host" ? { DOCKER_HOST: profile.docker.value, DOCKER_CONTEXT: "" } : { DOCKER_HOST: "", DOCKER_CONTEXT: profile.docker.value ?? "" })) process.stdout.write(`${key}=${value ?? ""}\n`);
} else if (action === "check") {
  const stampPath = process.argv[3];
  if (!stampPath) throw new Error("check requires the application build-stamp.json path");
  const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
  if (typeof stamp.depsPin !== "string" || !/^[a-f0-9]{64}$/.test(stamp.depsPin)) throw new Error("Invalid application dependency pin");
  const client = createLocalDockerClient();
  const profile = await client.inspect();
  const image = await client.run(["image", "inspect", "--format", "{{json .}}", profile.container.image]);
  if (!image.ok) throw new Error(`Execution image is unavailable: ${image.output}`);
  validateDockerImage(profile, JSON.parse(image.output), stamp.depsPin);
  console.log(`runtime: ${profile.host.platform}/${profile.host.arch}, ${profile.container.platform}, image ${profile.container.image}`);
} else throw new Error(`Unknown runtime command: ${action}`);
