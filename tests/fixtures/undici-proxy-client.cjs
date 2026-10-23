const assert = require("node:assert/strict");
const { proxyFetch } = require(process.argv[2]);
const undici = require("undici");

async function main() {
  assert.equal(typeof undici.ProxyAgent, "function");
  const base = process.argv[3];
  const response = await proxyFetch(`${base}/ok`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "proxy-runtime-request",
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "proxy-runtime-request");

  const error = await proxyFetch(`${base}/error`);
  assert.equal(error.status, 503);
  assert.equal(await error.text(), "service unavailable");
  await assert.rejects(async () => {
    const broken = await proxyFetch(`${base}/broken`);
    await broken.text();
  });

  const controller = new AbortController();
  const stream = await proxyFetch(`${base}/abort`, { signal: controller.signal });
  const reader = stream.body.getReader();
  assert.equal((await reader.read()).done, false);
  controller.abort();
  await assert.rejects(reader.read(), { name: "AbortError" });
  reader.releaseLock();

  const cancelled = await proxyFetch(`${base}/cancel`);
  const cancelledReader = cancelled.body.getReader();
  assert.equal((await cancelledReader.read()).done, false);
  await cancelledReader.cancel();
  cancelledReader.releaseLock();

  const after = await proxyFetch(`${base}/ok`, { method: "POST", body: "after-cancel" });
  assert.equal(await after.text(), "after-cancel");
  process.stdout.write(JSON.stringify({ completed: true, commonjs: true }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
