/**
 * The numbers behind the balance chip (#56): the warning line, the runway in turns, the age.
 */
import { describe, expect, it } from "vite-plus/test";
import type { PrsloyBalance } from "@zeno/contracts";
import {
  averageTurnRub,
  balanceAgeMinutes,
  balanceIsLow,
  INITIAL_TURN_WATCH,
  nextTurnWatch,
  turnsLeft,
} from "./prsloy-balance.ts";

const at = (remainingRub: number): PrsloyBalance => ({
  remainingRub,
  usedRub: 1000 - remainingRub,
  grantedRub: 1000,
  fetchedAt: "2026-10-29T10:00:00.000Z",
});

describe("balanceIsLow", () => {
  it("warns below the line, stays quiet above it and without a number", () => {
    expect(balanceIsLow(at(199.99), 200)).toBe(true);
    expect(balanceIsLow(at(200), 200)).toBe(false);
    expect(balanceIsLow(at(0), 0)).toBe(false);
    expect(balanceIsLow(undefined, 200)).toBe(false);
  });
});

describe("turnsLeft", () => {
  it("counts whole turns at the chat's own pace", () => {
    expect(turnsLeft(at(100), 3.4)).toBe(29);
    // An unknown or free pace predicts nothing rather than « infinity turns left».
    expect(turnsLeft(at(100), 0)).toBeUndefined();
    expect(turnsLeft(at(100), Number.NaN)).toBeUndefined();
    expect(turnsLeft(at(0), 5)).toBe(0);
  });
});

describe("balanceAgeMinutes", () => {
  it("says how old the number is", () => {
    const now = Date.parse("2026-10-29T10:20:00.000Z");
    expect(balanceAgeMinutes("2026-10-29T10:00:00.000Z", now)).toBe(20);
    // A clock ahead of the gateway's answer is never shown as a negative age.
    expect(balanceAgeMinutes("2026-10-29T10:00:00.000Z", now - 60_000 * 60)).toBe(0);
    expect(balanceAgeMinutes("not a date", now)).toBe(0);
  });
});

describe("nextTurnWatch", () => {
  it("measures the pace from the turns that actually finished", () => {
    let watch = nextTurnWatch(INITIAL_TURN_WATCH, {
      sessionKey: "s1",
      running: true,
      sessionRub: 10,
    });
    watch = nextTurnWatch(watch, { sessionKey: "s1", running: false, sessionRub: 13.5 });
    expect(watch.turns).toBe(1);
    expect(averageTurnRub(watch)).toBe(3.5);

    watch = nextTurnWatch(watch, { sessionKey: "s1", running: true, sessionRub: 13.5 });
    watch = nextTurnWatch(watch, { sessionKey: "s1", running: false, sessionRub: 16.5 });
    expect(watch.turns).toBe(2);
    expect(averageTurnRub(watch)).toBeCloseTo(3.25, 10);
  });

  it("does not count a turn that cost nothing and starts over in another chat", () => {
    let watch = nextTurnWatch(INITIAL_TURN_WATCH, {
      sessionKey: "s1",
      running: true,
      sessionRub: 5,
    });
    watch = nextTurnWatch(watch, { sessionKey: "s1", running: false, sessionRub: 5 });
    expect(watch.turns).toBe(0);
    expect(averageTurnRub(watch)).toBeUndefined();

    const other = nextTurnWatch(watch, { sessionKey: "s2", running: false, sessionRub: 40 });
    expect(other.sessionKey).toBe("s2");
    expect(other.turns).toBe(0);
    expect(other.totalRub).toBe(0);
  });
});
