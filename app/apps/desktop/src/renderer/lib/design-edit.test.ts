import type { PreviewPick } from "@zeno/contracts";
import { describe, expect, it } from "vite-plus/test";
import { addPin, MAX_EDIT_PINS, parseTextMessage, pinsToSend } from "./design-edit.ts";

const pick = (selector: string, extra: Partial<PreviewPick> = {}): PreviewPick => ({
  selector,
  path: selector,
  tag: "h1",
  text: "Зерно",
  outerHTMLShort: "<h1>Зерно</h1>",
  nth: 1,
  of: 1,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  page: "/landing/",
  ...extra,
});

describe("addPin", () => {
  it("adds a new place once, up to the limit", () => {
    const one = addPin([], pick("main > h1"));
    expect(one).toEqual([{ pick: pick("main > h1"), request: "" }]);
    expect(addPin(one, pick("main > h1"))).toHaveLength(1);
    expect(addPin(one, pick("main > h1", { nth: 2, of: 2 }))).toHaveLength(2);
    let many = one;
    for (let i = 0; i < 20; i++) many = addPin(many, pick(`p:nth-of-type(${i + 1})`));
    expect(many).toHaveLength(MAX_EDIT_PINS);
  });
});

describe("pinsToSend", () => {
  it("keeps the place, trims the words, names the width", () => {
    const pins = [
      {
        pick: pick("main > h1", { file: "landing/index.html", line: 3, col: 5 }),
        request: " крупнее ",
      },
      { pick: pick("main > p"), request: "убрать" },
    ];
    expect(pinsToSend(pins, 390)).toEqual([
      {
        selector: "main > h1",
        nth: 1,
        of: 1,
        tag: "h1",
        text: "Зерно",
        outerHTMLShort: "<h1>Зерно</h1>",
        file: "landing/index.html",
        line: 3,
        request: "крупнее",
        width: 390,
      },
      {
        selector: "main > p",
        nth: 1,
        of: 1,
        tag: "h1",
        text: "Зерно",
        outerHTMLShort: "<h1>Зерно</h1>",
        request: "убрать",
        width: 390,
      },
    ]);
  });
});

describe("parseTextMessage", () => {
  const msg = (extra: object) => ({ source: "prsloy-design-text", ...extra });
  it("takes the text script's two messages, clamped", () => {
    expect(
      parseTextMessage(
        msg({
          type: "text-edit",
          file: "landing/index.html",
          line: 3,
          col: 5,
          before: "a",
          after: "b",
        }),
      ),
    ).toEqual({
      type: "text-edit",
      file: "landing/index.html",
      line: 3,
      col: 5,
      before: "a",
      after: "b",
    });
    expect(
      (
        parseTextMessage(
          msg({ type: "text-edit", file: "x", line: 1, col: 1, after: "y".repeat(9000) }),
        ) as {
          after: string;
        }
      ).after,
    ).toHaveLength(2001);
    expect(parseTextMessage(msg({ type: "text-refused", reason: "move" }))).toEqual({
      type: "text-refused",
      reason: "move",
    });
  });

  it("drops anything else", () => {
    expect(parseTextMessage(msg({ type: "text-refused", reason: "other" }))).toBeUndefined();
    expect(
      parseTextMessage(msg({ type: "text-edit", file: "x", line: 0, col: 1 })),
    ).toBeUndefined();
    expect(parseTextMessage({ source: "prsloy-preview", type: "text-edit" })).toBeUndefined();
    expect(parseTextMessage("x")).toBeUndefined();
  });
});
