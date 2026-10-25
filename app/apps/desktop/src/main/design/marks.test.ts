import { describe, expect, it } from "vite-plus/test";
import { blendBitmaps, MAX_MARKS_BYTES, marksName, marksPng } from "./marks.ts";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("marksPng", () => {
  it("takes a PNG of a sane size only", () => {
    const png = new Uint8Array([...PNG_HEAD, 1, 2, 3]);
    expect(marksPng(png)?.length).toBe(11);
    expect(marksPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeUndefined();
    expect(marksPng("data:image/png;base64,AAAA")).toBeUndefined();
    expect(marksPng(new Uint8Array(MAX_MARKS_BYTES + 1))).toBeUndefined();
  });
});

describe("blendBitmaps", () => {
  it("keeps the picture where nothing is drawn and the red where it is", () => {
    // BGRA, premultiplied: an opaque cream pixel, then the same under an opaque red stroke,
    // then under a half-transparent red edge
    const base = Buffer.from([225, 237, 244, 255, 225, 237, 244, 255, 225, 237, 244, 255]);
    const top = Buffer.from([0, 0, 0, 0, 28, 25, 229, 255, 14, 12, 114, 128]);
    expect([...blendBitmaps(base, top)]).toEqual([
      225, 237, 244, 255, 28, 25, 229, 255, 126, 130, 236, 255,
    ]);
  });

  it("refuses layers of different sizes", () => {
    expect(() => blendBitmaps(Buffer.alloc(8), Buffer.alloc(4))).toThrow();
  });
});

describe("marksName", () => {
  it("names the marks after the picture and the time", () => {
    expect(marksName("design/landing/01-candidates.png", new Date(2026, 9, 25, 15, 3, 7))).toBe(
      "marks-01-candidates-150307.png",
    );
    expect(marksName("a b/лист №1.png", new Date(2026, 9, 25, 9, 0, 0))).toBe(
      "marks-лист-1-090000.png",
    );
  });
});
