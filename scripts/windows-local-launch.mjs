import { spawn, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync, statSync, renameSync, fsyncSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, loadSettings, launchEnvironment, validateProvider, defaultDataRoot } from './lib/local-launch-config.mjs';
import { createLocalDockerClient } from '../source/shared/node/local-docker-client.mjs';
import { dockerEnvironment, validateDockerImage } from '../source/shared/node/local-runtime-profile.mjs';

const distribution = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const containerName = 'grok-bot-local-vm';

export function resolveOptions(args, env = process.env, root = distribution) {
  const action = args[0] ?? 'start';
  if (!['start', 'stop', 'status', 'restart'].includes(action)) throw new Error('操作必须为 start、stop、status 或 restart');
  let appPath = path.win32.join(root, 'Grok Bot.exe');
  let dataRoot = env.GROKBOT_DATA_ROOT || (env.LOCALAPPDATA ? defaultDataRoot(env, 'win32') : undefined);
  let stopContainer = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--stop-container') { stopContainer = true; continue; }
    if (!['--app-path', '--data-root'].includes(arg) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('启动参数无效');
    if (arg === '--app-path') appPath = path.win32.resolve(root, args[++index]);
    else dataRoot = path.win32.resolve(args[++index]);
  }
  if (!dataRoot) throw new Error('需要 LOCALAPPDATA 或 --data-root');
  if (stopContainer && !['stop', 'restart'].includes(action)) throw new Error('--stop-container 适用于 stop 或 restart');
  return { action, appPath: path.win32.resolve(appPath), dataRoot: path.win32.resolve(dataRoot), stopContainer };
}

function powershell(script) {
  const command = `$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); ${script}`;
  return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function inspectProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('进程编号无效');
  const output = powershell(`$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { @{pid=[int]$p.ProcessId; executable=$p.ExecutablePath; commandLine=$p.CommandLine; created=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress }`);
  return output ? JSON.parse(output) : null;
}

export function sameProcess(state, current) {
  if (!/^[a-f0-9-]{36}$/.test(state.session)) return false;
  const marker = new RegExp(`(?:^|\\s)(?:"--grokbot-local-session=${state.session}"|--grokbot-local-session=${state.session})(?=\\s|$)`);
  return current !== null && current.pid === state.pid && current.created === state.created && typeof current.executable === 'string' && current.executable.toLowerCase() === state.executable.toLowerCase() && typeof current.commandLine === 'string' && marker.test(current.commandLine);
}

export async function withLaunchGuard(dataRoot, action) {
  const database = new DatabaseSync(path.join(dataRoot, 'windows-launch-guard.sqlite'));
  try {
    database.exec('PRAGMA busy_timeout=0');
    try { database.exec('BEGIN EXCLUSIVE'); }
    catch { throw new Error('另一个启动管理操作正在运行，或启动管理数据库不可用'); }
    return await action();
  } finally { database.close(); }
}

export function publishState(dataRoot, state) {
  const temporary = path.join(dataRoot, `.windows-launch-${randomUUID()}.json`);
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(state)}\n`);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  renameSync(temporary, path.join(dataRoot, 'windows-launch.json'));
}

export function readState(dataRoot) {
  const file = path.join(dataRoot, 'windows-launch.json');
  if (!existsSync(file)) return null;
  const value = readJson(file);
  if (value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.executable !== 'string' || typeof value.created !== 'string' || !/^[a-f0-9-]{36}$/.test(value.session)) throw new Error('windows-launch.json 内容无效');
  return value;
}

export async function startDetached(executable, args, env, logFile) {
  const log = openSync(logFile, 'a');
  try {
    const child = spawn(executable, args, { env, detached: true, windowsHide: false, stdio: ['ignore', log, log] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return child.pid;
  } finally { closeSync(log); }
}

export function stopProcessTree(state) {
  if (!sameProcess(state, inspectProcess(state.pid))) throw new Error('进程身份已经变化，停止操作已取消');
  // 保留进程句柄直到全部子进程退出；正常退出超时后终止进程树。
  const created = Buffer.from(state.created).toString('base64');
  powershell(`
