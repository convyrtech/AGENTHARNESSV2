import { describe, expect, it } from "vite-plus/test";
import { formatRub, INITIAL_TURN_COST, nextTurnCost, type CostSample } from "./rub-cost.ts";

function run(samples: CostSample[]) {
  return samples.reduce(nextTurnCost, INITIAL_TURN_COST);
}

describe("nextTurnCost", () => {
  it("measures a turn as session-cost growth while it runs", () => {
    const state = run([
      { sessionKey: "a", running: false, sessionRub: 0.1 },
      { sessionKey: "a", running: true, sessionRub: 0.1 },
      { sessionKey: "a", running: true, sessionRub: 0.13 },
      { sessionKey: "a", running: false, sessionRub: 0.15 },
    ]);
    expect(state.turnRub).toBeCloseTo(0.05);
    expect(state.running).toBe(false);
  });

  it("keeps the last turn's cost after it ends and restarts on the next turn", () => {
    let state = run([
      { sessionKey: "a", running: true, sessionRub: 0 },
      { sessionKey: "a", running: false, sessionRub: 0.2 },
      { sessionKey: "a", running: false, sessionRub: 0.2 },
    ]);
    expect(state.turnRub).toBeCloseTo(0.2);
    state = nextTurnCost(state, { sessionKey: "a", running: true, sessionRub: 0.2 });
    expect(state.turnRub).toBe(0);
  });

  it("forgets turns when the session changes", () => {
    const state = run([
      { sessionKey: "a", running: true, sessionRub: 0 },
      { sessionKey: "a", running: false, sessionRub: 0.2 },
      { sessionKey: "b", running: false, sessionRub: 3 },
    ]);
    expect(state.turnRub).toBeUndefined();
    expect(state.sessionKey).toBe("b");
  });

  it("knows nothing about a turn already running when the session first appears", () => {
    const state = run([
      { sessionKey: "a", running: true, sessionRub: 1 },
      { sessionKey: "a", running: true, sessionRub: 1.5 },
    ]);
    expect(state.turnRub).toBeCloseTo(0.5);
  });

  it("ignores a missing cost and never goes negative", () => {
    let state = run([
      { sessionKey: "a", running: true, sessionRub: 1 },
      { sessionKey: "a", running: true, sessionRub: undefined },
    ]);
    expect(state.turnRub).toBe(0);
    state = nextTurnCost(state, { sessionKey: "a", running: false, sessionRub: 0.5 });
    expect(state.turnRub).toBe(0);
  });
});

/** Intl separates with no-break spaces; compare against plain ones. */
function rub(value: number, locale: "ru" | "en" = "ru") {
  return formatRub(value, locale).replace(/[\u00a0\u202f]/g, " ");
}

describe("formatRub", () => {
  it("shows kopecks under 100 ₽ and whole rubles above", () => {
    expect(rub(1.234)).toBe("1,23 ₽");
    expect(rub(1234.5)).toBe("1 235 ₽");
    expect(rub(0)).toBe("0,00 ₽");
  });

  it("marks dust instead of rounding it to zero", () => {
    expect(rub(0.004)).toBe("<0,01 ₽");
  });

  it("formats in the active locale", () => {
    expect(rub(1.5, "en")).toBe("₽1.50");
  });
});
