import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEPS_PIN_FILES, readBaseImage, readDepsPin } from "../scripts/lib/deps-pin.mjs";

test("基础镜像身份变更使依赖 pin 变化，可变标签被拒绝", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "base-pin-"));
  try {
    for (const file of DEPS_PIN_FILES) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await cp(path.join(root, file), path.join(directory, file));
    }
    const original = await readBaseImage(directory);
    const pin = await readDepsPin(directory);
    const filename = path.join(directory, "docker/base-image.json");
    await writeFile(filename, JSON.stringify({ ...original, reference: `grok-box-base@sha256:${"a".repeat(64)}` }));
    assert.notEqual(await readDepsPin(directory), pin);
    await writeFile(filename, JSON.stringify({ ...original, reference: "grok-box-base:arm64" }));
    await assert.rejects(readDepsPin(directory), /sha256 digest/);
    await writeFile(filename, JSON.stringify({ ...original, sourceRevision: "main" }));
    await assert.rejects(readBaseImage(directory), /full source revision/);
    assert.match(await readFile(path.join(root, "docker/arm64-exec-box.Dockerfile"), "utf8"), /FROM \$\{BASE_IMAGE\}/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
