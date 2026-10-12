import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export function writeFileAtomicSync(targetPath: string, data: Uint8Array | string, options: { readonly mode?: number } = {}): void {
  const directory = dirname(targetPath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(targetPath)}.${randomBytes(8).toString("hex")}.part`);
  const descriptor = openSync(temporaryPath, "wx", options.mode);
  let closed = false;
  try {
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    closed = true;
    renameSync(temporaryPath, targetPath);
  } catch (error) {
    if (!closed) { try { closeSync(descriptor); } catch {} }
    try { unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

export async function writeFileAtomic(targetPath: string, data: Uint8Array | string, options: { readonly mode?: number; readonly temporaryPathPrefix?: string } = {}): Promise<void> {
  const directory = dirname(targetPath);
  await mkdir(directory, { recursive: true });
  const prefix = options.temporaryPathPrefix ?? join(directory, `.${basename(targetPath)}`);
  const temporaryPath = `${prefix}.${randomBytes(8).toString("hex")}.part`;
  const handle = await open(temporaryPath, "wx", options.mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  await handle.close();
  try { await rename(temporaryPath, targetPath); }
  catch (error) { await unlink(temporaryPath).catch(() => {}); throw error; }
}
