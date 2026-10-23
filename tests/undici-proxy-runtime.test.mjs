import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { connect } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);

function opensslExecutable() {
  if (process.platform !== "win32") return "openssl";
  const gitRoot = path.join(process.env.ProgramFiles || "C:\\Program Files", "Git");
  return [
    path.join(gitRoot, "usr", "bin", "openssl.exe"),
    path.join(gitRoot, "mingw64", "bin", "openssl.exe"),
  ].find((candidate) => existsSync(candidate)) || "openssl";
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

for (const proxied of [false, true]) {
  test(`production proxyFetch supports CommonJS, response errors and stream cleanup ${proxied ? "through HTTPS_PROXY CONNECT" : "directly"}`, { timeout: 30_000 }, async (t) => {
    const cache = path.join(root, ".cache", "undici-proxy-tests");
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(path.join(cache, "runtime-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const compiled = path.join(directory, "proxy-fetch.cjs");
    await build({
      entryPoints: [path.join(root, "source/packages/cursor-config/auth/proxy-fetch.ts")],
      outfile: compiled,
      bundle: true,
      platform: "node",
      format: "cjs",
      packages: "external",
    });

    const closedStreams = new Set();
    const requests = [];
    const handler = async (request, response) => {
      requests.push(request.url);
      if (request.url === "/ok") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        response.end(Buffer.concat(chunks));
      } else if (request.url === "/error") {
        response.writeHead(503);
        response.end("service unavailable");
      } else if (request.url === "/broken") {
        response.writeHead(200, { "content-length": "1000" });
        response.write("partial");
        setImmediate(() => response.destroy());
      } else {
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("stream-start");
        response.once("close", () => closedStreams.add(request.url));
      }
    };
    const certificate = path.join(directory, "localhost-cert.pem");
    const key = path.join(directory, "localhost-key.pem");
    if (proxied) {
      await run(opensslExecutable(), [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", certificate, "-days", "1",
        "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ], { timeout: 10_000, windowsHide: true });
    }
    const server = proxied ? createSecureServer({
      key: await readFile(key),
      cert: await readFile(certificate),
    }, handler) : createServer(handler);
    const originPort = await listen(server);
    t.after(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });

    let tunnelCount = 0;
    const sockets = new Set();
    const proxy = createServer((_request, response) => response.writeHead(405).end());
    proxy.on("connect", (request, client, head) => {
      assert.equal(request.url, `127.0.0.1:${originPort}`);
      tunnelCount += 1;
      const upstream = connect(originPort, "127.0.0.1");
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      }
      client.once("error", () => upstream.destroy());
      upstream.once("error", () => client.destroy());
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => client.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    });
    const proxyPort = await listen(proxy);
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => proxy.close(resolve));
    });

    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(name)) delete env[name];
    }
    if (proxied) {
      env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
      env.NODE_EXTRA_CA_CERTS = certificate;
    }
    const result = await run(process.execPath, [
      path.join(root, "tests/fixtures/undici-proxy-client.cjs"),
      compiled,
      `${proxied ? "https" : "http"}://127.0.0.1:${originPort}`,
    ], { env, timeout: 20_000, windowsHide: true });
    assert.deepEqual(JSON.parse(result.stdout), { completed: true, commonjs: true });
    assert.deepEqual(requests, ["/ok", "/error", "/broken", "/abort", "/cancel", "/ok"]);
    for (let attempt = 0; closedStreams.size < 2 && attempt < 100; attempt += 1) await delay(10);
    assert.deepEqual([...closedStreams].sort(), ["/abort", "/cancel"]);
    assert.equal(tunnelCount > 0, proxied);
  });
}
