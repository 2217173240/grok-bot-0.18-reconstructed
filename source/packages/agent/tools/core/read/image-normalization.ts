import sharp from "sharp";
import { getMinimalJimp } from "../../../../utils/jimp-minimal.js";
import { MAX_IMAGE_DIMENSION, resizeImageBufferIfNeeded } from "../../../../utils/image-resize.js";

export async function normalizeReadImage(bytes: Uint8Array, mimeType: string): Promise<Uint8Array> {
  let input: Buffer = Buffer.from(bytes);
  if (mimeType === "image/bmp" || mimeType === "image/x-ms-bmp") {
    const Jimp = await getMinimalJimp();
    input = await (await Jimp.read(input)).getBuffer("image/png");
  }
  const png = await sharp(input, { failOn: "warning" })
    .rotate()
    .resize({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb")
    .png()
    .toBuffer();
  return (await resizeImageBufferIfNeeded(png)).data;
}
