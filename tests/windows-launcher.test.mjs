import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveOptions, readState, inspectProcess, sameProcess, stopProcessTree, assertOwnedContainer, withLaunchGuard, publishState } from '../scripts/windows-local-launch.mjs';
import { defaultDataRoot, loadSettings, launchEnvironment, validateProvider, publicEnvironment } from '../scripts/lib/local-launch-config.mjs';

function temporary(t) {
  const parent = path.resolve('.tmp-windows-launcher');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('共享启动环境保留用户模型参数并强制本地运行策略', () => {
  const root = path.resolve('local data');
  const env = launchEnvironment(root, { SAND_CODEX_MODEL: 'chosen-model', SAND_COMMANDCODE_MODEL: 'selected', SAND_OPENROUTER_MODEL: 'vendor/model', SAND_LOCAL_ADMIN: '0', SAND_DISABLE_UPDATES: '0', ELECTRON_RUN_AS_NODE: '1', SAND_CLAUDE_MODEL: 'configured' });
  assert.equal(env.SAND_CODEX_MODEL, 'chosen-model');
  assert.equal(env.SAND_COMMANDCODE_MODEL, 'selected');
  assert.equal(env.SAND_OPENROUTER_MODEL, 'vendor/model');
  assert.equal(env.SAND_LOCAL_ADMIN, '1');
  assert.equal(env.SAND_DISABLE_UPDATES, '1');
  assert.equal(env.SAND_LOCAL_ADMIN_TURN, 'host');
  assert.equal(env.SAND_LOCAL_ADMIN_BOX, 'docker');
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'configured');
  assert.equal(env.SAND_USER_DATA_DIR, path.join(root, 'profile'));
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.throws(() => launchEnvironment(root, { GROKBOT_BOX: 'mac-host' }));
  assert.throws(() => launchEnvironment(root, { GROKBOT_TURN: 'mac' }));
  assert.equal(publicEnvironment({ ...env, ANTHROPIC_API_KEY: 'private', ANTHROPIC_AUTH_TOKEN: 'private' }).ANTHROPIC_API_KEY, undefined);
});

test('启动路径相对于分发目录，数据目录使用当前用户配置', () => {
  const root = 'C:\\distribution';
  const local = 'D:\\user data';
  const result = resolveOptions(['start'], { LOCALAPPDATA: local }, root);
  assert.equal(result.appPath, path.win32.join(root, 'Grok Bot.exe'));
  assert.equal(result.dataRoot, path.win32.join(local, 'GrokBotLocal'));
  assert.equal(defaultDataRoot({ HOME: '/Users/example' }, 'darwin'), '/Users/example/.grokbot-local');
  assert.equal(resolveOptions(['stop', '--data-root', local, '--stop-container'], {}, root).stopContainer, true);
  assert.throws(() => resolveOptions(['start', '--stop-container'], { LOCALAPPDATA: local }, root));
});

test('文件配置损坏立即报错，按提供商校验凭据且不覆盖配置', t => {
  const root = temporary(t);
  assert.equal(loadSettings(root).inferenceProvider, 'claude-code');
  assert.throws(() => validateProvider(loadSettings(root), root, {}));
  for (const provider of ['codex', 'openrouter', 'command-code']) {
    writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ version: 1, inferenceProvider: provider, boxRuntime: 'local-docker' }));
    validateProvider(loadSettings(root), root, {});
  }
  writeFileSync(path.join(root, 'settings.json'), '{invalid');
  assert.throws(() => loadSettings(root), /JSON/);
  assert.equal(readFileSync(path.join(root, 'settings.json'), 'utf8'), '{invalid');
  writeFileSync(path.join(root, 'windows-launch.json'), JSON.stringify({ pid: 1 }));
  assert.throws(() => readState(root), /内容无效/);
});

test('env0 CLI 提供完整配置且不输出凭据', t => {
  const root = temporary(t);
  writeFileSync(path.join(root, 'anthropic-token'), 'test-input-kept-in-file');
  const output = execFileSync(process.execPath, ['scripts/lib/local-launch-config.mjs', 'env0', root], { encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: 'sensitive-input', ANTHROPIC_AUTH_TOKEN: 'sensitive-input' } });
  assert.ok(output.includes('SAND_LOCAL_ADMIN\0' + '1\0'));
  assert.ok(output.includes('ANTHROPIC_API_KEY\0local-file\0'));
  assert.ok(!output.includes('sensitive-input'));
  assert.ok(!output.includes('test-input-kept-in-file'));
});

