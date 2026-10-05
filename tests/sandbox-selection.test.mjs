import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { resolveLocalRuntimeProfile, validateDockerImage } from "../source/shared/node/local-runtime-profile.mjs";

test("local admin requires Docker and rejects Mac host selection", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "sandbox-selection-"));
  try {
    const output = path.join(directory, "connector.mjs");
    await build({ entryPoints: [path.join(root, "source/electron-main/box/local-docker-host-connector.ts")], outfile: output, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    const { resolveLocalAdminBox } = await import(pathToFileURL(output).href);
    for (const selection of [undefined, "", "docker", " Docker "]) {
      const env = selection === undefined ? {} : { SAND_LOCAL_ADMIN_BOX: selection };
      assert.equal(resolveLocalAdminBox(env, true), "docker");
      assert.throws(() => resolveLocalAdminBox(env, false), /Docker sandbox is unavailable/);
    }
    for (const selection of ["host", "mac", "mac-host"]) {
      for (const dockerAvailable of [false, true]) {
        assert.throws(() => resolveLocalAdminBox({ SAND_LOCAL_ADMIN_BOX: selection }, dockerAvailable), /Unsupported SAND_LOCAL_ADMIN_BOX/);
      }
    }
    assert.throws(() => resolveLocalAdminBox({ SAND_LOCAL_ADMIN_BOX: "dokcer" }, true), /Unsupported/);
    const profile = resolveLocalRuntimeProfile({ dataRoot: directory, env: {} });
    assert.throws(() => validateDockerImage(profile, undefined, "a".repeat(64)), /Execution image/);
    assert.throws(() => resolveLocalRuntimeProfile({ dataRoot: directory, env: { SAND_LOCAL_ADMIN_IMAGE: "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest" } }), /local execution image/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
