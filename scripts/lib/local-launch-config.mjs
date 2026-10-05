import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockerEnvironment, resolveLocalDataRoot, resolveLocalRuntimeProfile } from '../../source/shared/node/local-runtime-profile.mjs';

const providers = ['claude-code', 'codex', 'openrouter', 'command-code'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const launchKeys = [
  'SAND_LOCAL_ADMIN', 'SAND_LOCAL_ADMIN_EMAIL', 'SAND_DISABLE_SENTRY', 'SAND_DISABLE_TELEMETRY',
  'SAND_CLAUDE_MODEL', 'SAND_DATA_ROOT', 'SAND_USER_DATA_DIR', 'SAND_LOCAL_ADMIN_BOX',
  'SAND_LOCAL_ADMIN_IMAGE', 'SAND_LOCAL_ADMIN_TURN', 'SAND_LOCAL_ADMIN_DESKTOP',
  'SAND_AGENT_WORKSPACE', 'SAND_WORKSPACE_ROOT', 'SAND_COMMANDCODE_MODEL', 'SAND_CODEX_MODEL',
  'SAND_CODEX_REASONING_EFFORT', 'SAND_OPENROUTER_MODEL', 'SAND_AWAITING_HUMAN_TIMEOUT_MS',
  'SAND_DISABLE_UPDATES', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  ...['FABLE', 'HAIKU', 'OPUS', 'SONNET'].flatMap(name => [`ANTHROPIC_DEFAULT_${name}_MODEL`, `ANTHROPIC_DEFAULT_${name}_MODEL_NAME`]),
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_PATH', 'CODEX_HOME', 'CODEX_PATH',
  'ENABLE_TOOL_SEARCH', 'DISABLE_AUTOUPDATER', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'PATH',
];

export function readJson(file) {
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error(`无法读取有效 JSON：${file}`); }
  if (!object(value)) throw new Error(`JSON 必须包含对象：${file}`);
  return value;
}

export function defaultDataRoot(env = process.env, platform = process.platform) {
  return resolveLocalDataRoot({ env, platform });
}

export function validateSettings(settings) {
  if (!object(settings) || settings.version !== 1 || !providers.includes(settings.inferenceProvider) || settings.boxRuntime !== 'local-docker') throw new Error('settings.json 需要 version=1、有效的本地 inferenceProvider 和 boxRuntime=local-docker');
  return settings;
}

export function loadSettings(dataRoot) {
  const file = path.join(dataRoot, 'settings.json');
  return existsSync(file) ? validateSettings(readJson(file)) : {
    version: 1, inferenceProvider: 'claude-code', boxRuntime: 'local-docker', mcpBoxServers: [],
    autoUpdateWhenIdleOptIn: false, egressTunnelEnabled: false, webauthnProxyEnabled: true,
    mcpCustomInstructions: {}, mcpCustomInstructionsByServerId: {}, mcpDisabledToolsByServerId: {},
    conciergeConsent: 'unset', settingsMigrations: ['downgrade-persisted-max-fast'], hasSeenOnboarding: true,
  };
}

export function launchEnvironment(dataRoot, env = process.env) {
  if ((env.GROKBOT_BOX ?? 'docker') !== 'docker' || (env.GROKBOT_TURN ?? 'host') !== 'host') throw new Error('本地回合必须使用 Docker 容器');
  const runtime = resolveLocalRuntimeProfile({ dataRoot, env });
  const result = { ...dockerEnvironment(runtime, env), SAND_LOCAL_ADMIN: '1', SAND_DISABLE_SENTRY: '1', SAND_DISABLE_TELEMETRY: '1', SAND_DISABLE_UPDATES: '1', DISABLE_AUTOUPDATER: '1',
    SAND_DATA_ROOT: dataRoot, SAND_USER_DATA_DIR: path.join(dataRoot, 'profile'), SAND_LOCAL_ADMIN_BOX: 'docker', SAND_LOCAL_ADMIN_TURN: 'host',
    SAND_LOCAL_ADMIN_DESKTOP: env.GROKBOT_DESKTOP === '0' ? '0' : '1', ENABLE_TOOL_SEARCH: 'true',
    SAND_CLAUDE_MODEL: env.SAND_CLAUDE_MODEL || 'glm-5.3-flash', ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL || 'https://open.bigmodel.cn/api/anthropic' };
  delete result.ELECTRON_RUN_AS_NODE;
  result.SAND_LOCAL_ADMIN_IMAGE = runtime.container.image;
  result.ANTHROPIC_MODEL = env.ANTHROPIC_MODEL || result.SAND_CLAUDE_MODEL;
  result.CLAUDE_CODE_SUBAGENT_MODEL = env.CLAUDE_CODE_SUBAGENT_MODEL || result.SAND_CLAUDE_MODEL;
  for (const name of ['FABLE', 'HAIKU', 'OPUS', 'SONNET']) {
    const key = `ANTHROPIC_DEFAULT_${name}_MODEL`;
    result[key] = env[key] || result.SAND_CLAUDE_MODEL;
    result[`${key}_NAME`] = env[`${key}_NAME`] || result[key];
  }
  return result;
}

export function validateProvider(settings, dataRoot, env) {
  if (settings.inferenceProvider !== 'claude-code') return;
  const tokenFile = path.join(dataRoot, 'anthropic-token');
  if (existsSync(tokenFile)) {
    if (!statSync(tokenFile).isFile() || !readFileSync(tokenFile, 'utf8').trim()) throw new Error('anthropic-token 必须包含有效凭据');
    env.ANTHROPIC_API_KEY = 'local-file';
    return;
  }
  // 其他提供商的凭据由应用的加密存储和容器内登录负责校验。
  throw new Error(`Claude Code 需要凭据文件：${tokenFile}`);
}

export function publicEnvironment(env) {
  const selected = Object.fromEntries(launchKeys.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  if (env.ANTHROPIC_API_KEY === 'local-file') selected.ANTHROPIC_API_KEY = 'local-file';
  return selected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, suppliedRoot] = process.argv.slice(2);
    const root = suppliedRoot ? path.resolve(suppliedRoot) : defaultDataRoot();
    if (action === 'settings') process.stdout.write(`${JSON.stringify(loadSettings(root), null, 2)}\n`);
    else if (action === 'env0') {
      const env = launchEnvironment(root);
      validateProvider(loadSettings(root), root, env);
      for (const [key, value] of Object.entries(publicEnvironment(env))) process.stdout.write(`${key}\0${value}\0`);
    } else throw new Error('使用 settings 或 env0 [data-root]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
