import path from "node:path";
import { repoRoot, sourceAppDir, upstreamAsarSha256 } from "./config.mjs";

export const upstreamPlatforms = Object.freeze({
  "darwin-arm64": Object.freeze({
    platform: "darwin-arm64", sourceRoot: sourceAppDir, rendererRoot: "src/app/dist/renderer",
    asarSha256: upstreamAsarSha256,
  }),
  "win32-x64": Object.freeze({
    platform: "win32-x64", sourceRoot: path.join(repoRoot, ".cache/windows-runtime/app"),
    rendererRoot: ".cache/windows-runtime/app/dist/renderer",
    asarSha256: "38e85c0e5042c0257db7925e1e55709d6d155d90d92fe26ad654127d509766e0",
    installerUrl: "https://downloads.cursor.com/sand/stable/win32-x64/0.18.0/Grok_Bot_0.18.0_Setup.exe",
    installerSha256: "464079a15ef5fa8b61ccea8fffcc78f63cfcf6df65fb0ad5e725d8b95f7e437e",
    installerBytes: 125825552,
    referenceInventorySha256: "d7cbe61358a8dffc6082cb9ac5ff5fbe93b8dea6459180cf0752f6dd6553ad14",
  }),
});

export function upstreamPlatform(platform = "darwin-arm64") {
  const value = Object.hasOwn(upstreamPlatforms, platform) ? upstreamPlatforms[platform] : undefined;
  if (value === undefined) throw new Error(`Unsupported upstream artifact platform: ${platform}`);
  return value;
}