$ErrorActionPreference='Stop'
$held=@{}
try {
  $root=Get-Process -Id ${state.pid}
  $null=$root.Handle
  $held[${state.pid}]=$root
  $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${state.pid}'
  $expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${created}'))
  if (!$p -or $p.CreationDate.ToUniversalTime().ToString('o') -ne $expected) { throw 'Process identity changed' }
  function Capture-Children {
    $all=@(Get-CimInstance Win32_Process)
    do {
      $added=$false
      foreach ($candidate in $all) {
        $id=[int]$candidate.ProcessId
        if ($held.ContainsKey([int]$candidate.ParentProcessId) -and !$held.ContainsKey($id)) {
          $child=Get-Process -Id $id -ErrorAction SilentlyContinue
          if (!$child) { continue }
          try {
            $null=$child.Handle
            $current=Get-CimInstance Win32_Process -Filter "ProcessId = $id"
            if (!$current -or $current.CreationDate -ne $candidate.CreationDate) { $child.Dispose(); continue }
            $held[$id]=$child
            $added=$true
          } catch {
            $remaining=Get-CimInstance Win32_Process -Filter "ProcessId = $id"
            $child.Dispose()
            if ($remaining -and $remaining.CreationDate -eq $candidate.CreationDate) { throw }
          }
        }
      }
    } while ($added)
  }
  Capture-Children
  $null=$root.CloseMainWindow()
  $deadline=[DateTime]::UtcNow.AddSeconds(10)
  while (!$root.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    $null=$root.WaitForExit(200)
    Capture-Children
  }
  Capture-Children
  if (!$root.HasExited) {
    $current=Get-CimInstance Win32_Process -Filter 'ProcessId = ${state.pid}'
    if (!$current -or $current.CreationDate.ToUniversalTime().ToString('o') -ne $expected) { throw 'Process identity changed' }
    & taskkill.exe /PID ${state.pid} /T /F | Out-Null
    if ($LASTEXITCODE -ne 0 -and !$root.HasExited) { throw 'Process tree stop failed' }
  }
  $cleanupDeadline=[DateTime]::UtcNow.AddSeconds(10)
  do {
    Capture-Children
    $live=@($held.Values | Where-Object { !$_.HasExited })
    foreach ($item in $live) { if (!$item.HasExited) { $item.Kill() } }
    foreach ($item in $live) { if (!$item.WaitForExit(5000)) { throw 'Process did not exit' } }
    if ([DateTime]::UtcNow -ge $cleanupDeadline) { throw 'Process tree exit timed out' }
  } while ($live.Count -gt 0)
} finally { foreach ($item in $held.Values) { $item.Dispose() } }
`);
}

async function docker(client, args) {
  const result = await client.run(args);
  if (!result.ok) throw new Error(`Docker 操作失败：${result.output}`);
  return result.output;
}

export function assertOwnedContainer(value, dataRoot) {
  const normalize = value => {
    if (typeof value !== 'string') throw new Error('容器目录格式无效');
    return value.replaceAll('\\', '/').replace(/^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-z])\//i, '$1:/').replace(/\/$/, '').toLowerCase();
  };
  const wanted = normalize(path.join(dataRoot, 'box-workspace'));
  if (value?.Config?.Labels?.['com.grok-bot.local-vm'] !== '1' || !value.Mounts?.some(mount => mount.Destination === '/workspace' && normalize(mount.Source) === wanted)) throw new Error('容器归属与当前数据目录不匹配');
}

async function stopContainer(dataRoot, client) {
  const ids = await docker(client, ['ps', '-aq', '--filter', `name=^/${containerName}$`]);
  if (!ids) return;
  const [value] = JSON.parse(await docker(client, ['inspect', containerName]));
  assertOwnedContainer(value, dataRoot);
  await docker(client, ['stop', value.Id]);
}

async function health(dataRoot) {
  const file = path.join(dataRoot, 'local-docker-vm.json');
  if (!existsSync(file)) return false;
  const config = readJson(file);
  if (typeof config.token !== 'string' || config.token.length < 32) throw new Error('local-docker-vm.json 凭据无效');
  try { return (await fetch('http://127.0.0.1:1340/health', { headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(2000) })).ok; }
  catch { return false; }
}

async function prepareStart(options, client) {
  const { dataRoot, appPath } = options;
  if (!existsSync(appPath) || !statSync(appPath).isFile()) throw new Error(`应用文件不存在：${appPath}`);
  const runtime = await client.inspect();
  const env = launchEnvironment(dataRoot, { ...dockerEnvironment(runtime), SAND_LOCAL_ADMIN_IMAGE: runtime.container.image });
  const settingsFile = path.join(dataRoot, 'settings.json');
  const settings = loadSettings(dataRoot);
  validateProvider(settings, dataRoot, env);
  const stamp = readJson(path.join(path.dirname(appPath), 'resources', 'build-stamp.json'));
  if (typeof stamp.depsPin !== 'string' || !/^[a-f0-9]{64}$/.test(stamp.depsPin)) throw new Error('应用 build stamp 的 deps pin 无效');
  const image = JSON.parse(await docker(client, ['image', 'inspect', '--format', '{{json .}}', runtime.container.image]));
  validateDockerImage(runtime, image, stamp.depsPin);
  const timeout = Number(env.GROKBOT_READY_TIMEOUT_S ?? 45);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600) throw new Error('GROKBOT_READY_TIMEOUT_S 必须在 0 到 600 秒之间');
  await health(dataRoot);
  return { env, settings, settingsFile, timeout };
}

async function start(options, prepared) {
  const { dataRoot, appPath } = options;
  const { env, settings, settingsFile, timeout } = prepared;
  const state = readState(dataRoot);
  if (state) {
    const current = inspectProcess(state.pid);
    if (sameProcess(state, current)) { console.log('应用已经运行'); return; }
    if (current) throw new Error('已保存进程身份与运行进程不匹配');
  }
  mkdirSync(env.SAND_USER_DATA_DIR, { recursive: true });
  if (!existsSync(settingsFile)) writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(path.join(dataRoot, 'box-mode'), 'docker\n');
  const session = randomUUID();
  const pid = await startDetached(appPath, [`--user-data-dir=${env.SAND_USER_DATA_DIR}`, `--grokbot-local-session=${session}`], env, path.join(dataRoot, 'app.log'));
  const current = inspectProcess(pid);
  if (!current) throw new Error('应用在启动过程中退出');
  const launched = { version: 1, ...current, session };
  delete launched.commandLine;
  publishState(dataRoot, launched);
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    if (!sameProcess(launched, inspectProcess(pid))) throw new Error('应用在启动过程中退出');
    if (await health(dataRoot)) { console.log('应用已经启动，Docker gateway 运行正常'); return; }
    await delay(500);
  }
  throw new Error('Docker gateway 启动超时；应用保留运行，可使用 status 或 stop');
}

async function stop(options, client) {
  const state = readState(options.dataRoot);
  if (state) {
    const current = inspectProcess(state.pid);
    if (current) stopProcessTree(state);
    unlinkSync(path.join(options.dataRoot, 'windows-launch.json'));
  }
  if (options.stopContainer) await stopContainer(options.dataRoot, client);
  console.log(options.stopContainer ? '应用和本项目容器已经停止' : '应用已经停止；Docker 容器保持运行');
}

export async function main(args = process.argv.slice(2)) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此入口需要 Windows x64');
  const options = resolveOptions(args);
  const client = createLocalDockerClient({ dataRoot: options.dataRoot });
  mkdirSync(options.dataRoot, { recursive: true });
  return withLaunchGuard(options.dataRoot, async () => {
    if (options.action === 'status') {
      const state = readState(options.dataRoot);
      console.log(state && sameProcess(state, inspectProcess(state.pid)) ? '应用：运行中' : '应用：未运行');
      console.log(await health(options.dataRoot) ? 'Docker gateway：运行正常' : 'Docker gateway：未就绪');
    } else {
      const prepared = ['start', 'restart'].includes(options.action) ? await prepareStart(options, client) : undefined;
      if (['stop', 'restart'].includes(options.action)) await stop(options, client);
      if (prepared) await start(options, prepared);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`grokbot-local: ${error.message}`); process.exitCode = 1; });
}
