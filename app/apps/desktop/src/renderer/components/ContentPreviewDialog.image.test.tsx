// @vitest-environment jsdom
/**
 * #74: the lightbox must show the picture, not the 160px composer thumbnail stretched to
 * ~100×100. Two things are pinned here: the dialog asks main for the full-size image when it
 * knows the file path, and it keeps the thumbnail as an instant fallback so it never opens blank.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ImagePreviewDialog } from "./ContentPreviewDialog.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubWorkspace(readAttachmentImage: (path: string) => Promise<string | undefined>) {
  vi.stubGlobal("zeno", {
    workspace: { readAttachmentImage },
  });
}

describe("ImagePreviewDialog (#74)", () => {
  it("loads the full-size image when the file path is known", async () => {
    const readAttachmentImage = vi.fn().mockResolvedValue("data:image/png;base64,FULL");
    stubWorkspace(readAttachmentImage);

    const { getByTestId } = render(
      <ImagePreviewDialog
        open
        onOpenChange={() => undefined}
        source="data:image/png;base64,THUMB"
        path="/tmp/shot.png"
        locale="ru"
      />,
    );

    expect(readAttachmentImage).toHaveBeenCalledWith("/tmp/shot.png");
    await waitFor(() => {
      const image = getByTestId("image-preview-dialog").querySelector("img");
      expect(image?.getAttribute("src")).toBe("data:image/png;base64,FULL");
    });
  });

  it("does not show the previous picture while the next one loads", async () => {
    stubWorkspace((path) =>
      Promise.resolve(path === "/tmp/one.png" ? "data:image/png;base64,ONE" : undefined),
    );
    const view = render(
      <ImagePreviewDialog
        open
        onOpenChange={() => undefined}
        source="data:image/png;base64,THUMB_ONE"
        path="/tmp/one.png"
        locale="ru"
      />,
    );
    await waitFor(() => {
      expect(
        view.getByTestId("image-preview-dialog").querySelector("img")?.getAttribute("src"),
      ).toBe("data:image/png;base64,ONE");
    });
    view.rerender(
      <ImagePreviewDialog
        open
        onOpenChange={() => undefined}
        source="data:image/png;base64,THUMB_TWO"
        path="/tmp/two.png"
        locale="ru"
      />,
    );
    expect(view.getByTestId("image-preview-dialog").querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,THUMB_TWO",
    );
  });

  it("closes with the existing accessible button", async () => {
    stubWorkspace(() => Promise.resolve(undefined));
    const onOpenChange = vi.fn();
    const { getByTestId } = render(
      <ImagePreviewDialog
        open
        onOpenChange={onOpenChange}
        source="data:image/png;base64,THUMB"
        locale="ru"
      />,
    );
    getByTestId("content-preview-close").click();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the thumbnail first and does not touch main when there is no path", () => {
    const readAttachmentImage = vi.fn();
    stubWorkspace(readAttachmentImage);

    const { getByTestId } = render(
      <ImagePreviewDialog
        open
        onOpenChange={() => undefined}
        source="data:image/png;base64,THUMB"
        locale="ru"
      />,
    );

    const image = getByTestId("image-preview-dialog").querySelector("img");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,THUMB");
    expect(readAttachmentImage).not.toHaveBeenCalled();
  });

  it("keeps the thumbnail when the full-size read fails", async () => {
    stubWorkspace(() => Promise.reject(new Error("unreadable")));

    const { getByTestId } = render(
      <ImagePreviewDialog
        open
        onOpenChange={() => undefined}
        source="data:image/png;base64,THUMB"
        path="/tmp/gone.png"
        locale="ru"
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    const image = getByTestId("image-preview-dialog").querySelector("img");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,THUMB");
  });
});
