// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { closeCodePreview, openCodePreview } from "../lib/code-preview-store.ts";
import { useShellStore } from "../store/shell-store.ts";
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

describe("CodePreviewPanel: «Выбрать на странице»", () => {
  const URL_ = "http://127.0.0.1:41000/index.html";

  async function openWithBridge() {
    open.mockResolvedValue({ ok: true, url: URL_ });
    const composerRef = { current: document.createElement("textarea") };
    render(<CodePreviewPanel locale="ru" sessionKey="s1" composerRef={composerRef} />);
    act(() => openCodePreview({ kind: "file", path: "index.html" }, "/p"));
    const frame = (await screen.findByTestId("code-preview-frame")) as HTMLIFrameElement;
    const posted: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((m: unknown) => {
      posted.push(m);
    });
    const say = (data: unknown, origin = "http://127.0.0.1:41000", source = frame.contentWindow) =>
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
      });
    return { frame, posted, say };
  }

  it("shows no button until the page's script answers (an agent's server never does)", async () => {
    const { say } = await openWithBridge();
    expect(screen.queryByTestId("code-preview-pick")).toBeNull();
    // Another origin or another window cannot switch it on.
    say({ source: "prsloy-preview", type: "ready" }, "http://127.0.0.1:9");
    say({ source: "prsloy-preview", type: "ready" }, "http://127.0.0.1:41000", window);
    expect(screen.queryByTestId("code-preview-pick")).toBeNull();
    say({ source: "prsloy-preview", type: "ready" });
    expect(screen.getByTestId("code-preview-pick").textContent).toBe("Выбрать на странице");
  });

  it("turns picking on in the frame and puts the picked place into the composer", async () => {
    const { posted, say } = await openWithBridge();
    act(() => useShellStore.getState().setPrompt("сделай так"));
    say({ source: "prsloy-preview", type: "ready" });
    fireEvent.click(screen.getByTestId("code-preview-pick"));
    expect(posted.at(-1)).toEqual({ source: "prsloy-host", type: "pick", active: true });
    expect(screen.getByTestId("code-preview-pick").getAttribute("aria-pressed")).toBe("true");
    say({
      source: "prsloy-preview",
      type: "picked",
      tag: "button",
      selector: "body > button",
      path: "button.cta",
      text: "Записаться",
      html: "<button>Записаться</button>",
      page: "/index.html",
    });
    const draft = useShellStore.getState().prompt;
    expect(draft.startsWith("сделай так\n\n[Место на странице index.html]")).toBe(true);
    expect(draft.endsWith("Что поменять здесь: ")).toBe(true);
    expect(screen.getByTestId("code-preview-pick-note").textContent).toBe(
      "Выбрано: «Записаться». Напишите внизу, что поменять.",
    );
    expect(posted.at(-1)).toEqual({ source: "prsloy-host", type: "pick", active: false });
  });

  it("Esc in the app cancels picking", async () => {
    const { say } = await openWithBridge();
    say({ source: "prsloy-preview", type: "ready" });
    fireEvent.click(screen.getByTestId("code-preview-pick"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("code-preview-pick").getAttribute("aria-pressed")).toBe("false");
  });
});
