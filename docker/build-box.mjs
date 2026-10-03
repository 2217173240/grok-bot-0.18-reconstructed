import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBaseImage, readDepsPin } from "../scripts/lib/deps-pin.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--platform" || !["linux/arm64", "linux/amd64"].includes(args[1])) {
  throw new Error("Usage: node docker/build-box.mjs --platform linux/arm64|linux/amd64");
}
const platform = args[1];
const base = await readBaseImage(repo, platform);
const pin = await readDepsPin(repo, platform);
function docker(args, capture = false) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
}
const [image] = JSON.parse(docker(["image", "inspect", base.reference], true));
if (!image.RepoDigests?.includes(base.reference) || `${image.Os}/${image.Architecture}` !== platform ||
    image.Config.Labels?.["org.opencontainers.image.revision"] !== base.sourceRevision ||
    image.Config.Labels?.["org.opencontainers.image.source"] !== base.sourceRepository) {
  throw new Error("Base image digest, platform, or source labels do not match docker/base-image.json");
}
const buildBase = `grok-box-base:verified-${base.reference.split("sha256:")[1].slice(0, 12)}`;
docker(["tag", image.Id, buildBase]);
await mkdir(path.join(repo, ".cache"), { recursive: true });
const context = await mkdtemp(path.join(repo, ".cache", "box-build-"));
try {
  const files = ["package.json", "package-lock.json", "scripts/apply-third-party-patches.mjs",
    "docker/bin/box-init-exec", "docker/bin/xtest-input-local.py", "docker/bin/box-navigate"];
  for (const file of files) {
    await mkdir(path.dirname(path.join(context, file)), { recursive: true });
    await cp(path.join(repo, file), path.join(context, file));
  }
  await cp(path.join(repo, "docker/arm64-exec-box.Dockerfile"), path.join(context, "Dockerfile"));
  const output = process.env.GROKBOT_BUILD_IMAGE || `grok-bot-exec-box:${platform.split("/")[1]}`;
  docker(["build", "--platform", platform, "--build-arg", `BASE_IMAGE=${buildBase}`,
    "--build-arg", `BASE_IMAGE_REF=${base.reference}`, "--label", `com.grok-bot.local-vm.deps-pin=${pin}`,
    "-t", output, context]);
  const [built] = JSON.parse(docker(["image", "inspect", output], true));
  if (`${built.Os}/${built.Architecture}` !== platform || built.Config.Labels?.["com.grok-bot.local-vm.deps-pin"] !== pin ||
      built.Config.Labels?.["org.opencontainers.image.base.name"] !== base.reference) throw new Error("Built image identity mismatch");
  docker(["run", "--rm", "--network", "none", "--entrypoint", "node", output, "-e",
    `if(process.arch!==${JSON.stringify(platform === "linux/amd64" ? "x64" : "arm64")}||process.version!=="v22.23.2")process.exit(1);require("node:sqlite");require("/home/box/deps/node_modules/tree-sitter");console.log(process.version,process.arch)`]);
  console.log(`Built ${output} (${platform}), deps-pin ${pin}`);
} finally {
  await rm(context, { recursive: true, force: true });
}
