import { describe, expect, it } from "vite-plus/test";
import { findHostForRuntime } from "./extension-ui-routing.ts";

type FakeHost = { id: string; ignoreMessages: boolean };

const foreground: FakeHost = { id: "fg", ignoreMessages: false };
const parked: FakeHost = { id: "parked-1", ignoreMessages: false };

function parkedEntry(host: FakeHost, runtimeId: string) {
  return { host, snapshot: { runtimeId } };
}

describe("findHostForRuntime", () => {
  it("finds the foreground host that owns the runtime", () => {
    expect(
      findHostForRuntime({
        foreground: { runtimeId: "rt-fg", host: foreground },
        parked: [],
        runtimeId: "rt-fg",
      }),
    ).toBe(foreground);
  });

  it("answers a background chat after the user switched away (#83)", () => {
    // The open chat is rt-fg, but the question came from rt-parked. Before the fix the
    // answer was rejected as «stale» and that agent waited forever.
    expect(
      findHostForRuntime({
        foreground: { runtimeId: "rt-fg", host: foreground },
        parked: [parkedEntry(parked, "rt-parked")],
        runtimeId: "rt-parked",
      }),
    ).toBe(parked);
  });

  it("returns nothing for a runtime that is already gone", () => {
    expect(
      findHostForRuntime({
        foreground: { runtimeId: "rt-fg", host: foreground },
        parked: [parkedEntry(parked, "rt-parked")],
        runtimeId: "rt-dead",
      }),
    ).toBeUndefined();
  });

  it("works with no foreground host at all", () => {
    expect(
      findHostForRuntime<FakeHost>({
        parked: [parkedEntry(parked, "rt-parked")],
        runtimeId: "rt-parked",
      }),
    ).toBe(parked);
  });
});
