// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { closeCodePreview, openCodePreview } from "../lib/code-preview-store.ts";
import { CodePreviewPanel } from "./CodePreviewPanel.tsx";

const open = vi.fn();
const openExternal = vi.fn();

beforeEach(() => {
  open.mockReset();
  openExternal.mockReset().mockResolvedValue(true);
  (window as unknown as { zeno: unknown }).zeno = { codePreview: { open, openExternal } };
});
afterEach(() => {
  act(() => closeCodePreview());
  cleanup();
});

describe("CodePreviewPanel", () => {
  it("stays hidden until a turn opens a preview", () => {
    render(<CodePreviewPanel locale="ru" sessionKey="s1" />);
    expect(screen.queryByTestId("code-preview-panel")).toBeNull();
  });

  it("shows the page in a sandboxed frame, reloads and opens it in the browser", async () => {
    open.mockResolvedValue({ ok: true, url: "http://127.0.0.1:41000/site/index.html" });
    render(<CodePreviewPanel locale="ru" sessionKey="s1" />);
    const target = { kind: "file" as const, path: "site/index.html" };
    act(() => openCodePreview(target, "/home/u/vizitka"));
    const frame = (await screen.findByTestId("code-preview-frame")) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("http://127.0.0.1:41000/site/index.html");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
    expect(frame.getAttribute("sandbox")).not.toMatch(/allow-top-navigation|allow-popups/);
    expect(open).toHaveBeenCalledWith(target, "/home/u/vizitka");
    expect(screen.getByText("index.html")).toBeTruthy();

    fireEvent.click(screen.getByTestId("code-preview-device-phone"));
    expect(frame.closest("[data-device]")?.getAttribute("data-device")).toBe("phone");

    fireEvent.click(screen.getByTestId("code-preview-reload"));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByTestId("code-preview-external"));
    expect(openExternal).toHaveBeenCalledWith(target, "/home/u/vizitka");

    fireEvent.click(screen.getByTestId("code-preview-close"));
    expect(screen.queryByTestId("code-preview-panel")).toBeNull();
  });

  it("says plainly when the server is down", async () => {
    open.mockResolvedValue({ ok: false, reason: "down" });
    render(<CodePreviewPanel locale="ru" sessionKey="s1" />);
    act(() => openCodePreview({ kind: "server", port: 5173 }, "/p"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Сервер не отвечает. Попросите агента запустить его снова.",
    );
    expect(screen.queryByTestId("code-preview-frame")).toBeNull();
  });

  it("closes when the chat changes", async () => {
    open.mockResolvedValue({ ok: true, url: "http://127.0.0.1:5173/" });
    const { rerender } = render(<CodePreviewPanel locale="ru" sessionKey="s1" />);
    act(() => openCodePreview({ kind: "server", port: 5173 }, "/p"));
    await screen.findByTestId("code-preview-frame");
    rerender(<CodePreviewPanel locale="ru" sessionKey="s2" />);
    expect(screen.queryByTestId("code-preview-panel")).toBeNull();
  });
});
