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

  async function openWithBridge(onSend = vi.fn()) {
    open.mockResolvedValue({ ok: true, url: URL_ });
    const composerRef = { current: document.createElement("textarea") };
    render(
      <CodePreviewPanel locale="ru" sessionKey="s1" composerRef={composerRef} onSend={onSend} />,
    );
    act(() => openCodePreview({ kind: "file", path: "index.html" }, "/p"));
    const frame = (await screen.findByTestId("code-preview-frame")) as HTMLIFrameElement;
    // The frame's message listener is a passive effect: let it attach before the page talks.
    await act(async () => {});
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

describe("CodePreviewPanel: «На странице ошибка → Починить»", () => {
  const error = {
    source: "prsloy-preview",
    type: "error",
    kind: "script",
    message: "Uncaught ReferenceError: price is not defined",
    file: "/app.js",
    line: 3,
    column: 1,
    page: "/index.html",
  };

  async function openPage(onSend = vi.fn()) {
    open.mockResolvedValue({ ok: true, url: "http://127.0.0.1:41000/index.html" });
    render(<CodePreviewPanel locale="ru" sessionKey="s1" onSend={onSend} />);
    act(() => openCodePreview({ kind: "file", path: "index.html" }, "/p"));
    const frame = (await screen.findByTestId("code-preview-frame")) as HTMLIFrameElement;
    await act(async () => {});
    const say = (data: unknown, origin = "http://127.0.0.1:41000") =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", { data, origin, source: frame.contentWindow }),
        );
      });
    return { say, onSend };
  }

  it("shows the error and «Починить» sends it with its place, only on click", async () => {
    const { say, onSend } = await openPage();
    expect(screen.queryByTestId("code-preview-errors")).toBeNull();
    say(error, "http://127.0.0.1:9");
    expect(screen.queryByTestId("code-preview-errors")).toBeNull();
    say(error);
    const banner = screen.getByTestId("code-preview-errors");
    expect(banner.textContent).toContain("На странице ошибка");
    expect(banner.textContent).toContain("price is not defined (/app.js:3:1)");
    expect(onSend).not.toHaveBeenCalled();
    say({ ...error, kind: "resource", file: "/logo.png" });
    expect(banner.textContent).toContain("Ошибок на странице: 2");
    fireEvent.click(screen.getByTestId("code-preview-fix"));
    expect(onSend).toHaveBeenCalledWith(
      [
        "Исправь ошибки на странице index.html. Что показывает браузер:",
        "- Uncaught ReferenceError: price is not defined (/app.js:3:1)",
        "- не загрузился файл /logo.png",
      ].join("\n"),
    );
    expect(screen.queryByTestId("code-preview-errors")).toBeNull();
  });

  it("«Скрыть» hides it; «Обновить» starts clean", async () => {
    const { say } = await openPage();
    say(error);
    fireEvent.click(screen.getByTestId("code-preview-errors-hide"));
    expect(screen.queryByTestId("code-preview-errors")).toBeNull();
    fireEvent.click(screen.getByTestId("code-preview-reload"));
    await screen.findByTestId("code-preview-frame");
    expect(screen.queryByTestId("code-preview-errors")).toBeNull();
  });
});

describe("CodePreviewPanel: «Снять часть страницы»", () => {
  it("draws a frame over the page and attaches the snapshot", async () => {
    const capturePreview = vi.fn().mockResolvedValue({ ok: true, path: "/tmp/preview-1.png" });
    (window as unknown as { zeno: { features: unknown } }).zeno.features = { capturePreview };
    open.mockResolvedValue({ ok: true, url: "http://127.0.0.1:41000/index.html" });
    const onAttach = vi.fn();
    render(<CodePreviewPanel locale="ru" sessionKey="s1" onAttach={onAttach} />);
    act(() => openCodePreview({ kind: "file", path: "index.html" }, "/p"));
    await screen.findByTestId("code-preview-frame");
    fireEvent.click(screen.getByTestId("code-preview-capture"));
    const layer = screen.getByTestId("code-preview-capture-layer");
    expect(layer.textContent).toBe("Обведите рамкой нужное место. Esc — отмена.");
    // A click is not a selection: nothing is taken.
    fireEvent.pointerDown(layer, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(layer, { clientX: 12, clientY: 11 });
    expect(capturePreview).not.toHaveBeenCalled();
    fireEvent.pointerDown(layer, { clientX: 120, clientY: 90 });
    fireEvent.pointerMove(layer, { clientX: 40, clientY: 30 });
    fireEvent.pointerUp(layer, { clientX: 20, clientY: 10 });
    expect(screen.queryByTestId("code-preview-capture-layer")).toBeNull();
    await waitFor(() =>
      expect(capturePreview).toHaveBeenCalledWith({ x: 20, y: 10, width: 100, height: 80 }),
    );
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith(["/tmp/preview-1.png"]));
    expect(screen.getByTestId("code-preview-zip-note").textContent).toBe(
      "Снимок добавлен к сообщению.",
    );
  });

  it("Esc cancels the frame", async () => {
    (window as unknown as { zeno: { features: unknown } }).zeno.features = {
      capturePreview: vi.fn(),
    };
    open.mockResolvedValue({ ok: true, url: "http://127.0.0.1:41000/index.html" });
    render(<CodePreviewPanel locale="ru" sessionKey="s1" onAttach={vi.fn()} />);
    act(() => openCodePreview({ kind: "file", path: "index.html" }, "/p"));
    await screen.findByTestId("code-preview-frame");
    fireEvent.click(screen.getByTestId("code-preview-capture"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("code-preview-capture-layer")).toBeNull();
  });
});
