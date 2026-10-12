import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";

export class InvalidCodexCredentialsFileError extends Error {
  constructor() {
    super("Codex login credentials must be a private direct regular file.");
  }
}

// 调用方必须从返回的 fd 读取，并在 finally 中关闭。
export function openCodexCredentialsFile(path: string): number {
  // Windows 的 Node/libuv 没有 O_NOFOLLOW，使用打开前后的文件身份校验。
  const before = process.platform === "win32" ? lstatSync(path) : undefined;
  if (before && (!before.isFile() || before.isSymbolicLink())) throw new InvalidCodexCredentialsFileError();
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP" || (error as NodeJS.ErrnoException).code === "EMLINK") {
      throw new InvalidCodexCredentialsFileError();
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0
      || (before && (before.dev !== stat.dev || before.ino !== stat.ino))) {
      throw new InvalidCodexCredentialsFileError();
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
