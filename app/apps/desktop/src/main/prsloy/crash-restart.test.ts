import { describe, expect, it } from "vite-plus/test";
import { CRASH_RESTART_MAX, nextCrashRestart } from "./crash-restart.ts";

describe("crash restart policy", () => {
  it("restarts up to 3 times a minute, then stops; old crashes age out", () => {
    let history: number[] = [];
    for (let i = 0; i < CRASH_RESTART_MAX; i += 1) {
      const next = nextCrashRestart(history, 1_000 + i, {});
      expect(next).toBeDefined();
      history = next!;
    }
    expect(nextCrashRestart(history, 2_000, {})).toBeUndefined();
    expect(nextCrashRestart(history, 70_000, {})).toEqual([70_000]);
  });

  it("can be switched off", () => {
    expect(nextCrashRestart([], 0, { PRSLOY_NO_AUTO_RESTART: "1" })).toBeUndefined();
  });
});
