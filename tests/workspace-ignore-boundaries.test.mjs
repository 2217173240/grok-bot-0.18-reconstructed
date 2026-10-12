import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const execute = promisify(execFile);

async function productionModule(t) {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "workspace-ignore-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, "production.mjs");
  await build({ entryPoints: [path.join(root, "source/host/extensions/box-store-sync/workspace-ignore.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
  return { url: pathToFileURL(outfile).href, module: await import(pathToFileURL(outfile).href) };
}

test("workspace ignore keeps ordered negations, anchors, directory and glob semantics", async (t) => {
  const { module: { compileWorkspaceIgnore, parseIgnorePatterns } } = await productionModule(t);
  const ignore = compileWorkspaceIgnore(parseIgnorePatterns("# comment\n*.log\n!keep.log\n/root-only\ncache/\nsrc/**/generated?.[jt]s\n"));
  for (const value of ["app.log", "nested/app.log", "root-only", "root-only/child", "cache/item", "nested/cache/item", "src/generated1.js", "src/a/b/generated2.ts"]) {
    assert.equal(ignore.ignores(value), true, value);
  }
  for (const value of ["keep.log", "nested/keep.log", "nested/root-only", "cache", "src/generated10.js", "other/src/generated1.js", "src/generated1.css"]) {
    assert.equal(ignore.ignores(value), false, value);
  }
  assert.equal(compileWorkspaceIgnore(["*.log", "!keep.log", "keep.log"]).ignores("keep.log"), true);
  const globstar = compileWorkspaceIgnore(["/build/**"]);
  assert.equal(globstar.ignores("build/a/b/c"), true);
  assert.equal(globstar.ignores("nested/build/a"), false);
});

test("workspace ignore treats regex punctuation literally and supports character classes", async (t) => {
  const { module: { compileWorkspaceIgnore, compileRule } } = await productionModule(t);
  for (const literal of ["file(1)+$.txt", "foo|bar", "config{prod}", "a^b", "a\\b", "unclosed[", "!important", "#important"]) {
    const pattern = /^[!#]/.test(literal) ? `\\${literal}` : literal;
    const rule = compileRule(pattern);
    assert.equal(rule.fileRe.test(literal), true, literal);
    assert.equal(rule.fileRe.test(`wrong-${literal}`), false, literal);
  }
  const classes = compileWorkspaceIgnore(["file[0-9].txt", "other[!ab].txt"]);
  assert.equal(classes.ignores("file3.txt"), true);
  assert.equal(classes.ignores("filex.txt"), false);
  assert.equal(classes.ignores("otherc.txt"), true);
  assert.equal(classes.ignores("othera.txt"), false);
  // RE2 treats a leading closing bracket as a member of the character class.
  // The previous JS engine interpreted these rare classes inconsistently.
  const closingBracket = compileWorkspaceIgnore(["/[]a]"]);
  assert.equal(closingBracket.ignores("]"), true);
  assert.equal(closingBracket.ignores("a"), true);
  assert.equal(closingBracket.ignores("b"), false);
  const excludeClosingBracket = compileWorkspaceIgnore(["/[!]]"]);
  assert.equal(excludeClosingBracket.ignores("a"), true);
  assert.equal(excludeClosingBracket.ignores("]"), false);
});

test("workspace globs match Unicode characters and require complete path matches", async (t) => {
  const { module: { compileWorkspaceIgnore } } = await productionModule(t);
  const singleCharacter = compileWorkspaceIgnore(["/file?.txt"]);
  assert.equal(singleCharacter.ignores("file😀.txt"), true);
  assert.equal(singleCharacter.ignores("file文.txt"), true);
  assert.equal(singleCharacter.ignores("fileab.txt"), false);
  assert.equal(compileWorkspaceIgnore(["/exact"]).ignores("exact\n"), false);
});

test("workspace ignore pruning conservatively retains every reachable negation", async (t) => {
  const { module: { compileWorkspaceIgnore } } = await productionModule(t);
  const ignore = compileWorkspaceIgnore(["cache/", "!/cache/keep/**"]);
  assert.equal(ignore.canPruneDir("cache"), false);
  assert.equal(ignore.canPruneDir("cache/keep"), false);
  assert.equal(ignore.canPruneDir("cache/keep/deeper"), false);
  assert.equal(ignore.canPruneDir("cache/drop"), true);
  assert.equal(ignore.ignores("cache/keep/a.txt"), false);
  assert.equal(ignore.ignores("cache/drop/a.txt"), true);
  assert.equal(compileWorkspaceIgnore(["cache/", "!keep.txt"]).canPruneDir("cache/drop"), false);
  assert.equal(compileWorkspaceIgnore(["cache/", "!/**/keep.txt"]).canPruneDir("cache/drop"), false);
  assert.equal(compileWorkspaceIgnore(["cache/", "![z-a]"]).canPruneDir("cache"), false);
  assert.equal(compileWorkspaceIgnore(["cache/", "![z-a]"]).ignores("cache/a.txt"), false);
});

test("workspace glob matching cannot hang on repeated ambiguous wildcards", async (t) => {
  const { url } = await productionModule(t);
  // Run actual production matching in a killable process: reverting to native
  // RegExp makes both ignore/prune checks exceed the bound instead of hanging CI.
  for (const method of ["ignores", "canPruneDir"]) {
    const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { compileWorkspaceIgnore } from ${JSON.stringify(url)};
      const ignore = compileWorkspaceIgnore(["*a".repeat(30) + "b"]);
      assert.equal(ignore.${method}("a".repeat(100)), false);
      assert.equal(ignore.${method}("a".repeat(100) + "b"), true);
      console.log("ok");
    `], { cwd: root, timeout: 5000 });
    assert.equal(stdout.trim(), "ok", method);
  }
});
