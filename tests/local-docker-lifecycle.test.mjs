import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.cache/docker-lifecycle-'));
const outfile = path.join(directory, 'lifecycle.mjs');
await build({ entryPoints: [path.join(root, 'source/electron-main/box/local-docker-lifecycle.ts')], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { createLocalDockerLifecycle, createDockerAvailabilityProbe } = await import(outfile);
test.after(() => rm(directory, { recursive: true, force: true }));

async function server(t) {
  const waiting = [];
  const received = [];
  const instance = createServer((request, response) => {
    const value = { request, response };
    if (waiting.length) waiting.shift()(value);
    else received.push(value);
  });
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); });
  return {
    url: `http://127.0.0.1:${instance.address().port}`,
    next: () => received.length ? Promise.resolve(received.shift()) : new Promise(resolve => waiting.push(resolve)),
    received,
  };
}

test('恢复等待旧请求失败结算，新连接共享恢复，后续写操作保持顺序', async t => {
  const http = await server(t);
  const lifecycle = createLocalDockerLifecycle();
  const events = path.join(directory, 'events');
  const operation = async name => {
    await appendFile(events, `${name}:begin\n`);
    const response = await fetch(`${http.url}/${name}`);
    await appendFile(events, `${name}:end\n`);
    if (!response.ok) throw new Error(name);
    return response.text();
  };
  const old = lifecycle.connect(() => operation('old'));
  const oldRejected = assert.rejects(old, /old/);
  const oldRequest = await http.next();
  const recovery = lifecycle.recover(async () => ({ value: 'recovered', connection: await operation('recovery') }));
  const following = lifecycle.connect(() => operation('unexpected'));
  assert.equal(lifecycle.connect(() => operation('unexpected')), following);
  oldRequest.response.writeHead(500).end();
  await oldRejected;
  const recoveryRequest = await http.next();
  assert.equal(recoveryRequest.request.url, '/recovery');
  assert.equal(lifecycle.connect(() => operation('unexpected')), following);
  const stopping = lifecycle.run(() => operation('stop'));
  const afterStop = lifecycle.connect(() => operation('after-stop'));
  recoveryRequest.response.end('connection');
  assert.equal(await recovery, 'recovered');
  assert.equal(await following, 'connection');
  const stopRequest = await http.next();
  assert.equal(stopRequest.request.url, '/stop');
  stopRequest.response.end('stopped');
  await stopping;
  const finalRequest = await http.next();
  assert.equal(finalRequest.request.url, '/after-stop');
  finalRequest.response.end('new-connection');
  assert.equal(await afterStop, 'new-connection');
  assert.equal(await readFile(events, 'utf8'), 'old:begin\nold:end\nrecovery:begin\nrecovery:end\nstop:begin\nstop:end\nafter-stop:begin\nafter-stop:end\n');
});

test('真实 HTTP 探测合并自动请求，刷新阻止旧结果覆盖，失败缓存按真实时间过期', async t => {
  const http = await server(t);
  const probe = createDockerAvailabilityProbe(async () => (await fetch(http.url)).ok, 1000, 30);
  const old = probe.get();
  assert.equal(probe.get(), old);
  const oldRequest = await http.next();
  const fresh = probe.refresh();
  assert.equal(probe.get(), fresh);
  const freshRequest = await http.next();
  freshRequest.response.end();
  assert.equal(await fresh, true);
  oldRequest.response.writeHead(503).end();
  assert.equal(await old, false);
  assert.equal(await probe.get(), true);
  const failed = probe.refresh();
  (await http.next()).response.writeHead(503).end();
  assert.equal(await failed, false);
  assert.equal(await probe.get(), false);
  await delay(40);
  const retry = probe.get();
  (await http.next()).response.end();
  assert.equal(await retry, true);
  assert.equal(http.received.length, 0);
});

test('拒绝恢复的连接等待者得到失败，队列继续处理下一次操作', async () => {
  const lifecycle = createLocalDockerLifecycle();
  const recovery = lifecycle.recover(async () => ({ value: { status: 'rejected' } }));
  const connection = lifecycle.connect(async () => 'unexpected');
  await assert.rejects(connection, /did not establish/);
  assert.deepEqual(await recovery, { status: 'rejected' });
  assert.equal(await lifecycle.connect(async () => readFile(outfile, 'utf8')), await readFile(outfile, 'utf8'));
});

test('实际 Docker 不可达后刷新立即恢复，隔离容器写操作串行执行', { skip: !process.env.SAND_TEST_DOCKER_IMAGE, timeout: 30000 }, async () => {
  const execute = promisify(execFile);
  const realHost = process.env.DOCKER_HOST;
  assert(realHost?.includes('/grokbot/docker.sock'));
  let host = `unix://${path.join(directory, 'absent.sock')}`;
  const docker = args => execute('docker', args, { env: { ...process.env, DOCKER_HOST: host }, timeout: 15000 });
  const probe = createDockerAvailabilityProbe(async () => {
    try { await docker(['info', '--format', '{{.ServerVersion}}']); return true; }
    catch (error) { if (error.code === 1) return false; throw error; }
  });
  assert.equal(await probe.get(), false);
  host = realHost;
  assert.equal(await probe.refresh(), true);
  assert.equal(await probe.get(), true);
  const lifecycle = createLocalDockerLifecycle();
  const name = `grok-lifecycle-test-${process.pid}`;
  const image = process.env.SAND_TEST_DOCKER_IMAGE;
  try {
    const first = lifecycle.connect(async () => {
      await docker(['run', '--name', name, '--network', 'none', '--entrypoint', 'node', image, '-e', 'setTimeout(()=>console.log("first"),150)']);
      return 'first';
    });
    const recovery = lifecycle.recover(async () => {
      const inspect = await docker(['inspect', '--format', '{{.State.Running}}', name]);
      assert.equal(inspect.stdout.trim(), 'false');
      await docker(['rm', name]);
      const run = await docker(['run', '--name', name, '--network', 'none', '--entrypoint', 'node', image, '-e', 'console.log("second")']);
      return { value: 'recovered', connection: run.stdout.trim() };
    });
    const following = lifecycle.connect(async () => { throw new Error('unexpected duplicate'); });
    assert.equal(await first, 'first');
    assert.equal(await recovery, 'recovered');
    assert.equal(await following, 'second');
  } finally { await docker(['rm', '--force', name]); }
});
