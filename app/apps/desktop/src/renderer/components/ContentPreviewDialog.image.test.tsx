// @vitest-environment jsdom
/**
 * #74: the lightbox must show the picture, not the 160px composer thumbnail stretched to
 * ~100×100. Two things are pinned here: the dialog asks main for the full-size image when it
 * knows the file path, and it keeps the thumbnail as an instant fallback so it never opens blank.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
