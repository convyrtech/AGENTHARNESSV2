import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  registerAttachmentImageIpc,
  resolveAttachmentImagePath,
  type AttachmentImageIpc,
} from "./attachment-images.ts";

describe("full attachment preview", () => {
  it("does not follow a linked directory outside the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "prsloy-image-root-"));
    try {
      const workspace = join(root, "workspace");
      const outside = join(root, "outside");
      mkdirSync(workspace);
      mkdirSync(outside);
      writeFileSync(join(outside, "private.png"), "fixture");
      symlinkSync(outside, join(workspace, "link"), "junction");
      expect(
        resolveAttachmentImagePath(join(workspace, "link", "private.png"), [workspace]),
      ).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reduces an oversized original instead of returning the tiny thumbnail", async () => {
    const root = mkdtempSync(join(tmpdir(), "prsloy-image-"));
    try {
      const path = join(root, "screenshot.png");
      writeFileSync(path, "fixture");
      const small = {
        isEmpty: () => false,
        getSize: () => ({ width: 2800, height: 1400 }),
        resize: vi.fn(),
        toPNG: () => Buffer.from("resized"),
      };
      const image = {
        isEmpty: () => false,
        getSize: () => ({ width: 4000, height: 2000 }),
        resize: vi.fn(() => small),
        toPNG: () => Buffer.alloc(12_000_001),
      };
      const handlers = new Map<
        string,
        (event: never, filePath?: string) => Promise<string | undefined>
      >();
      registerAttachmentImageIpc({
        ipcMain: {
          handle: (channel, handler) => handlers.set(channel, handler),
        } as AttachmentImageIpc,
        nativeImage: { createFromPath: () => image } as never,
        attachmentsRoot: () => root,
        workspaceRoot: () => undefined,
        assertTrustedSender: () => undefined,
      });
      const url = await handlers.get("zeno:workspace:read-attachment-image")?.({} as never, path);
      expect(image.resize).toHaveBeenCalledWith({ width: 2800, height: 1400, quality: "best" });
      expect(url).toBe(`data:image/png;base64,${Buffer.from("resized").toString("base64")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
