import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { defaultDataRoot, launchEnvironment, loadSettings, validateProvider } from "./local-launch-config.mjs";

export function initializeLocalPackage(env = process.env) {
  const root = env.SAND_DATA_ROOT || defaultDataRoot(env);
  const settings = loadSettings(root);
  const configured = launchEnvironment(root, env);
  validateProvider(settings, root, configured);
  mkdirSync(configured.SAND_USER_DATA_DIR, { recursive: true, mode: 0o700 });
  const settingsFile = path.join(root, "settings.json");
  if (!existsSync(settingsFile)) writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  Object.assign(env, configured);
  delete env.ELECTRON_RUN_AS_NODE;
  return root;
}
