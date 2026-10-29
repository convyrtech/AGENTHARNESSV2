/**
 * Local images for the composer thumbnail and the full-size lightbox (#74).
 *
 * Both routes share one path guard: only real image files inside the open workspace or the
 * clipboard attachment directory. The lightbox keeps the original pixels when they fit;
 * exceptionally large images are reduced until the IPC payload fits.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { IpcMainInvokeEvent } from "electron";

export type AttachmentImageNative = {
  createFromPath(path: string): {
    isEmpty(): boolean;
    getSize(): { width: number; height: number };
    resize(options: {
      width: number;
      height: number;
      quality: "good" | "best";
    }): ReturnType<AttachmentImageNative["createFromPath"]>;
    toPNG(): Buffer;
  };
};

export type AttachmentImageIpc = {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, path?: string) => Promise<string | undefined>,
  ): void;
};

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
  ".avif",
]);

export function resolveAttachmentImagePath(
  filePath: string | undefined,
  roots: readonly string[],
): string | undefined {
  if (typeof filePath !== "string" || !filePath.trim()) return undefined;
  const abs = resolve(filePath);
  if (!existsSync(abs)) return undefined;
  try {
    if (!lstatSync(abs).isFile()) return undefined;
    const actual = realpathSync(abs);
    const inside = roots.some((root) => {
      if (!root.trim()) return false;
      try {
        const base = realpathSync(resolve(root));
        return actual === base || actual.startsWith(base + sep);
      } catch {
        return false;
      }
    });
    if (!inside) return undefined;
  } catch {
    return undefined;
  }
  return IMAGE_EXTENSIONS.has(abs.slice(abs.lastIndexOf(".")).toLowerCase()) ? abs : undefined;
}

function dataUrl(png: Buffer, maxBytes: number): string | undefined {
  if (!png.length || png.length > maxBytes) return undefined;
  return `data:image/png;base64,${png.toString("base64")}`;
}

const MAX_FULL_IMAGE_BYTES = 12_000_000;

/** Keep the original when possible; shrink oversized PNGs rather than show a 160px thumbnail. */
function fullImageDataUrl(
  image: ReturnType<AttachmentImageNative["createFromPath"]>,
): string | undefined {
  let out = image;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const png = out.toPNG();
    const url = dataUrl(png, MAX_FULL_IMAGE_BYTES);
    if (url || !png.length) return url;
    const { width, height } = out.getSize();
    if (width <= 1 && height <= 1) return undefined;
    out = out.resize({
      width: Math.max(1, Math.floor(width * 0.7)),
      height: Math.max(1, Math.floor(height * 0.7)),
      quality: "best",
    });
  }
  return undefined;
}

export function registerAttachmentImageIpc(options: {
  ipcMain: AttachmentImageIpc;
  nativeImage: AttachmentImageNative;
  attachmentsRoot(): string;
  workspaceRoot(): string | undefined;
  assertTrustedSender(event: IpcMainInvokeEvent): void;
}): void {
  const resolvePath = (filePath?: string) =>
    resolveAttachmentImagePath(
      filePath,
      [options.attachmentsRoot(), options.workspaceRoot() ?? ""].filter(Boolean),
    );

  options.ipcMain.handle("zeno:workspace:read-attachment-preview", async (event, filePath) => {
    options.assertTrustedSender(event);
    const abs = resolvePath(filePath);
    if (!abs) return undefined;
    try {
      const image = options.nativeImage.createFromPath(abs);
      if (image.isEmpty()) return undefined;
      const { width, height } = image.getSize();
      const maxEdge = 160;
      let out = image;
      if (width > maxEdge || height > maxEdge) {
        const scale = Math.min(maxEdge / Math.max(width, 1), maxEdge / Math.max(height, 1));
        out = image.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: "good",
        });
      }
      return dataUrl(out.toPNG(), 1_500_000);
    } catch {
      return undefined;
    }
  });

  options.ipcMain.handle("zeno:workspace:read-attachment-image", async (event, filePath) => {
    options.assertTrustedSender(event);
    const abs = resolvePath(filePath);
    if (!abs) return undefined;
    try {
      const image = options.nativeImage.createFromPath(abs);
      if (image.isEmpty()) return undefined;
      return fullImageDataUrl(image);
    } catch {
      return undefined;
    }
  });
}
