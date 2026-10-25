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
  it("names the place in the source, of itself or of the nearest written parent", async () => {
    const { win, got, send, flush } = setup(
      `<ul data-pl="site/index.html:7:3"><li data-pl="site/index.html:8:5">Капучино</li></ul>`,
    );
    const made = win.document.createElement("li");
    made.textContent = "Латте";
    win.document.querySelector("ul")!.append(made);
    const click = (el: Element) => {
      send({ source: "prsloy-host", type: "pick", active: true });
      el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
    };
    click(win.document.querySelector("li")!);
    click(made);
    await flush();
    const picks = got.filter((m) => m.type === "picked");
    expect(picks[0]).toMatchObject({ file: "site/index.html", line: 8, col: 5, exact: true });
    expect(picks[0]?.outerHTMLShort).toBe("<li>Капучино</li>");
    expect(picks[1]).toMatchObject({ file: "site/index.html", line: 7, col: 3, exact: false });
  });

  it("counts the same ones and shortens long fragments", async () => {
    const long = "очень длинный текст ".repeat(10);
    const { win, got, send, flush } = setup(
      `<p class="x">Цена</p><p class="x">Цена</p><p class="y">Цена</p><a href="${"h".repeat(80)}"><b>${long}</b></a>`,
    );
    send({ source: "prsloy-host", type: "pick", active: true });
    win.document
      .querySelectorAll("p")[1]!
      .dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
    send({ source: "prsloy-host", type: "pick", active: true });
    win.document
      .querySelector("a")!
      .dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
    const picks = got.filter((m) => m.type === "picked");
    expect(picks[0]).toMatchObject({ nth: 2, of: 2 });
    expect(picks[0]).not.toHaveProperty("file");
    expect(picks[1]?.outerHTMLShort).toBe(`<a href="${"h".repeat(40)}…">…</a>`);
    expect(picks[1]?.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

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
      outerHTMLShort: '<button class="cta">Записаться</button>',
      nth: 1,
      of: 1,
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
