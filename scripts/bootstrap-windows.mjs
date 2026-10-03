import { ensureWindowsRuntime } from "./lib/windows-runtime.mjs";

const reference = await ensureWindowsRuntime();
console.log(JSON.stringify({ platform: reference.platform, asarSha256: reference.asarSha256, verifiedNativeFiles: reference.nativeFiles, sourceRoot: reference.sourceRoot }));
