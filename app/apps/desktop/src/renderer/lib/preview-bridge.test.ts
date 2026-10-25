import { describe, expect, it } from "vite-plus/test";
import {
  addPageError,
  appendToDraft,
  type PageError,
  pageErrorLine,
  pageErrorsPrompt,
  parseBridgeMessage,
  pickCommand,
  pickedLabel,
  pickedPrompt,
} from "./preview-bridge.ts";

const picked = {
  source: "prsloy-preview",
  type: "picked",
  tag: "button",
  selector: "main > section:nth-of-type(2) > button",
  path: "main > section.hero > button.cta",
  text: "Записаться",
  outerHTMLShort: '<button class="cta">Записаться</button>',
  nth: 1,
  of: 1,
  rect: { x: 10.4, y: 20, width: 100, height: 40 },
  page: "/index.html",
};

describe("parseBridgeMessage", () => {
  it("accepts our messages and nothing else", () => {
    expect(parseBridgeMessage({ source: "prsloy-preview", type: "ready" })).toEqual({
      type: "ready",
    });
    expect(parseBridgeMessage(picked)).toMatchObject({ type: "picked", tag: "button" });
    expect(parseBridgeMessage({ ...picked, source: "other" })).toBeUndefined();
    expect(parseBridgeMessage({ source: "prsloy-preview", type: "eval" })).toBeUndefined();
    expect(parseBridgeMessage({ ...picked, selector: 42 })).toBeUndefined();
    expect(parseBridgeMessage("ready")).toBeUndefined();
    expect(parseBridgeMessage(null)).toBeUndefined();
  });

  it("clamps what a page sends", () => {
    const long = parseBridgeMessage({
      ...picked,
      text: "я".repeat(5000),
      outerHTMLShort: "<".repeat(5000),
      nth: 9,
      of: 3,
      rect: { x: "1", y: Infinity },
      file: "index.html",
      line: -4,
    });
    if (long?.type !== "picked") throw new Error("parse");
    expect(long.text.length).toBe(120);
    expect(long.outerHTMLShort.length).toBe(260);
    expect([long.nth, long.of]).toEqual([3, 3]);
    expect(long.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    // A file without a line is no place.
    expect(long.file).toBeUndefined();
  });

  it("keeps the place in the source and the box", () => {
    const at = parseBridgeMessage({ ...picked, file: "site/index.html", line: 12, col: 5 });
    expect(at).toMatchObject({
      file: "site/index.html",
      line: 12,
      col: 5,
      exact: true,
      rect: { x: 10, y: 20, width: 100, height: 40 },
    });
    expect(parseBridgeMessage({ ...picked, file: "a.html", line: 3, exact: false })).toMatchObject({
      exact: false,
    });
  });
});

describe("picked element in the composer", () => {
  const element = parseBridgeMessage(picked);
  if (element?.type !== "picked") throw new Error("parse");

  it("names the page, the exact place and ends with the question", () => {
    expect(pickedPrompt("ru", element)).toBe(
      [
        "[Место на странице index.html]",
        "Элемент: `main > section:nth-of-type(2) > button`",
        "Текст: Записаться",
        'Код: `<button class="cta">Записаться</button>`',
        "Что поменять здесь: ",
      ].join("\n"),
    );
  });

  it("drops an empty text line, keeps code spans whole, names the root page", () => {
    const out = pickedPrompt("ru", {
      ...element,
      text: "",
      outerHTMLShort: "<i>`x`</i>",
      page: "/",
    });
    expect(out).not.toContain("Текст:");
    expect(out).toContain("Код: `<i>'x'</i>`");
    expect(out).toContain("[Место на странице index.html]");
  });

  it("names the file and line, and which of the same ones", () => {
    expect(
      pickedPrompt("ru", { ...element, file: "site/index.html", line: 12, col: 5, nth: 2, of: 3 }),
    ).toBe(
      [
        "[Место на странице index.html]",
        "Файл: site/index.html, строка 12",
        "Элемент: `main > section:nth-of-type(2) > button`",
        "Текст: Записаться",
        'Код: `<button class="cta">Записаться</button>`',
        "Таких на странице 3, выбран 2-й",
        "Что поменять здесь: ",
      ].join("\n"),
    );
    expect(pickedPrompt("ru", { ...element, file: "a.html", line: 4, exact: false })).toContain(
      "Файл: a.html, строка 4 (элемент создал скрипт, это ближайший родитель)",
    );
  });

  it("labels by text, else by tag", () => {
    expect(pickedLabel(element)).toBe("«Записаться»");
    expect(pickedLabel({ ...element, text: "" })).toBe("<button>");
    expect(pickedLabel({ ...element, text: "a".repeat(60) })).toBe(`«${"a".repeat(40)}…»`);
  });

  it("goes after the draft", () => {
    expect(appendToDraft("", "B")).toBe("B");
    expect(appendToDraft("сделай синей  \n", "B")).toBe("сделай синей\n\nB");
  });

  it("the pick command is tagged as ours", () => {
    expect(pickCommand(true)).toEqual({ source: "prsloy-host", type: "pick", active: true });
  });
});

describe("page errors", () => {
  const script = {
    source: "prsloy-preview",
    type: "error",
    kind: "script",
    message: "Uncaught TypeError: menu is null",
    file: "/js/app.js",
    line: 12,
    column: 5,
    page: "/index.html",
  };

  it("parses our error messages and refuses odd ones", () => {
    expect(parseBridgeMessage(script)).toMatchObject({ type: "error", kind: "script", line: 12 });
    expect(parseBridgeMessage({ ...script, kind: "eval" })).toBeUndefined();
    expect(parseBridgeMessage({ ...script, message: "  " })).toBeUndefined();
    expect(parseBridgeMessage({ ...script, line: -1, column: "x" })).toMatchObject({
      line: 0,
      column: 0,
    });
  });

  it("keeps ten distinct errors", () => {
    const base = parseBridgeMessage(script) as PageError;
    let list: PageError[] = [];
    list = addPageError(list, base);
    list = addPageError(list, base);
    expect(list).toHaveLength(1);
    for (let i = 0; i < 20; i++) list = addPageError(list, { ...base, line: i + 100 });
    expect(list).toHaveLength(10);
  });

  it("says what and where, in plain words for a missing file", () => {
    const base = parseBridgeMessage(script) as PageError;
    expect(pageErrorLine("ru", base)).toBe("Uncaught TypeError: menu is null (/js/app.js:12:5)");
    expect(pageErrorLine("ru", { ...base, file: "" })).toBe("Uncaught TypeError: menu is null");
    expect(pageErrorLine("ru", { ...base, kind: "resource", file: "/img/logo.png" })).toBe(
      "не загрузился файл /img/logo.png",
    );
    expect(pageErrorsPrompt("ru", [base, { ...base, kind: "resource", file: "/a.css" }])).toBe(
      [
        "Исправь ошибки на странице index.html. Что показывает браузер:",
        "- Uncaught TypeError: menu is null (/js/app.js:12:5)",
        "- не загрузился файл /a.css",
      ].join("\n"),
    );
  });
});
