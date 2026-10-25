/**
 * Red marks on a picture in a «Дизайн» card (research/20 §10): the owner draws on the image viewer,
 * the renderer sends only its own stroke layer (a PNG of the picture's size), and main lays it over
 * the picture from the workspace. The renderer never reads the picture's pixels: it comes through the
 * `prsloy-design://` scheme, which a canvas could not export anyway.
 *
 * The result is `marks-<picture>-<time>.png`; run.py recognises the name, tells the agent that red is
 * the owner's marks and not design, and gives that turn to a model that sees.
 */
import { basename, extname } from "node:path";

export const MAX_MARKS_BYTES = 25 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes from the renderer when they are a PNG of a sane size; else undefined. */
export function marksPng(raw: unknown): Buffer | undefined {
  const bytes =
    raw instanceof Uint8Array ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : undefined;
  if (!bytes || bytes.length < PNG.length || bytes.length > MAX_MARKS_BYTES) return undefined;
  return bytes.subarray(0, PNG.length).equals(PNG) ? Buffer.from(bytes) : undefined;
}

/**
 * The stroke layer over the picture, both as premultiplied 32-bit bitmaps of the same size
 * (`nativeImage.toBitmap()`): out = top + base × (1 − top alpha), every channel.
 */
export function blendBitmaps(base: Buffer, top: Buffer): Buffer {
  if (base.length !== top.length) throw new Error("bitmaps of different sizes");
  const out = Buffer.allocUnsafe(base.length);
  for (let i = 0; i < base.length; i += 4) {
    const keep = 255 - top[i + 3]!;
    for (let c = 0; c < 4; c++) {
      out[i + c] = Math.min(255, top[i + c]! + Math.round((base[i + c]! * keep) / 255));
    }
  }
  return out;
}

/** `marks-01-candidates-153012.png` for `01-candidates.png` marked at 15:30:12. */
export function marksName(picture: string, now = new Date()): string {
  const stem =
    basename(picture, extname(picture))
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .slice(0, 60) || "picture";
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join("");
  return `marks-${stem}-${time}.png`;
}
