import { describe, expect, it } from "vite-plus/test";
import { dragRect, isSelection } from "./preview-capture.ts";

describe("preview capture frame", () => {
  it("is the same rectangle whichever way the mouse went", () => {
    const rect = { x: 10, y: 20, width: 90, height: 40 };
    expect(dragRect({ x: 10, y: 20 }, { x: 100, y: 60 })).toEqual(rect);
    expect(dragRect({ x: 100, y: 60 }, { x: 10, y: 20 })).toEqual(rect);
    expect(dragRect({ x: 100, y: 20 }, { x: 10, y: 60 })).toEqual(rect);
  });

  it("a click is not a selection", () => {
    expect(isSelection({ x: 0, y: 0, width: 3, height: 50 })).toBe(false);
    expect(isSelection({ x: 0, y: 0, width: 8, height: 8 })).toBe(true);
  });
});
