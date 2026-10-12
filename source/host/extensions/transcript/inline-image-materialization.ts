import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { openCanonicalAttachmentFile, readAttachmentBytes } from "../attachments/attachment-file.js";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionFromImageMime } from "../../../shared/media/image-mime.js";
export interface InlineImage {
  base64: string;
  mediaType: string;
  alt?: string;
}
export async function materializeInlineImages(
  session: { dbPath: string },
  images: readonly InlineImage[],
): Promise<Array<{ url: string; alt?: string }>> {
  if (images.length === 0) return [];
  const dir = join(dirname(session.dbPath), "xuser-attachments"),
    materialized: Array<{ url: string; alt?: string }> = [];
  for (const image of images.slice(0, 4))
    try {
      const bytes = Buffer.from(image.base64, "base64");
      if (bytes.byteLength === 0) continue;
      const hash = createHash("sha256").update(bytes).digest("hex"),
        extension = extensionFromImageMime(image.mediaType) ?? ".png",
        filePath = join(dir, `${hash}${extension}`);
      mkdirSync(dir, { recursive: true });
      try { writeFileSync(filePath, bytes, { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // 仅复用内容完整一致的普通文件；POSIX 打开时额外拒绝末级符号链接。
        const handle = await openCanonicalAttachmentFile(filePath);
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size !== bytes.length) continue;
          const existing = await readAttachmentBytes(handle, info.size, bytes.length);
          if (existing == null || !existing.equals(bytes)) continue;
        } finally { await handle.close(); }
      }
      materialized.push({
        url: pathToFileURL(filePath).toString(),
        ...(image.alt != null ? { alt: image.alt } : {}),
      });
    } catch {}
  return materialized;
}
