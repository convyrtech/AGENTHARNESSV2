import { describe, expect, it } from "vite-plus/test";
import {
  doingKey,
  isSilent,
  remaining,
  remainingKey,
  SILENCE_MS,
  STEP_TYPICAL_MINUTES,
} from "./design-progress.ts";

describe("design progress", () => {
  it("has a typical length for each of the eight steps (from the real run)", () => {
    expect(STEP_TYPICAL_MINUTES).toHaveLength(8);
    expect(STEP_TYPICAL_MINUTES[6]).toBe(79);
  });

  it("says roughly how long the step has left, never a made-up number past it", () => {
    expect(remaining(7, 12 * 60_000)).toEqual({ kind: "minutes", n: 67 });
    expect(remaining(2, 2 * 60_000)).toEqual({ kind: "aboutOne" });
    expect(remaining(2, 4 * 60_000)).toEqual({ kind: "over" });
    expect(remaining(9, 0)).toBeUndefined();
    expect(remainingKey({ kind: "minutes", n: 3 })).toBe("design.progress.left");
    expect(remainingKey({ kind: "over" })).toBe("design.progress.over");
  });

  it("names what each gate does, with a fallback", () => {
    expect(doingKey("7")).toBe("design.doing.check");
    expect(doingKey("6")).toBe("design.doing.build");
    expect(doingKey("0a")).toBe("design.doing.start");
    expect(doingKey("x")).toBe("design.progress.working");
    expect(doingKey(undefined)).toBe("design.progress.working");
  });

  it("calls a gap of more than three minutes a silence", () => {
    expect(isSilent(undefined, 10_000_000)).toBe(false);
    expect(isSilent(1_000_000, 1_000_000 + SILENCE_MS)).toBe(false);
    expect(isSilent(1_000_000, 1_000_000 + SILENCE_MS + 1)).toBe(true);
  });
});
