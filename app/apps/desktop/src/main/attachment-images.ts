/**
 * Local images for the composer thumbnail and the full-size lightbox (#74).
 *
 * Both routes share one path guard: only real image files inside the open workspace or the
 * clipboard attachment directory. The lightbox gets the original pixels; CSS alone scales it
 * to the window, so screenshot text is not lost to a second resize.
 */
import { existsSync, lstatSync } from "node:fs";
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
  const inside = roots.some((root) => {
    if (!root.trim()) return false;
    const base = resolve(root);
    return abs === base || abs.startsWith(base + sep);
  });
  if (!inside) return undefined;
  try {
    if (!lstatSync(abs).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return IMAGE_EXTENSIONS.has(abs.slice(abs.lastIndexOf(".")).toLowerCase()) ? abs : undefined;
}

function dataUrl(png: Buffer, maxBytes: number): string | undefined {
  if (!png.length || png.length > maxBytes) return undefined;
  return `data:image/png;base64,${png.toString("base64")}`;
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
      return dataUrl(image.toPNG(), 12_000_000);
    } catch {
      return undefined;
    }
  });
}
