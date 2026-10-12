import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
await mkdir(join(repositoryRoot, ".cache"), { recursive: true });
const root = await mkdtemp(join(repositoryRoot, ".cache/powershell-private-files-"));
const tempRoot = join(root, "temporary");
await mkdir(tempRoot);
const previousTmp = process.env.TMPDIR;
const previousTemp = process.env.TEMP;
const previousTmpWindows = process.env.TMP;
process.env.TMPDIR = tempRoot;
process.env.TEMP = tempRoot;
process.env.TMP = tempRoot;
after(async () => {
  for (const [key, value] of [["TMPDIR", previousTmp], ["TEMP", previousTemp], ["TMP", previousTmpWindows]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});
await build({
  entryPoints: {
    powershell: join(repositoryRoot, "source/packages/shell-exec/powershell.ts"),
    context: join(repositoryRoot, "source/packages/context/core.ts"),
    platform: join(repositoryRoot, "source/packages/shell-exec/platform-shell.ts"),
  },
  outdir: root, outExtension: { ".js": ".mjs" }, bundle: true,
  platform: "node", format: "esm", packages: "external", logLevel: "silent",
});
const { createPowerShellExecutionFiles, initPowerShellState } = await import(pathToFileURL(join(root, "powershell.mjs")).href);
const { createContext } = await import(pathToFileURL(join(root, "context.mjs")).href);
const { getPowerShellExecutable } = await import(pathToFileURL(join(root, "platform.mjs")).href);
let realPowerShell;
try { realPowerShell = getPowerShellExecutable(); }
catch (error) {
  if (process.platform === "win32") throw error;
}
if (realPowerShell) {
  const probe = spawnSync(realPowerShell, ["-NoProfile", "-NonInteractive", "-Command", "Write-Output 'powershell-runtime-ready'"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(probe.error, undefined);
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /powershell-runtime-ready/);
}
const realPowerShellOptions = { skip: realPowerShell ? false : "No PowerShell executable is installed", timeout: 30_000 };
const privateDirectoryMarker = "grok-private-directory:";
const reportPrivateDirectory = `Write-Output ('${privateDirectoryMarker}' + $PSScriptRoot)`;

async function assertPrivateFilesRemoved(stdout) {
  assert.deepEqual((await readdir(tempRoot)).filter(name => name.startsWith("grok-powershell-")), []);
  if (stdout !== undefined) {
    const line = stdout.split(/\r?\n/).find(value => value.startsWith(privateDirectoryMarker));
    assert.ok(line, "the executed script must report its private directory");
    const directory = line.slice(privateDirectoryMarker.length);
    assert.equal(dirname(directory), tempRoot);
    for (const path of [directory, join(directory, "script.ps1"), join(directory, "state.txt")]) {
      await assert.rejects(stat(path), { code: "ENOENT" });
    }
  }
}

async function collectExecution(state, command, options, onEvent = () => {}) {
  const events = [];
  for await (const event of state.execute(createContext(), command, options)) {
    events.push(event);
    await onEvent(event);
  }
  return {
    events,
    stdout: events.filter(event => event.type === "stdout").map(event => event.data.toString()).join(""),
    stderr: events.filter(event => event.type === "stderr").map(event => event.data.toString()).join(""),
  };
}

test("PowerShell files use isolated private directories and preserve UTF-8 BOM", async () => {
  const first = await createPowerShellExecutionFiles();
  const second = await createPowerShellExecutionFiles();
  try {
    assert.notEqual(first.directory, second.directory);
    assert.equal(dirname(first.directory), tempRoot);
    assert.equal(dirname(first.scriptFile), first.directory);
    assert.equal(dirname(first.stateOutFile), first.directory);
    await first.writeScript("Write-Output '你好'\n");
    assert.deepEqual(await readFile(first.scriptFile), Buffer.from("\uFEFFWrite-Output '你好'\n"));
    if (process.platform !== "win32") {
      assert.equal((await stat(first.directory)).mode & 0o777, 0o700);
      assert.equal((await stat(first.scriptFile)).mode & 0o777, 0o600);
    }
    await writeFile(first.stateOutFile, "state snapshot");
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
  await assert.rejects(stat(first.directory), { code: "ENOENT" });
  await assert.rejects(stat(second.directory), { code: "ENOENT" });
  await first.cleanup();
});

test("script creation refuses an existing file and preserves its contents", async () => {
  const files = await createPowerShellExecutionFiles();
  try {
    await files.writeScript("original");
    await assert.rejects(files.writeScript("replacement"), { code: "EEXIST" });
    assert.equal(await readFile(files.scriptFile, "utf8"), "\uFEFForiginal");
  } finally { await files.cleanup(); }
});

test("script creation refuses a symlink without changing its target", async t => {
  const files = await createPowerShellExecutionFiles();
  const target = join(root, "symlink-target.txt");
  await writeFile(target, "unchanged");
  try {
    try { await symlink(target, files.scriptFile, "file"); }
    catch (error) {
      if (process.platform === "win32" && error.code === "EPERM") return t.skip("Windows requires symlink creation privileges");
      throw error;
    }
    await assert.rejects(files.writeScript("replacement"), { code: "EEXIST" });
    assert.equal(await readFile(target, "utf8"), "unchanged");
  } finally { await files.cleanup(); }
  assert.equal(await readFile(target, "utf8"), "unchanged");
});

test("failure to locate PowerShell cleans up prepared files", { skip: process.platform === "win32" }, async () => {
  const previousPath = process.env.PATH;
  const previousShell = process.env.SHELL;
  try {
    process.env.PATH = tempRoot;
    delete process.env.SHELL;
    const { initPowerShellState: initWithoutPath } = await import(`${pathToFileURL(join(root, "powershell.mjs")).href}?missing-shell`);
    const state = await initWithoutPath();
    await assert.rejects(async () => {
      for await (const _event of state.execute(createContext(), "Write-Output 'never started'")) {}
    }, /Neither 'pwsh'.*found in PATH/);
    await assertPrivateFilesRemoved();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
  }
});

test("real PowerShell succeeds, captures state, and removes its private directory", realPowerShellOptions, async () => {
  const state = await initPowerShellState();
  const workingDirectory = join(root, "working");
  await mkdir(workingDirectory);
  const options = { workingDirectory, sandboxPolicy: { perUser: { type: "insecure_none" } } };
  const first = await collectExecution(state, `$env:GROK_PRIVATE_FILE_TEST = 'state-persisted'; Write-Output 'normal-execution-marker'; ${reportPrivateDirectory}; $global:LASTEXITCODE = 0`, options);
  assert.match(first.stdout, /normal-execution-marker/);
  assert.ok(first.stdout.includes(tempRoot), "the executed script must reside under the private temporary root");
  assert.deepEqual(first.events.filter(event => event.type === "exit"), [{ type: "exit", code: 0, data: "", aborted: false }], first.stderr);
  assert.equal(await state.getCwd(), workingDirectory);
  await assertPrivateFilesRemoved(first.stdout);
  const second = await collectExecution(state, `Write-Output $env:GROK_PRIVATE_FILE_TEST; ${reportPrivateDirectory}; $global:LASTEXITCODE = 0`, options);
  assert.match(second.stdout, /state-persisted/);
  assert.deepEqual(second.events.filter(event => event.type === "exit"), [{ type: "exit", code: 0, data: "", aborted: false }], second.stderr);
  await assertPrivateFilesRemoved(second.stdout);
});

test("real PowerShell cancellation stops the command and removes its private directory", realPowerShellOptions, async () => {
  const state = await initPowerShellState();
  const controller = new AbortController();
  const sentinel = join(root, "cancelled-command-sentinel.txt");
  let stdout = "";
  let sawMarker = false;
  const deadline = setTimeout(() => controller.abort(), 15_000);
  try {
    const result = await collectExecution(state,
      `${reportPrivateDirectory}; [Console]::Out.WriteLine('cancellation-ready-marker'); [Console]::Out.Flush(); Start-Sleep -Seconds 30; [System.IO.File]::WriteAllText('${sentinel.replaceAll("'", "''")}', 'unexpected')`,
      { signal: controller.signal, workingDirectory: root, sandboxPolicy: { perUser: { type: "insecure_none" } } },
      event => {
        if (event.type === "stdout") {
          stdout += event.data.toString();
          if (stdout.includes("cancellation-ready-marker")) {
            sawMarker = true;
            controller.abort();
          }
        }
      });
    assert.equal(sawMarker, true, result.stderr);
    const exits = result.events.filter(event => event.type === "exit");
    assert.equal(exits.length, 1);
    assert.equal(exits[0].aborted, true);
    const started = result.events.filter(event => event.type === "stdin_ready");
    assert.equal(started.length, 1);
    assert.ok(Number.isInteger(started[0].pid) && started[0].pid > 0);
    assert.throws(() => process.kill(started[0].pid, 0), { code: "ESRCH" });
    await assertPrivateFilesRemoved(result.stdout);
    await assert.rejects(stat(sentinel), { code: "ENOENT" });
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
});
