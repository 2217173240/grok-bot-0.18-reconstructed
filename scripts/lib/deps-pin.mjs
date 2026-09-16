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
];

export function computeDepsPin(contents) {
  return createHash("sha256").update(contents.join("")).digest("hex");
}

export async function readDepsPin(repoRoot) {
  const contents = await Promise.all(
    DEPS_PIN_FILES.map(relative => readFile(path.join(repoRoot, relative), "utf8")),
  );
  return computeDepsPin(contents);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  process.stdout.write(`${await readDepsPin(repoRoot)}\n`);
}
