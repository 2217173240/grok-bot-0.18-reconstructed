// Regression guard for the browser screenshot read-back.
//
// The box driver reports a capture, then the host downloads the PNG from the box
// and returns it to the model as imageB64. The download used to swallow every
// failure and return nothing, and the call site then reported the driver's
// summary text with no error — so "Took a screenshot" was delivered as a
// successful result while the model was blind. The driver had the same swallow
// on its own side. Both now fail loudly, and the sibling browser failures in the
// same file already behaved that way.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

// The bundler keeps bare package imports external, which is why the bundle is
// written inside the repository: Node resolves those packages from the
// repository's node_modules, and the directory matches the ignored .tmp pattern.
async function loadModule() {
  const buildRoot = await mkdtemp(path.join(repositoryRoot, ".tmp-browser-screenshot-"));
  const bundle = async (entry, name) => {
    const outfile = path.join(buildRoot, name);
    await build({
      entryPoints: [path.join(repositoryRoot, entry)],
      bundle: true,
      format: "esm",
      packages: "external",
      platform: "node",
      outfile,
      logLevel: "silent",
    });
    return await import(pathToFileURL(outfile).href);
  };
  return {
    tools: await bundle("source/host/runner/tools/sand-browser-tools.ts", "tools.mjs"),
    driver: await bundle("source/host/runner/tools/sand-browser-driver-source.ts", "driver-source.mjs"),
    buildRoot,
  };
}

function driverFor(tools, driver, downloadFile) {
  return new tools.SandBrowserDriver({
    executeShell: async () => ({
      case: "success",
      stdout: `${driver.SAND_BROWSER_RESULT_MARKER}${JSON.stringify({ ok: true, summary: "Took a screenshot", screenshot: true })}`,
      exitCode: 0,
    }),
    downloadFile,
    uploadFile: async () => {},
    getWindowIndex: async () => 0,
    getBoxId: () => "box",
    getDefaultViewId: () => "view-1",
    resourceAccessor: { get: () => undefined },
  });
}

test("a screenshot that cannot be read back is reported as a failed action", async () => {
  const { tools, driver, buildRoot } = await loadModule();
  try {
    // The driver throws, and the tool wrapper in the same file turns a throw
    // into { isError: true } — the same path the sibling browser failures use.
    const missing = driverFor(tools, driver, async () => {
      throw new Error("download from box /tmp/.sand-browser/shot-x.png failed (file missing)");
    });
    await assert.rejects(
      () => missing.run({}, { op: "screenshot", toolCallId: "call-1", args: {} }),
      (error) => {
        assert.match(error.message, /screenshot/i);
        assert.match(error.message, /file missing/);
        return true;
      },
      "a failed screenshot download must not resolve as a successful action",
    );

    const empty = driverFor(tools, driver, async () => new Uint8Array());
    await assert.rejects(
      () => empty.run({}, { op: "screenshot", toolCallId: "call-2", args: {} }),
      /came back empty/,
      "an empty payload must not resolve as a successful action",
    );

    // The healthy path still returns the image and no error.
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const healthy = driverFor(tools, driver, async () => bytes);
    const healthyOutput = await healthy.run({}, { op: "screenshot", toolCallId: "call-3", args: {} });
    assert.notEqual(healthyOutput.isError, true);
    assert.equal(healthyOutput.imageB64, Buffer.from(bytes).toString("base64"));
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
});

test("the box driver reports its own capture failure instead of swallowing it", async () => {
  const { driver, buildRoot } = await loadModule();
  try {
    const source = driver.SAND_BROWSER_DRIVER_SOURCE;
    assert.match(source, /out\.ok = false/, "a failed capture must not leave the driver result ok");
    assert.match(source, /screenshot capture failed/);
    // The version rides in the box path, so a newer driver is never confused
    // with one an earlier host process installed.
    assert.match(driver.SAND_BROWSER_DRIVER_BOX_PATH, /driver-v3\.mjs$/);
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
});
