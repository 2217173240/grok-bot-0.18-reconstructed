import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const script = path.resolve('start-local.sh');
function temporary(t) {
  const parent = path.resolve('.tmp-mac-launcher');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Mac 共享环境按提供商校验，完整传递模型参数和 Docker context', { skip: process.platform === 'win32' }, t => {
  const root = temporary(t);
  writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ version: 1, inferenceProvider: 'openrouter', boxRuntime: 'local-docker' }));
  const model = 'vendor/model with spaces\n$(touch forbidden-file)';
  const output = execFileSync('bash', ['-c', 'source "$1"; load_launch_environment; printf "%s\\0" "${LAUNCH_ENV_ARGS[@]}"', 'mac-env-test', script], {
    encoding: 'utf8', env: { ...process.env, GROKBOT_DATA_ROOT: root, SAND_OPENROUTER_MODEL: model, DOCKER_CONTEXT: 'selected-context', ANTHROPIC_API_KEY: 'secret-must-stay-private' },
  });
  const args = output.split('\0');
  assert.ok(args.includes(`SAND_OPENROUTER_MODEL=${model}`));
  assert.ok(args.includes('DOCKER_CONTEXT=selected-context'));
  assert.ok(args.includes('SAND_LOCAL_ADMIN=1'));
  assert.ok(args.includes('SAND_DISABLE_UPDATES=1'));
  assert.ok(!output.includes('secret-must-stay-private'));
  assert.deepEqual(readdirSync(root), ['settings.json']);
});

test('Mac 配置损坏和 Claude 凭据缺失保留非零退出码并清理临时文件', { skip: process.platform === 'win32' }, t => {
  const root = temporary(t);
  const config = path.join(root, 'settings.json');
  for (const contents of ['{broken', JSON.stringify({ version: 1, inferenceProvider: 'claude-code', boxRuntime: 'local-docker' })]) {
    writeFileSync(config, contents);
    const result = spawnSync('bash', ['-c', 'source "$1"; load_launch_environment; printf "unexpected-success"', 'mac-env-test', script], { encoding: 'utf8', env: { ...process.env, GROKBOT_DATA_ROOT: root } });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(readFileSync(config, 'utf8'), contents);
    assert.deepEqual(readdirSync(root), ['settings.json']);
  }
});

test('Mac seed 使用共享设置并保留已有配置', { skip: process.platform === 'win32' }, t => {
  const root = temporary(t);
  const args = ['-c', 'source "$1"; seed_settings', 'mac-seed-test', script];
  const options = { encoding: 'utf8', env: { ...process.env, GROKBOT_DATA_ROOT: root } };
  execFileSync('bash', args, options);
  const file = path.join(root, 'settings.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).inferenceProvider, 'claude-code');
  const selected = JSON.stringify({ version: 1, inferenceProvider: 'codex', boxRuntime: 'local-docker', customValue: 'preserved' });
  writeFileSync(file, selected);
  execFileSync('bash', args, options);
  assert.equal(readFileSync(file, 'utf8'), selected);
  assert.deepEqual(readdirSync(root), ['settings.json']);
});

test('Mac 可选应用目录同时决定二进制和 build stamp 路径', { skip: process.platform === 'win32' }, t => {
  const root = temporary(t);
  const bundle = path.join(root, "User's Grok Bot.app");
  const output = execFileSync('bash', ['-c', 'source "$1"; printf "%s\\0" "$APP_BUNDLE" "$BIN" "$STAMP"', 'mac-path-test', script], { encoding: 'utf8', env: { ...process.env, GROKBOT_APP_PATH: bundle } });
  assert.deepEqual(output.split('\0').slice(0, -1), [bundle, path.join(bundle, 'Contents/MacOS/Grok Bot'), path.join(bundle, 'Contents/Resources/build-stamp.json')]);
});
