import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { launchEnvironment, loadSettings } from "./lib/local-launch-config.mjs";
import { inspectProcess, sameProcess, stopProcessTree } from "./windows-local-launch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function withTimeout(operation, milliseconds, message) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

function connectCdp(url) {
  const socket = new WebSocket(url, { handshakeTimeout: 10000 });
  let nextId = 0;
  const pending = new Map();
  const events = [];
  const fail = error => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); } pending.clear(); };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("CDP connection closed")));
  socket.on("message", bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.method) { events.push(message); return; }
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(JSON.stringify(message.error)));
    else call.resolve(message.result);
  });
  return {
    ready: new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }),
    events,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { fail(new Error("CDP smoke finished")); socket.terminate(); },
  };
}

function smokeEnvironment(root) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|SystemDrive|ComSpec|windir|PATH|PATHEXT|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
  return launchEnvironment(root, { ...base, ELECTRON_ENABLE_LOGGING: "1", HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"), DOCKER_HOST: `npipe:////./pipe/grokbot-package-smoke-${randomUUID()}` });
}

async function launchOwned(executable, args, env, logPath) {
  const session = randomUUID();
  const child = spawn(executable, [...args, `--grokbot-local-session=${session}`], { env, windowsHide: env.ELECTRON_RUN_AS_NODE === "1", stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  child.stdout.on("data", chunk => chunks.push(chunk));
  child.stderr.on("data", chunk => chunks.push(chunk));
  let exit;
  const completion = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => { exit = { code, signal }; resolve(exit); }); });
  // 保存拒绝处理程序，调用者随后仍从 completion 获取原始错误。
  completion.catch(() => {});
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const current = inspectProcess(child.pid);
  const state = current == null ? null : { version: 1, ...current, session };
  if (state && !sameProcess(state, current)) throw new Error("Packaged Electron process identity is invalid");
  return {
    child, completion,
    output: () => Buffer.concat(chunks).toString("utf8"),
    assertRunning() { if (exit) throw new Error(`Packaged Electron exited: ${JSON.stringify(exit)}`); },
    async close() {
      try {
        if (!exit && state) stopProcessTree(state);
        else if (!exit) child.kill();
        await withTimeout(completion, 20000, "Owned Electron process did not exit");
      } finally { await writeFile(logPath, Buffer.concat(chunks)); }
    },
  };
}

