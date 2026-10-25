import { describe, expect, it } from "vite-plus/test";
import {
  appendToDraft,
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
  html: '<button class="cta">Записаться</button>',
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
    const long = parseBridgeMessage({ ...picked, text: "я".repeat(5000), html: "<".repeat(5000) });
    expect(long?.type === "picked" && long.text.length).toBe(120);
    expect(long?.type === "picked" && long.html.length).toBe(310);
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
    const out = pickedPrompt("ru", { ...element, text: "", html: "<i>`x`</i>", page: "/" });
    expect(out).not.toContain("Текст:");
    expect(out).toContain("Код: `<i>'x'</i>`");
    expect(out).toContain("[Место на странице index.html]");
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
