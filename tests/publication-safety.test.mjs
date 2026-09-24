import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";

test("publication checks reject tracked runtime data without exposing contents", async () => {
  const root = new URL("..", import.meta.url).pathname;
  await mkdir(join(root, ".cache"), { recursive: true });
  const dir = await mkdtemp(join(root, ".cache/publication-paths-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    await writeFile(join(dir, "README.md"), "Public documentation\n");
    execFileSync("git", ["add", "README.md"], { cwd: dir });
    const scan = () => spawnSync(process.execPath, [join(root, "scripts/check-publication-inputs.mjs"), dir], { encoding: "utf8" });
    assert.equal(scan().status, 0);
    const paths = [".env", "config/auth.json", "data/box-secrets.json", "chrome-profile/Default/Cookies", "private.pem"];
    for (const path of paths) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), "PRIVATE-CONTENT-MUST-NOT-BE-PRINTED");
    }
    execFileSync("git", ["add", "--force", "--", ...paths], { cwd: dir });
    const result = scan();
    assert.equal(result.status, 1);
    for (const path of paths) assert.ok(result.stderr.includes(path));
    assert.ok(!`${result.stdout}${result.stderr}`.includes("PRIVATE-CONTENT-MUST-NOT-BE-PRINTED"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
