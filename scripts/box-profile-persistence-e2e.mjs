import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";

if (process.argv[2] === "inside") {
  assert.equal(process.platform, "linux");
  const { chromium } = await import("/opt/box-service/node_modules/playwright-core/index.mjs");
  const server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<title>Profile persistence</title>Profile persistence"); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(18991, "127.0.0.1", resolve); });
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0];
    await page.goto("http://127.0.0.1:18991");
    if (process.argv[3] === "write") {
      await context.addCookies([{ name: "profile_acceptance", value: "persistent", url: "http://127.0.0.1:18991", expires: Math.floor(Date.now() / 1000) + 3600 }]);
      await page.evaluate(() => localStorage.setItem("profile_acceptance", "persistent"));
      await (await browser.newBrowserCDPSession()).send("Browser.close");
    } else {
      assert.equal((await context.cookies("http://127.0.0.1:18991")).find(cookie => cookie.name === "profile_acceptance")?.value, "persistent");
      assert.equal(await page.evaluate(() => localStorage.getItem("profile_acceptance")), "persistent");
      console.log("PASS: cookie and localStorage survived container replacement and stale browser locks");
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
} else {
  const run = promisify(execFile);
  const image = process.env.GROKBOT_EVAL_IMAGE || "grok-bot-exec-box:arm64";
  const name = `grok-profile-e2e-${process.pid}`;
  const data = `${name}-data`;
  const workspace = `${name}-workspace`;
  const docker = (...args) => run("docker", args, { timeout: 90_000, maxBuffer: 1_000_000 });
  const start = async () => {
    await docker("run", "--detach", "--name", name, "--memory", "3g", "--security-opt", "seccomp=unconfined", "--entrypoint", "/usr/local/bin/box-init-exec",
      "--volume", `${data}:/home/box/sand-data`, "--volume", `${workspace}:/workspace`,
      "--mount", `type=bind,src=${path.resolve(import.meta.filename)},dst=/home/box/profile-persistence-test.mjs,readonly`,
      image, "-e", "setInterval(() => {}, 1000)");
    await docker("exec", name, "bash", "-lc", "source /usr/local/bin/box-common.sh; wait_for 30 env DISPLAY=:1 xdpyinfo");
    await docker("exec", name, "sh", "-c", "test \"$(readlink /home/box/chrome-profile)\" = /home/box/sand-data/chrome-profile && test ! -L /home/box/chrome-profile/SingletonLock");
  };
  const browser = () => docker("exec", "--env", "DISPLAY=:1", name, "box-chrome");
  try {
    await docker("run", "--rm", "--user", "root", "--entrypoint", "sh", "--volume", `${data}:/home/box/sand-data`, "--volume", `${workspace}:/workspace`, image, "-c", "chown -R box:box /home/box/sand-data /workspace");
    await start();
    await browser();
    await docker("exec", name, "node", "/home/box/profile-persistence-test.mjs", "inside", "write");
    await docker("exec", name, "bash", "-lc", "source /usr/local/bin/box-common.sh; wait_for 20 bash -c '! pgrep -f \"[c]hromium.*--user-data-dir\"'");
    await browser();
    await docker("exec", name, "test", "-L", "/home/box/chrome-profile/SingletonLock");
    await docker("kill", name);
    await docker("rm", name);
    await start();
    await browser();
    const result = await docker("exec", name, "node", "/home/box/profile-persistence-test.mjs", "inside", "read");
    process.stdout.write(result.stdout);
  } finally {
    await docker("rm", "--force", name).catch(() => {});
    await docker("volume", "rm", data, workspace).catch(() => {});
  }
}
