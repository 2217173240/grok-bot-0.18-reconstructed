import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { build } from "esbuild";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { getSchema, mergeAttributes } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";

const root = fileURLToPath(new URL("..", import.meta.url));
const execute = promisify(execFile);

test("Piscina workers ignore inherited execArgv options", async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "piscina-security-"));
  try {
    const preload = path.join(directory, "preload.cjs");
    const worker = path.join(directory, "worker.cjs");
    const runner = path.join(directory, "runner.mjs");
    await writeFile(preload, "globalThis.inheritedPreloadExecuted = true;\n");
    await writeFile(worker, "module.exports = () => globalThis.inheritedPreloadExecuted === true;\n");
    await writeFile(runner, `
import assert from "node:assert/strict";
import Piscina from "piscina";
Object.prototype.execArgv = ["--require", ${JSON.stringify(preload)}];
const pool = new Piscina({ filename: ${JSON.stringify(worker)}, minThreads: 1, maxThreads: 1 });
try {
  assert.equal(await pool.run(), false, "Worker executed inherited preload");
} finally {
  await pool.destroy();
  delete Object.prototype.execArgv;
}
`);
    // 原型污染只发生在隔离子进程中，worker 执行真实任务。
    await execute(process.execPath, [runner], { cwd: root, timeout: 15_000 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function loadProductionModule(t, entry) {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "dependency-integration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, "production.mjs");
  await build({ entryPoints: [path.join(root, entry)], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
  return import(pathToFileURL(outfile).href);
}

test("desktop tracing exports real OTLP spans and refreshes authorization on a loopback collector", { timeout: 15_000 }, async (t) => {
  const { AsyncTokenSpanExporter } = await loadProductionModule(t, "source/electron-main/telemetry/desktop-send-trace.ts");
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
    response.writeHead(200, { "content-type": "application/x-protobuf" });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  let token = "local-test-token-one";
  const failures = [];
  const exporter = new AsyncTokenSpanExporter(`http://127.0.0.1:${server.address().port}/v1/traces`, async () => token, undefined, (...args) => failures.push(args));
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": "dependency-integration" }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  try {
    const tracer = provider.getTracer("desktop-dependency-integration");
    tracer.startSpan("first-local-span").end();
    await provider.forceFlush();
    token = "local-test-token-two";
    tracer.startSpan("second-local-span").end();
    await provider.forceFlush();
    assert.equal(requests.length, 2);
    for (const [index, request] of requests.entries()) {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/traces");
      assert.equal(request.headers["content-type"], "application/x-protobuf");
      assert.equal(request.headers.authorization, `Bearer local-test-token-${index === 0 ? "one" : "two"}`);
      assert.equal(request.headers["x-ghost-mode"], "false");
      assert.ok(request.body.includes(Buffer.from(index === 0 ? "first-local-span" : "second-local-span")));
      assert.ok(request.body.includes(Buffer.from("dependency-integration")));
    }
    assert.deepEqual(failures, []);
  } finally {
    await provider.shutdown();
  }
});

test("production prompt extensions preserve links and mentions across ProseMirror transactions", async (t) => {
  const { createPromptEditorExtensions, promptEditorContent } = await loadProductionModule(t, "frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx");
  const schema = getSchema(createPromptEditorExtensions("Write a message"));
  const richText = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [
    { type: "mention", attrs: { id: "member-1", label: "Alice" } },
    { type: "text", text: " documentation", marks: [{ type: "link", attrs: { href: "https://example.test/docs" } }] },
  ] }] });
  let state = EditorState.create({ schema, doc: schema.nodeFromJSON(promptEditorContent("fallback", richText)) });
  state = state.apply(state.tr.insertText("Please ask ", 1));
  state.doc.check();
  const restored = schema.nodeFromJSON(promptEditorContent("fallback", JSON.stringify(state.doc.toJSON())));
  assert.ok(restored.eq(state.doc));
  assert.equal(restored.firstChild.firstChild.text, "Please ask ");
  assert.equal(restored.firstChild.child(1).type.name, "mention");
  assert.equal(restored.firstChild.child(1).attrs.label, "Alice");
  assert.equal(restored.firstChild.lastChild.marks[0].attrs.href, "https://example.test/docs");
  // 生产编辑器使用 mergeAttributes 渲染 mention 属性。
  const attributes = mergeAttributes({ class: "sand-mention" }, JSON.parse('{"__proto__":{"onclick":"alert(1)"},"data-type":"mention"}'));
  assert.equal(attributes.onclick, undefined);
  assert.equal(attributes.class, "sand-mention");
  assert.equal(attributes["data-type"], "mention");
});

test("production KaTeX loader renders math while leaving HTML commands untrusted", async (t) => {
  const { loadShippedKatexRuntime, renderKatexMarkup } = await loadProductionModule(t, "frontend/src/recovered/features/conversation/workspace/math.tsx");
  const runtime = await loadShippedKatexRuntime();
  const math = renderKatexMarkup(runtime, String.raw`\frac{1}{2}+x^2`, true);
  assert.match(math, /class="katex-display"/);
  assert.match(math, /<math\b/);
  assert.doesNotMatch(math, /class="katex-error"/);
  const unsafe = renderKatexMarkup(runtime, String.raw`\href{javascript:alert(1)}{click}`, false);
  assert.doesNotMatch(unsafe, /href\s*=\s*["']javascript:/i);
  const invalid = renderKatexMarkup(runtime, String.raw`\frac{<script>alert(1)</script>`, false);
  assert.match(invalid, /class="katex-error"/);
  assert.doesNotMatch(invalid, /<script\b/i);
});
