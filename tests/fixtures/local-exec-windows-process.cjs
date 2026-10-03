const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
child.once("spawn", () => writeFileSync(process.env.LOCAL_EXEC_PROCESS_REPORT, JSON.stringify({ pid: process.pid, childPid: child.pid, args: process.argv, generation: process.env.SAND_LOCAL_EXEC_GENERATION_TOKEN })));
setInterval(() => {}, 1000);
