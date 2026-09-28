import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { parse } from "acorn";
import { simple } from "acorn-walk";

const root = path.resolve(import.meta.dirname, "..");
const stockPath = path.join(root, "src/app/dist/renderer/assets/index-UbX-y3il.js");
const cases = [
  [["photo.PNG"], [{ kind: "image", count: 1 }], "Sent 1 image"],
  [["a.png", "b.jpg"], [{ kind: "image", count: 2 }], "Sent 2 images"],
  [["a.png", "report.pdf", "data.csv", "note.md", "data.json", "package.zip", "unknown.xyz"],
    [{ kind: "image", count: 1 }, { kind: "pdf", count: 1 }, { kind: "table", count: 1 }, { kind: "markdown", count: 1 }, { kind: "json", count: 1 }, { kind: "archive", count: 1 }, { kind: "file", count: 1 }],
    "Sent 7 files · 1 image, 1 PDF, 1 spreadsheet, 1 Markdown file, 1 JSON file, 1 archive, 1 file"],
  [["unknown.xyz"], [{ kind: "file", count: 1 }], "Sent 1 file"],
];

async function withModules(run) {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const dir = await mkdtemp(path.join(root, ".cache/session-attachments-"));
  try {
    const modules = [];
    for (const [index, entry] of [
      "source/host/extensions/session/session-projection.ts",
      "frontend/src/production/model.ts",
      "frontend/src/recovered/features/conversation/workspace/sidebar-agent-preview-content.tsx",
    ].entries()) {
      const outfile = path.join(dir, `${index}.mjs`);
      await build({ entryPoints: [path.join(root, entry)], bundle: true, platform: "node", format: "esm", packages: "external", outfile, logLevel: "silent" });
      modules.push(await import(pathToFileURL(outfile).href));
    }
    await run(...modules);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function attachments(names, kind) {
  return names.map((name) => kind === "user-attachment"
    ? { kind, batchId: "batch", file_name: name, file_path: `/files/${name}` }
    : { kind, batchId: "batch", message: { type: "attachment", file_name: name, url: `https://files.example/${name}` } });
}

test("host attachment batches reach the diagnostic sidebar as kind counts", async () => {
  await withModules(async (host, model, sidebar) => {
    for (const kind of ["user-attachment", "send-message"]) {
      for (const [names, kinds, summary] of cases) {
        const projected = host.getLastEntryFromTranscript(attachments(names, kind));
        assert.deepEqual(projected, { kind: "attachment", count: names.length, kinds });
        const parsed = model.parseRendererAgentLastEntry(projected);
        assert.deepEqual(parsed, projected);
        assert.equal(sidebar.previewTextFromLastEntry(parsed), summary);
      }
      const entries = attachments(["a.png", "b.pdf"], kind);
      entries[0].batchId = "previous";
      assert.deepEqual(host.getLastEntryFromTranscript(entries).kinds, [{ kind: "pdf", count: 1 }]);
      delete entries[0].batchId;
      delete entries[1].batchId;
      assert.equal(host.getLastEntryFromTranscript(entries).count, 1);
    }
    const link = { kind: "send-message", batchId: "batch", message: { type: "attachment", url: "https://example.com/image.png" } };
    assert.deepEqual(host.getLastEntryFromTranscript([link]), { kind: "link", url: link.message.url });
    assert.equal(host.getLastEntryFromTranscript([link, ...attachments(["a.png"], "send-message")]).count, 1);
    assert.deepEqual(host.getLastEntryFromTranscript([{ kind: "user-attachment", file_path: "/files/photo.png" }]).kinds, [{ kind: "image", count: 1 }]);
    assert.equal(model.parseRendererAgentLastEntry({ kind: "attachment", count: 1, kinds: { image: 1 } }), null);
    for (const kinds of [[null], [{ kind: "image", count: 0 }], [{ kind: "image", count: 1.5 }]]) {
      assert.equal(model.parseRendererAgentLastEntry({ kind: "attachment", count: 1, kinds }), null);
    }
  });
});

test("stock sidebar consumes host attachment summaries", { skip: existsSync(stockPath) ? false : "requires npm run bootstrap" }, async () => {
  const source = await readFile(stockPath, "utf8");
  const declarations = new Map();
  simple(parse(source, { ecmaVersion: "latest", sourceType: "module" }), {
    FunctionDeclaration(node) {
      if (["the", "Yun", "Zun"].includes(node.id?.name)) declarations.set(node.id.name, source.slice(node.start, node.end));
    },
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && node.id.name === "mut") declarations.set("mut", `const ${source.slice(node.start, node.end)};`);
    },
  });
  assert.equal(declarations.size, 4);
  const stock = Function(`${[...declarations.values()].join("\n")}\nreturn { merge: Yun, summary: Zun };`)();
  await withModules(async (host, model, sidebar) => {
    for (const kind of ["user-attachment", "send-message"]) {
      for (const [names, kinds, summary] of cases) {
        const projected = host.getLastEntryFromTranscript(attachments(names, kind));
        assert.deepEqual(stock.merge(projected.kinds), kinds);
        assert.equal(stock.summary(projected.count, projected.kinds), summary);
      }
    }
    const future = { kind: "attachment", count: 3, kinds: [{ kind: "unknown", count: 1 }, { kind: "file", count: 2 }] };
    assert.equal(stock.summary(future.count, future.kinds), "Sent 3 files");
    assert.equal(sidebar.previewTextFromLastEntry(model.parseRendererAgentLastEntry(future)), "Sent 3 files");
  });
});
