import { constants, type Stats } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isPathWithin, realpathNearestExisting } from "../../../shared/node/paths.js";

// 对规范路径本身校验边界；配置的根目录也可能是符号链接，例如 macOS /var。
export async function resolveAttachmentFile(path: string, roots: readonly string[] | null): Promise<string | null> {
  if (!path || !isAbsolute(path)) return null;
  const absolute = resolve(path);
  if (roots != null && !roots.some((root) => isPathWithin(root, absolute))) return null;
  const canonical = await realpath(absolute);
  if (roots != null) {
    const realRoots = await Promise.all(roots.map((root) => realpathNearestExisting(root)));
    if (!realRoots.some((root) => isPathWithin(root, canonical))) return null;
  }
  return canonical;
}

// 类型、大小检查和读取使用同一文件句柄，POSIX O_NOFOLLOW 拒绝末级链接替换。
// 此处不保证祖先目录在并发替换时保持不变。
export async function withAttachmentFile<T>(
  path: string,
  roots: readonly string[] | null,
  read: (handle: FileHandle, info: Stats) => Promise<T>,
): Promise<T | null> {
  const canonical = await resolveAttachmentFile(path, roots);
  if (canonical == null) return null;
  const handle = await openCanonicalAttachmentFile(canonical);
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    return await read(handle, info);
  } finally { await handle.close(); }
}

export async function openCanonicalAttachmentFile(canonical: string): Promise<FileHandle> {
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  return await open(canonical, flags);
}

// 固定缓冲区和读取范围，防止追加数据突破已检查的大小上限。
export async function readAttachmentRange(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let used = 0;
  while (used < length) {
    const { bytesRead } = await handle.read(buffer, used, length - used, position + used);
    if (bytesRead === 0) break;
    used += bytesRead;
  }
  return buffer.subarray(0, used);
}

export async function readAttachmentBytes(handle: FileHandle, size: number, limit: number): Promise<Buffer | null> {
  if (size > limit) return null;
  return await readAttachmentRange(handle, 0, Math.min(size, limit));
}