test('容器归属必须匹配 owner label 和工作目录', () => {
  const root = path.resolve('data');
  const container = { Config: { Labels: { 'com.grok-bot.local-vm': '1' } }, Mounts: [{ Destination: '/workspace', Source: path.join(root, 'box-workspace') }] };
  assertOwnedContainer(container, root);
  assert.throws(() => assertOwnedContainer(container, path.resolve('other-data')));
  assert.throws(() => assertOwnedContainer({ ...container, Config: { Labels: {} } }, root));
});

test('进程标记需要完整参数边界', () => {
  const state = { pid: 123, created: 'time', executable: 'app.exe', session: randomUUID() };
  const marker = `--grokbot-local-session=${state.session}`;
  for (const commandLine of [`app.exe ${marker}`, `app.exe "${marker}"`, `app.exe ${marker} --other`]) assert.ok(sameProcess(state, { ...state, commandLine }));
  for (const commandLine of [`app.exe ${marker}suffix`, `app.exe prefix${marker}`, `app.exe "${marker}suffix"`]) assert.equal(sameProcess(state, { ...state, commandLine }), false);
});

test('状态文件原子发布并保留完整有效 JSON', t => {
  const root = temporary(t);
  const state = { version: 1, pid: 123, created: 'time', executable: 'app.exe', session: randomUUID() };
  publishState(root, state);
  assert.deepEqual(readState(root), state);
  publishState(root, { ...state, pid: 456 });
  assert.equal(readState(root).pid, 456);
  assert.deepEqual(readdirSync(root), ['windows-launch.json']);
});

test('真实多进程 SQLite guard 互斥，进程退出后自动释放且保留数据库', { timeout: 15000 }, async t => {
  const root = temporary(t);
  const moduleUrl = pathToFileURL(path.resolve('scripts/windows-local-launch.mjs')).href;
  const script = `import {withLaunchGuard} from ${JSON.stringify(moduleUrl)}; await withLaunchGuard(${JSON.stringify(root)},async()=>{process.send('acquired');await new Promise(resolve=>process.once('message',resolve));});process.disconnect();`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  assert.deepEqual(await once(holder, 'message'), ['acquired', undefined]);
  await assert.rejects(withLaunchGuard(root, async () => assert.fail('并发进入启动管理')), /另一个启动管理/);
  const contenders = Array.from({ length: 4 }, () => {
    const command = `import {withLaunchGuard} from ${JSON.stringify(moduleUrl)}; try { await withLaunchGuard(${JSON.stringify(root)},()=>{process.exitCode=2}); } catch { process.exitCode=0; }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', command], { stdio: 'ignore' });
    return once(child, 'exit');
  });
  for (const result of await Promise.all(contenders)) assert.equal(result[0], 0);
  const exited = once(holder, 'exit');
  holder.kill();
  await exited;
  await withLaunchGuard(root, async () => {});
  assert.ok(existsSync(path.join(root, 'windows-launch-guard.sqlite')));
});

test('Windows 真实进程在启动脚本退出后存活，并在验证身份后停止整棵进程树', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const root = temporary(t);
  const session = randomUUID();
  const log = path.join(root, 'process.log');
  const moduleUrl = pathToFileURL(path.resolve('scripts/windows-local-launch.mjs')).href;
  const childSource = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify({child:child.pid}));setInterval(()=>{},1000);`;
  const outerSource = `import {startDetached} from ${JSON.stringify(moduleUrl)}; console.log(await startDetached(process.execPath,['-e',${JSON.stringify(childSource)},'--','--grokbot-local-session=${session}'],process.env,${JSON.stringify(log)}));`;
  const pid = Number(execFileSync(process.execPath, ['--input-type=module', '-e', outerSource], { encoding: 'utf8' }).trim());
  const current = inspectProcess(pid);
  assert.ok(current);
  const state = { ...current, session };
  t.after(() => { if (sameProcess(state, inspectProcess(pid))) stopProcessTree(state); });
  assert.ok(sameProcess(state, current));
  assert.throws(() => stopProcessTree({ ...state, session: randomUUID() }), /身份/);
  let childPid;
  for (let index = 0; index < 20; index++) {
    const text = readFileSync(log, 'utf8').trim();
    if (text) { childPid = JSON.parse(text).child; break; }
    await delay(100);
  }
  assert.ok(childPid);
  assert.ok(inspectProcess(childPid));
  stopProcessTree(state);
  assert.equal(inspectProcess(pid), null);
  assert.equal(inspectProcess(childPid), null);
});
