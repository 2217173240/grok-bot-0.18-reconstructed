import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import electron from "electron";
import { connectCdp, smokeEnvironment, launchOwned } from "./windows-package-smoke.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repoRoot, "scripts/fixtures/electron-ipc-repro");
const domExpression = "({ready:document.readyState,title:document.title,text:document.body?.textContent.trim(),controls:document.querySelectorAll('button').length,preload:typeof window.desktop?.getWindowState==='function'})";

export async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Electron IPC control requires Windows x64");
  await mkdir(path.join(repoRoot, ".cache"), { recursive: true });
  const root = await mkdtemp(path.join(repoRoot, ".cache/electron-ipc-repro-"));
  const env = smokeEnvironment(root);
  for (const directory of new Set([env.HOME, env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA, env.SAND_USER_DATA_DIR])) await mkdir(directory, { recursive: true });
  console.log(`Electron IPC control artifacts: ${root}`);
  const app = await launchOwned(electron, [path.join(fixtureRoot, "main.cjs"), "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${env.SAND_USER_DATA_DIR}`], env, path.join(root, "app.log"));
  const report = { platform: process.platform, executable: electron, pid: app.child.pid, success: false };
  const errors = [];
  let stage = "renderer-startup";
  let cdp;
  try {
    const deadline = Date.now() + 60000;
    const fixtureUrl = pathToFileURL(path.join(fixtureRoot, "index.html")).href;
    let target;
    while (Date.now() < deadline && !target) {
      app.assertRunning();
      const endpoint = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(app.output())?.[1];
      if (endpoint) {
        const targets = await (await fetch(`http://${new URL(endpoint).host}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
        target = targets.find(item => item.type === "page" && item.url === fixtureUrl);
      }
      if (!target) await delay(200);
    }
    assert(target, "Electron fixture renderer did not appear");
    cdp = connectCdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.enable");
    stage = "initial-dom";
    const rendererDeadline = Date.now() + 30000;
    while (Date.now() < rendererDeadline) {
      app.assertRunning();
      const value = await cdp.send("Runtime.evaluate", { expression: domExpression, returnByValue: true });
      assert.equal(value.exceptionDetails, undefined, JSON.stringify(value.exceptionDetails));
      report.before = value.result?.value;
      if (report.before?.ready === "complete" && report.before.preload && report.before.controls === 1) break;
      await delay(100);
    }
    assert.equal(report.before?.ready, "complete");
    assert.equal(report.before?.preload, true);
    assert.equal(report.before?.controls, 1);
    stage = "window-state-ipc";
    const reply = await cdp.send("Runtime.evaluate", { expression: "window.desktop.getWindowState()", awaitPromise: true, returnByValue: true });
    assert.equal(reply.exceptionDetails, undefined, JSON.stringify(reply.exceptionDetails));
    report.ipc = reply.result?.value;
    assert.equal(report.ipc?.electron, "42.1.0");
    assert.equal(report.ipc?.platform, "win32");
    assert.equal(typeof report.ipc?.isFullscreen, "boolean");
    assert.equal(typeof report.ipc?.isMaximized, "boolean");
    stage = "following-dom";
    await delay(1000);
    app.assertRunning();
    const following = await cdp.send("Runtime.evaluate", { expression: domExpression, returnByValue: true });
    assert.equal(following.exceptionDetails, undefined, JSON.stringify(following.exceptionDetails));
    report.after = following.result?.value;
    assert.deepEqual(report.after, report.before);
    const rendererErrors = cdp.events.filter(event => event.method === "Runtime.exceptionThrown");
    assert.deepEqual(rendererErrors, [], "Fixture renderer reported an exception");
  } catch (error) {
    errors.push(error);
    report.error = error.message;
    report.failedStage = stage;
    console.error(`Electron IPC control failed at ${stage}:`, error);
  } finally {
    try { cdp?.close(); }
    catch (error) {
      errors.push(error);
      report.cdpCleanupError = error.message;
      console.error("Electron IPC control CDP cleanup failed:", error);
    }
    try {
      await app.close();
      report.exit = await app.completion;
    } catch (error) {
      errors.push(error);
      report.cleanupError = error.message;
      console.error("Electron IPC control process cleanup failed:", error);
    }
  }
  report.mainReceived = app.output().split("\n").filter(line => line.startsWith("IPC_REPRO_RECEIVED"));
  report.versions = app.output().split("\n").find(line => line.startsWith("IPC_REPRO_READY"));
  try { await writeFile(path.join(root, "cdp-events.json"), JSON.stringify(cdp?.events ?? [], null, 2)); }
  catch (error) {
    errors.push(error);
    report.eventsWriteError = error.message;
    console.error("Electron IPC control event report write failed:", error);
  }
  report.success = errors.length === 0;
  try { await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2)); }
  catch (error) {
    errors.push(error);
    report.success = false;
    console.error("Electron IPC control report write failed:", error);
  }
  console.log(JSON.stringify({ success: report.success, ipc: report.ipc, error: report.error, artifacts: root }));
  if (errors.length > 0) throw new AggregateError(errors, "Electron IPC control failed");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
