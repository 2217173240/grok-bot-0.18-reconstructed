import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { capture, run } from "./lib/process.mjs";
import { repoRoot } from "./lib/config.mjs";

const git = "/usr/bin/git";
const tar = "/usr/bin/tar";
const scratch = await mkdtemp(path.join(os.tmpdir(), "grok-bot-publication-"));
const archive = path.join(scratch, "repository.tar");
const exported = path.join(scratch, "exported");

// .gitattributes marks research-archives/original/**/*.dmg and *.exe with
// `filter=lfs`, so `git archive` runs the LFS smudge filter and tries to fetch
// the 156 MB installer. This check compares the exported tree against
// `HEAD^{tree}`, which matches only while those files stay pointers: expanding
// them would change the tree and fail the comparison. Keep the stored blob.
const archiveEnv = { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" };

try {
  await run(git, ["archive", "--format=tar", `--output=${archive}`, "HEAD"], { cwd: repoRoot, env: archiveEnv });
  await mkdir(exported);
  await run(tar, ["-xf", archive, "-C", exported]);
  await run(git, ["init", "--quiet"], { cwd: exported });
  await run(git, ["add", "--all"], { cwd: exported });

  const [sourceTree, exportedTree, sourceFiles, exportedFiles] = await Promise.all([
    capture(git, ["rev-parse", "HEAD^{tree}"], { cwd: repoRoot }),
    capture(git, ["write-tree"], { cwd: exported }),
    capture(git, ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: repoRoot }),
    capture(git, ["ls-files"], { cwd: exported }),
  ]);
  if (sourceTree !== exportedTree) {
    const sourceSet = new Set(sourceFiles.split("\n").filter(Boolean));
    const exportedSet = new Set(exportedFiles.split("\n").filter(Boolean));
    const omitted = [...sourceSet].filter(file => !exportedSet.has(file));
    const unexpected = [...exportedSet].filter(file => !sourceSet.has(file));
    throw new Error(`Fresh publication export changed the tracked tree. Omitted: ${omitted.slice(0, 20).join(", ") || "none"}. Unexpected: ${unexpected.slice(0, 20).join(", ") || "none"}.`);
  }

  const ignoredSource = "frontend/src/recovered/ui/sand-form-primitives.css";
  if (!(await readFile(path.join(exported, ignoredSource))).byteLength) {
    throw new Error(`Fresh publication export omitted ${ignoredSource}`);
  }
  console.log(`Publication export preserves ${sourceFiles.split("\n").filter(Boolean).length} files and tree ${sourceTree}.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
