import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 打包、镜像构建和容器检查使用相同依赖 pin。
// 基础镜像只计算所选平台的身份，其余输入按以下顺序计算。
export const DEPS_PIN_FILES = [
  "package.json",
  "package-lock.json",
  "scripts/apply-third-party-patches.mjs",
  "docker/arm64-exec-box.Dockerfile",
  "docker/bin/box-init-exec",
  "docker/bin/xtest-input-local.py",
  "docker/bin/box-navigate",
  "docker/base-image.json",
];

export async function readBaseImage(repoRoot, platform = "linux/arm64") {
  if (!["linux/arm64", "linux/amd64"].includes(platform)) throw new Error(`Unsupported image platform: ${platform}`);
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "docker/base-image.json"), "utf8"));
  if (manifest.schemaVersion !== 2) throw new Error("Base image manifest must use schemaVersion 2.");
  const value = manifest.platforms?.[platform];
  if (!value) throw new Error(`No verified base image registered for ${platform}. Build and verify that platform before registering its digest.`);
  if (typeof value.reference !== "string" || !/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(value.reference) || value.platform !== platform) {
    throw new Error(`Base image must specify a sha256 digest and ${platform} platform.`);
  }
  if (value.sourceRepository !== "https://github.com/2217173240/grok-bot-box-image" || !/^[a-f0-9]{40}$/.test(value.sourceRevision ?? "")) {
    throw new Error("Base image must identify its source repository and full source revision.");
  }
  return value;
}

export function computeDepsPin(contents) {
  return createHash("sha256").update(contents.join("")).digest("hex");
}

export async function readDepsPin(repoRoot, platform = "linux/arm64") {
  const base = await readBaseImage(repoRoot, platform);
  const contents = await Promise.all(
    DEPS_PIN_FILES.map(relative => relative === "docker/base-image.json"
      ? JSON.stringify([base.reference, base.platform, base.sourceRepository, base.sourceRevision])
      : readFile(path.join(repoRoot, relative), "utf8")),
  );
  return computeDepsPin(contents);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const platformIndex = process.argv.indexOf("--platform");
  if (platformIndex !== -1 && !process.argv[platformIndex + 1]) throw new Error("--platform requires linux/arm64 or linux/amd64");
  const platform = platformIndex === -1 ? "linux/arm64" : process.argv[platformIndex + 1];
  const base = await readBaseImage(repoRoot, platform);
  process.stdout.write(`${process.argv.includes("--base-image") ? base.reference : process.argv.includes("--base-image-revision") ? base.sourceRevision : await readDepsPin(repoRoot, platform)}\n`);
}
