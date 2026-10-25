import { describe, expect, it } from "vite-plus/test";
import { closeCodePreview, getCodePreview, openCodePreview } from "./code-preview-store.ts";

describe("code preview store", () => {
  it("opens, reopens with a new nonce, and closes", () => {
    openCodePreview({ kind: "server", port: 5173 }, "/p");
    const first = getCodePreview();
    expect(first).toMatchObject({ target: { kind: "server", port: 5173 }, workspacePath: "/p" });
    openCodePreview({ kind: "server", port: 5173 }, "/p");
    expect(getCodePreview()?.nonce).toBeGreaterThan(first?.nonce ?? 0);
    closeCodePreview();
    expect(getCodePreview()).toBeNull();
  });
});
