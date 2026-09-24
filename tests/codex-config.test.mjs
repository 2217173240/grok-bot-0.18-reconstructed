import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("Codex configuration distinguishes absent, invalid and unreadable files", async () => {
  const root = new URL("..", import.meta.url).pathname;
  await mkdir(join(root, ".cache"), { recursive: true });
  const dir = await mkdtemp(join(root, ".cache/codex-config-"));
  try {
    const bundle = join(dir, "config.mjs");
    await build({ entryPoints: [join(root, "source/shared/node/codex-config.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
    const { readCodexConfiguration } = await import(pathToFileURL(bundle).href);
    const env = { CODEX_HOME: dir };
    const file = join(dir, "config.toml");
    assert.deepEqual(readCodexConfiguration(env), { model: "gpt-5.4" });
    await writeFile(file, "model = 'selected-model'\nmodel_reasoning_effort = 'high'\n[profiles.other]\nmodel = 'other-model'\n");
    assert.deepEqual(readCodexConfiguration(env), { model: "selected-model", reasoningEffort: "high" });
    assert.deepEqual(readCodexConfiguration({ ...env, SAND_CODEX_MODEL: " override-model ", SAND_CODEX_REASONING_EFFORT: "low" }), { model: "override-model", reasoningEffort: "low" });
    assert.throws(() => readCodexConfiguration({ ...env, SAND_CODEX_REASONING_EFFORT: "invalid" }), /Invalid SAND_CODEX_REASONING_EFFORT/);
    for (const raw of ["model = 42", "model = ''", "model_reasoning_effort = 'invalid'"]) {
      await writeFile(file, raw);
      assert.throws(() => readCodexConfiguration(env), /Invalid .*Codex configuration/);
    }
    await writeFile(file, "model = 'private-value\n");
    assert.throws(() => readCodexConfiguration(env), error => {
      assert.match(error.message, /Invalid TOML/);
      assert.ok(error.message.includes(file));
      assert.ok(!error.message.includes("private-value"));
      assert.equal(error.cause, undefined);
      return true;
    });
    await rm(file);
    await mkdir(file);
    assert.throws(() => readCodexConfiguration(env), /Cannot read Codex configuration/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
