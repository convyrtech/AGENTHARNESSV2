import { describe, expect, it } from "vite-plus/test";
import { captureRect } from "./capture-rect.ts";

const view = { width: 1280, height: 800 };

describe("captureRect", () => {
  it("passes a plain selection through, rounded outwards", () => {
    expect(captureRect({ x: 10.4, y: 20.6, width: 100.2, height: 50 }, 1, view)).toEqual({
      x: 10,
      y: 20,
      width: 101,
      height: 51,
    });
  });

  it("applies the window zoom and stays inside the window", () => {
    expect(captureRect({ x: 100, y: 100, width: 200, height: 100 }, 1.25, view)).toEqual({
      x: 125,
      y: 125,
      width: 250,
      height: 125,
    });
    expect(captureRect({ x: -50, y: 700, width: 200, height: 400 }, 1, view)).toEqual({
      x: 0,
      y: 700,
      width: 150,
      height: 100,
    });
  });

  it("refuses junk and slips of the mouse", () => {
    expect(captureRect(null, 1, view)).toBeUndefined();
    expect(captureRect({ x: "1", y: 0, width: 50, height: 50 }, 1, view)).toBeUndefined();
    expect(captureRect({ x: 0, y: 0, width: Infinity, height: 50 }, 1, view)).toBeUndefined();
    expect(captureRect({ x: 0, y: 0, width: 4, height: 50 }, 1, view)).toBeUndefined();
    expect(captureRect({ x: 2000, y: 0, width: 50, height: 50 }, 1, view)).toBeUndefined();
  });
});