export async function main(args = process.argv.slice(2)) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows package smoke requires Windows x64");
  if (args.length !== 2 || args[0] !== "--app-path") throw new Error("Usage: node scripts/windows-package-smoke.mjs --app-path <Grok Bot.exe>");
  const executable = path.resolve(args[1]);
  assert((await stat(executable)).isFile());
  const archive = path.join(path.dirname(executable), "resources", "app.asar");
  assert((await stat(archive)).isFile());
  await mkdir(path.join(repoRoot, ".cache"), { recursive: true });
  const root = await mkdtemp(path.join(repoRoot, ".cache/windows-package-smoke-"));
  const env = smokeEnvironment(root);
  for (const directory of [env.HOME, env.APPDATA, env.LOCALAPPDATA, env.SAND_USER_DATA_DIR]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(root, "settings.json"), JSON.stringify({ ...loadSettings(root), inferenceProvider: "codex", hasSeenOnboarding: true }));
  console.log(`Windows package smoke artifacts: ${root}`);

  const nativeReport = path.join(root, "native.json");
  const native = await launchOwned(executable, [path.join(repoRoot, "scripts/fixtures/windows-package-native-smoke.cjs"), archive, nativeReport], { ...env, ELECTRON_RUN_AS_NODE: "1" }, path.join(root, "native.log"));
  try {
    const result = await withTimeout(native.completion, 60000, "Packaged native ABI smoke timed out");
    assert.equal(result.code, 0, native.output());
  } finally { await native.close(); }
  const nativeEvidence = JSON.parse(await readFile(nativeReport, "utf8"));

  const app = await launchOwned(executable, ["--inspect=0", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${env.SAND_USER_DATA_DIR}`], env, path.join(root, "app.log"));
  let cdp;
  let mainCdp;
  let observedTargets = [];
  let renderer;
  try {
    const deadline = Date.now() + 90000;
    let target;
    while (Date.now() < deadline && !target) {
      app.assertRunning();
      const mainEndpoint = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(app.output())?.[1];
      if (mainEndpoint && !mainCdp) {
        mainCdp = connectCdp(mainEndpoint);
        await mainCdp.ready;
        await mainCdp.send("Runtime.enable");
        await mainCdp.send("Debugger.enable");
      }
      const endpoint = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(app.output())?.[1];
      if (endpoint) {
        const base = `http://${new URL(endpoint).host}`;
        const targets = await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
        observedTargets = targets;
        target = targets.find(item => item.type === "page" && /app\.asar\/dist\/renderer\/index\.html/.test(item.url));
      }
      if (!target) await delay(200);
    }
    assert(target, "Packaged renderer CDP target did not appear");
    cdp = connectCdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.enable");
    await cdp.send("Debugger.enable");
    const rendererDeadline = Date.now() + 45000;
    const hasDocumentContext = () => cdp.events.some(event => event.method === "Runtime.executionContextCreated" && event.params.context.auxData?.isDefault === true);
    while (Date.now() < rendererDeadline && !hasDocumentContext()) {
      app.assertRunning();
      await delay(100);
    }
    assert(hasDocumentContext(), "Packaged renderer document context did not appear");
    console.log("Checking packaged renderer DOM and preload");
    while (Date.now() < rendererDeadline) {
      app.assertRunning();
      const value = await cdp.send("Runtime.evaluate", { expression: `({ready:document.readyState, roots:document.querySelector('#root')?.childElementCount ?? 0, textLength:document.body?.textContent.trim().length ?? 0, text:document.body?.textContent.trim().slice(0,2000), controls:document.querySelectorAll('button,input,textarea,[contenteditable]').length, platform:window.desktop?.platform, preload:typeof window.desktop?.getWindowState==='function' && typeof window.coordinatorPort==='object', url:location.href})`, returnByValue: true });
      renderer = value.result?.value;
      await writeFile(path.join(root, "renderer-state.json"), JSON.stringify(renderer ?? null, null, 2));
      if (renderer?.ready === "complete" && renderer.roots > 0 && renderer.textLength > 20 && renderer.controls > 0 && renderer.preload) break;
      await delay(200);
    }
    assert(renderer?.ready === "complete" && renderer.roots > 0 && renderer.textLength > 20 && renderer.controls > 0 && renderer.preload, `Renderer did not mount: ${JSON.stringify(renderer)}`);
    assert.equal(renderer.platform, "win32");
    console.log("Checking packaged preload window-state IPC");
    const ipc = await cdp.send("Runtime.evaluate", { expression: "window.desktop.getWindowState()", awaitPromise: true, returnByValue: true });
    assert.equal(ipc.exceptionDetails, undefined, JSON.stringify(ipc.exceptionDetails));
    assert(ipc.result?.value && typeof ipc.result.value === "object", "Preload window-state IPC did not return an object");
    await delay(1000);
    const failures = cdp.events.filter(event => event.method === "Runtime.exceptionThrown" || (event.method === "Network.loadingFailed" && !event.params.canceled && ["Script", "Document", "Stylesheet"].includes(event.params.type)) || (event.method === "Network.responseReceived" && ["Script", "Document", "Stylesheet"].includes(event.params.type) && event.params.response.status >= 400));
    assert.deepEqual(failures, [], "Renderer reported script or resource failures");
    await writeFile(path.join(root, "report.json"), JSON.stringify({ executable, native: nativeEvidence, renderer, preloadIpc: true, modelRequests: "not submitted", dockerExecution: "not exercised" }, null, 2));
    console.log(JSON.stringify({ native: nativeEvidence, renderer, preloadIpc: true, artifacts: root }));
  } finally {
    try {
    await writeFile(path.join(root, "targets.json"), JSON.stringify(observedTargets, null, 2));
    if (cdp) await writeFile(path.join(root, "cdp-events.json"), JSON.stringify(cdp.events, null, 2));
    if (mainCdp) {
      await writeFile(path.join(root, "main-events.json"), JSON.stringify(mainCdp.events, null, 2));
      const state = await mainCdp.send("Runtime.evaluate", { expression: `(() => { const electron=process.mainModule.require('electron'); return {ready:electron.app.isReady(), ipc:electron.ipcMain.eventNames().filter(x=>typeof x==='string').map(channel=>({channel,count:electron.ipcMain.listenerCount(channel)})), windows:electron.BrowserWindow.getAllWindows().map(w=>({id:w.id,url:w.webContents.getURL(),visible:w.isVisible(),loading:w.webContents.isLoading(),processId:w.webContents.getOSProcessId()})), handles:process._getActiveHandles().map(h=>h.constructor.name)}; })()`, returnByValue: true });
      await writeFile(path.join(root, "main-state.json"), JSON.stringify(state, null, 2));
      mainCdp.close();
    }
    if (cdp) {
      if (!renderer) {
        const start = cdp.events.length;
        await cdp.send("Debugger.pause");
        await delay(500);
        if (cdp.events.slice(start).some(event => event.method === "Debugger.paused")) await cdp.send("Debugger.resume");
      }
      await writeFile(path.join(root, "cdp-events.json"), JSON.stringify(cdp.events, null, 2));
    }
    } finally {
      mainCdp?.close();
      cdp?.close();
      await app.close();
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
