// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";
import { installOverlayScroll, updateOverlayThumb } from "./overlay-scroll.ts";

describe("overlay-scroll thumb ↔ host", () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    document.body.innerHTML = "";
  });

  it("hovering a thumb finds its scrollport and pins it", () => {
    uninstall = installOverlayScroll();
    const host = document.createElement("div");
    host.className = "zeno-scroll";
    document.body.appendChild(host);
    updateOverlayThumb(host, true);
    const thumb = document.querySelector<HTMLElement>(
      `.zeno-scroll-thumb[data-for="${host.dataset.pixScrollId}"]`,
    );
    expect(thumb).toBeTruthy();
    thumb!.dispatchEvent(new Event("pointerover", { bubbles: true }));
    expect(thumb!.dataset.hovered).toBe("true");
    thumb!.dispatchEvent(new Event("pointerout", { bubbles: true }));
    expect(thumb!.dataset.hovered).toBeUndefined();
  });
});
