import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The self-built image's dependency pin — the container twin of build-stamp:
// when the repository inputs that decide what goes INTO the image change, a
// previously built image is stale even though it is still present.
//
// ONE implementation, three consumers (package-macos.mjs stamps it into
// build-stamp.json, docker/build-arm64-box.sh bakes it as an image label,
// docker/container-gates.sh re-derives it and compares). Order is part of
// the pin; never reorder this list.
export const DEPS_PIN_FILES = [
  "package-lock.json",
  "scripts/apply-third-party-patches.mjs",
  "docker/arm64-exec-box.Dockerfile",
  "docker/bin/box-init-exec",
  "docker/bin/xtest-input-local.py",
  "docker/bin/box-navigate",
  "docker/base-image.json",
];

export async function readBaseImage(repoRoot) {
  const value = JSON.parse(await readFile(path.join(repoRoot, "docker/base-image.json"), "utf8"));
  if (typeof value.reference !== "string" || !/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(value.reference) || value.platform !== "linux/arm64") {
    throw new Error("Base image must specify a sha256 digest and linux/arm64 platform.");
  }
  if (value.sourceRepository !== "https://github.com/2217173240/grok-bot-box-image" || !/^[a-f0-9]{40}$/.test(value.sourceRevision ?? "")) {
    throw new Error("Base image must identify its source repository and full source revision.");
  }
  return value;
}

export function computeDepsPin(contents) {
  return createHash("sha256").update(contents.join("")).digest("hex");
}

export async function readDepsPin(repoRoot) {
  await readBaseImage(repoRoot);
  const contents = await Promise.all(
    DEPS_PIN_FILES.map(relative => readFile(path.join(repoRoot, relative), "utf8")),
  );
  return computeDepsPin(contents);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const base = await readBaseImage(repoRoot);
  process.stdout.write(`${process.argv.includes("--base-image") ? base.reference : process.argv.includes("--base-image-revision") ? base.sourceRevision : await readDepsPin(repoRoot)}\n`);
}
