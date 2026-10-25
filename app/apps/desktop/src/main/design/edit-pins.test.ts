import { describe, expect, it } from "vite-plus/test";
import { editPayload, editPins, editSummary, MAX_PINS } from "./edit-pins.ts";

const pick = {
  selector: "main > h1",
  nth: 1,
  of: 1,
  tag: "h1",
  text: "Пиво с доставкой",
  outerHTMLShort: "<h1>Пиво с доставкой</h1>",
  file: "landing/index.html",
  line: 12,
  request: "крупнее",
  width: 1440,
};

describe("editPins", () => {
  it("keeps a well-formed pin", () => {
    expect(editPins([pick])).toEqual([pick]);
  });

  it("drops pins without a place or without the owner's words, and caps the list", () => {
    expect(editPins([{ ...pick, request: "  " }, { ...pick, selector: "" }, 3, null])).toEqual([]);
    expect(editPins(Array.from({ length: 30 }, () => pick))).toHaveLength(MAX_PINS);
    expect(editPins("x")).toEqual([]);
  });

  it("clamps numbers and strings", () => {
    const [p] = editPins([
      { ...pick, nth: 9, of: 3, width: 99_999, text: "x".repeat(500), line: 1.5 },
    ]);
    expect(p).toMatchObject({ nth: 3, of: 3, width: 2560 });
    expect(p!.text).toHaveLength(120);
    expect(p!.line).toBeUndefined();
  });

  it("keeps a file only inside site/", () => {
    for (const file of ["../secret.html", "/etc/passwd", "C:/x.html", "a//b.html", "a/../../b"]) {
      expect(editPins([{ ...pick, file }])[0]!.file).toBeUndefined();
    }
    expect(editPins([{ ...pick, file: "landing\\index.html" }])[0]!.file).toBe(
      "landing/index.html",
    );
  });
});

describe("editPayload / editSummary", () => {
  it("names the file from the workspace, without the tag", () => {
    expect(editPayload(editPins([pick]))).toEqual({
      pins: [
        {
          selector: "main > h1",
          nth: 1,
          of: 1,
          text: "Пиво с доставкой",
          outerHTMLShort: "<h1>Пиво с доставкой</h1>",
          file: "site/landing/index.html",
          line: 12,
          request: "крупнее",
          width: 1440,
        },
      ],
    });
  });

  it("says each place with the owner's words", () => {
    expect(editSummary(editPins([pick]))).toBe("«Пиво с доставкой» — крупнее");
    expect(editSummary(editPins([pick, { ...pick, text: "", request: "убрать" }]))).toBe(
      "1. «Пиво с доставкой» — крупнее\n2. <h1> — убрать",
    );
  });
});
