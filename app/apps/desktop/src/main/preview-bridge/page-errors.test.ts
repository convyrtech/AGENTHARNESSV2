// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";
import script from "./page-errors.js?raw";

const listeners: ((event: MessageEvent) => void)[] = [];
afterEach(() => {
  for (const listener of listeners.splice(0)) window.removeEventListener("message", listener);
  document.body.innerHTML = "";
});

/** The app window with the preview page in a child frame running the error script. */
function setup() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const win = frame.contentWindow! as unknown as Window &
    typeof globalThis & { eval(code: string): unknown };
  const got: Record<string, unknown>[] = [];
  const listener = (event: MessageEvent) => got.push(event.data as never);
  listeners.push(listener);
  window.addEventListener("message", listener);
  win.eval(script);
  const flush = () => new Promise((done) => setTimeout(done, 0));
  return { win, got, flush };
}

describe("preview page errors", () => {
  it("reports a script error with its place, once", async () => {
    const { win, got, flush } = setup();
    const error = () =>
      new win.ErrorEvent("error", {
        message: "Uncaught TypeError: menu is null",
        filename: `${win.location.origin}/js/app.js`,
        lineno: 12,
        colno: 5,
      });
    win.dispatchEvent(error());
    win.dispatchEvent(error());
    await flush();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      source: "prsloy-preview",
      type: "error",
      kind: "script",
      message: "Uncaught TypeError: menu is null",
      line: 12,
      column: 5,
    });
  });

  it("skips the empty cross-origin «Script error.»", async () => {
    const { win, got, flush } = setup();
    win.dispatchEvent(new win.ErrorEvent("error", { message: "Script error." }));
    await flush();
    expect(got).toHaveLength(0);
  });

  it("reports a file that did not load", async () => {
    const { win, got, flush } = setup();
    const img = win.document.createElement("img");
    img.setAttribute("src", "/img/logo.png");
    win.document.body.append(img);
    img.dispatchEvent(new win.Event("error"));
    await flush();
    expect(got[0]).toMatchObject({
      kind: "resource",
      file: expect.stringMatching(/\/img\/logo\.png$/),
    });
  });

  it("reports rejected promises and the first five console.error calls", async () => {
    const { win, got, flush } = setup();
    const rejection = new win.Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new Error("нет сети");
    win.dispatchEvent(rejection);
    const quiet = (win as unknown as { console: Console }).console;
    for (let i = 0; i < 8; i++) quiet.error("сбой", i);
    await flush();
    expect(got[0]).toMatchObject({ kind: "promise", message: "Error: нет сети" });
    expect(got.filter((m) => m.kind === "console")).toHaveLength(5);
  });
});
