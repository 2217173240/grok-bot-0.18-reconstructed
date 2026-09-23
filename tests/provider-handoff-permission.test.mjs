import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

test("human handoff permits only the exact Bash handback command", async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const workspace = await mkdtemp(path.join(root, ".cache/provider-handoff-"));
  const previousAdmin = process.env.SAND_LOCAL_ADMIN;
  const previousWorkspace = process.env.SAND_WORKSPACE_ROOT;
  const previousDataRoot = process.env.SAND_DATA_ROOT;
  try {
    const outfile = path.join(workspace, "provider.mjs");
    await build({ entryPoints: [path.join(root, "source/host/extensions/inference/provider-session.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
    const { claudeToolPermission, awaitingHumanAskFilePath } = await import(pathToFileURL(outfile).href);
    process.env.SAND_LOCAL_ADMIN = "1";
    process.env.SAND_WORKSPACE_ROOT = workspace;
    process.env.SAND_DATA_ROOT = workspace;
    const askPath = path.join(workspace, ".grokbot", "ask-human.json");
    await mkdir(path.dirname(askPath), { recursive: true });
    await writeFile(askPath, "{}\n");
    assert.equal(awaitingHumanAskFilePath({ SAND_WORKSPACE_ROOT: workspace }), askPath);
    assert.equal(claudeToolPermission("Bash", { command: "rm .grokbot/ask-human.json" }, "never").behavior, "allow");
    assert.equal(claudeToolPermission("Bash", { command: `unlink ${askPath}` }, "never").behavior, "allow");
    for (const command of ["touch x; rm .grokbot/ask-human.json", "rm .grokbot/ask-human.json; touch x", "echo ask-human.json && rm x"]) {
      assert.equal(claudeToolPermission("Bash", { command }, "never").behavior, "deny", command);
    }
    assert.equal(claudeToolPermission("Write", { command: "rm .grokbot/ask-human.json" }, "never").behavior, "deny");
  } finally {
    if (previousAdmin === undefined) delete process.env.SAND_LOCAL_ADMIN;
    else process.env.SAND_LOCAL_ADMIN = previousAdmin;
    if (previousWorkspace === undefined) delete process.env.SAND_WORKSPACE_ROOT;
    else process.env.SAND_WORKSPACE_ROOT = previousWorkspace;
    if (previousDataRoot === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previousDataRoot;
    await rm(workspace, { recursive: true, force: true });
  }
});
