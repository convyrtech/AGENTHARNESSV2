// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";
import script from "./inspector.js?raw";

afterEach(() => {
  document.body.innerHTML = "";
});

/** The app window with the preview page in a child frame running the inspector. */
function setup(body: string) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const win = frame.contentWindow! as unknown as Window &
    typeof globalThis & { eval(code: string): unknown };
  win.document.open();
  win.document.write(`<!doctype html><html><head></head><body>${body}</body></html>`);
  win.document.close();
  const got: Record<string, unknown>[] = [];
  window.addEventListener("message", (event: MessageEvent) => got.push(event.data as never));
  win.eval(script);
  const send = (data: unknown) =>
    win.dispatchEvent(new win.MessageEvent("message", { data, source: win.parent as never }));
  const flush = () => new Promise((done) => setTimeout(done, 0));
  return { win, got, send, flush };
}

describe("preview inspector", () => {
  it("says it is ready, then reports the clicked element with an exact path", async () => {
    const { win, got, send, flush } = setup(
      `<main><section class="hero big"><p>Раз</p><button class="cta">Записаться</button><button>Два</button></section></main>`,
    );
    await flush();
    expect(got[0]).toMatchObject({ source: "prsloy-preview", type: "ready" });
    send({ source: "prsloy-host", type: "pick", active: true });
    const button = win.document.querySelector(".cta")!;
    button.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true }));
    expect(button.classList.contains("prsloy-pick-highlight")).toBe(true);
    button.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
    const picked = got.find((m) => m.type === "picked")!;
    expect(picked).toMatchObject({
      tag: "button",
      text: "Записаться",
      html: '<button class="cta">Записаться</button>',
      path: "main > section.hero > button.cta",
    });
    expect(win.document.querySelector(picked.selector as string)).toBe(button);
    // One pick per press: the page works normally again.
    expect(win.document.documentElement.classList.contains("prsloy-pick-active")).toBe(false);
    expect(button.classList.contains("prsloy-pick-highlight")).toBe(false);
  });

  it("uses a unique id and stops at it", async () => {
    const { win, got, send, flush } = setup(`<div id="price"><span>1 000 ₽</span></div>`);
    send({ source: "prsloy-host", type: "pick", active: true });
    win.document
      .querySelector("span")!
      .dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
    expect(got.find((m) => m.type === "picked")).toMatchObject({ selector: "#price > span" });
  });

  it("ignores clicks when off, messages from others, and cancels on Esc", async () => {
    const { win, got, send, flush } = setup(`<a href="#x">ссылка</a>`);
    win.dispatchEvent(
      new win.MessageEvent("message", {
        data: { source: "prsloy-host", type: "pick", active: true },
      }),
    );
    win.document.querySelector("a")!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    send({ source: "other", type: "pick", active: true });
    await flush();
    expect(got.some((m) => m.type === "picked")).toBe(false);
    send({ source: "prsloy-host", type: "pick", active: true });
    win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    await flush();
    expect(got.at(-1)).toMatchObject({ type: "pick-cancel" });
    expect(win.document.documentElement.classList.contains("prsloy-pick-active")).toBe(false);
  });
});
