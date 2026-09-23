import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const electronVersion = "42.1.0";
export const electronAbi = "146";
const packages = ["tree-sitter", "tree-sitter-bash"];
const nodeGyp = path.join(repoRoot, "node_modules/node-gyp/bin/node-gyp.js");

async function run(command, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

export function electronNodeGypArguments(packageName, cacheRoot = path.join(repoRoot, ".cache/electron-node-gyp")) {
  if (!packages.includes(packageName)) throw new Error(`Unsupported Electron native package: ${packageName}`);
  return [
    nodeGyp,
    "rebuild",
    "--directory", path.join(repoRoot, "node_modules", packageName),
    "--release",
    `--target=${electronVersion}`,
    "--runtime=electron",
    "--dist-url=https://artifacts.electronjs.org/headers/dist",
    `--devdir=${cacheRoot}`,
    "--jobs=max",
  ];
}

export async function buildElectronTreeSitterRuntime({ runCommand = run } = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Electron native build requires macOS arm64");
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
  if (packageJson.devDependencies?.electron !== electronVersion || packageJson.devDependencies?.["node-addon-api"] !== "8.5.0" || packageJson.overrides?.["node-addon-api"] !== "8.5.0") {
    throw new Error("Electron 42.1.0 and node-addon-api 8.5.0 package identities changed");
  }
  for (const packageName of packages) {
    const installed = JSON.parse(await readFile(path.join(repoRoot, "node_modules", packageName, "package.json"), "utf8"));
    const locked = lock.packages?.[`node_modules/${packageName}`];
    if (installed.version !== packageJson.dependencies?.[packageName] || locked?.version !== installed.version || typeof locked.integrity !== "string") {
      throw new Error(`Installed ${packageName} is not the exact lockfile dependency for Electron native build`);
    }
  }
  const environment = { ...process.env, npm_config_build_from_source: "true" };
  for (const key of ["npm_config_nodedir", "npm_config_disturl", "npm_config_runtime", "npm_config_target"]) delete environment[key];
  for (const packageName of packages) {
    await runCommand(process.execPath, electronNodeGypArguments(packageName), environment);
  }
  return { electron: electronVersion, modules: Number(electronAbi), packages };
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildElectronTreeSitterRuntime()));
}
