import { describe, expect, it } from "vite-plus/test";
import {
  classifyCuaActionOutcome,
  cuaEffect,
  cuaTypeTextReadback,
} from "../src/cua-computer-use.ts";

describe("Cua action effect", () => {
  it("requires the driver's explicit confirmed effect", () => {
    expect(cuaEffect({ structuredContent: { effect: "confirmed", verified: true } })).toBe(
      "confirmed",
    );
    expect(cuaEffect({ structuredContent: { effect: "unverifiable", verified: false } })).toBe(
      "unknown",
    );
    // Cua 0.38's real Windows UIA read-back omits the optional verified field.
    expect(cuaEffect({ structuredContent: { effect: "confirmed" } })).toBe("confirmed");
    expect(cuaEffect({ structuredContent: { effect: "confirmed", verified: false } })).toBe(
      "unknown",
    );
    expect(cuaEffect({ structuredContent: { effect: "partial", verified: true } })).toBe("unknown");
    expect(cuaEffect({})).toBe("unknown");
  });

  it("rejects contradictory nested effect records", () => {
    expect(
      cuaEffect({
        structuredContent: {
          effect: "confirmed",
          verified: true,
          structuredContent: { effect: "partial" },
        },
      }),
    ).toBe("unknown");
  });

  it("recognizes only the 0.38 UIA ValuePattern read-back needed for type_text", () => {
    expect(
      cuaTypeTextReadback({
        structuredContent: {
          effect: "confirmed",
          evidence: [{ kind: "value_readback", detail: "confirmed" }],
        },
      }),
    ).toBe(true);
    expect(cuaTypeTextReadback({ structuredContent: { effect: "confirmed" } })).toBe(false);
    expect(
      cuaTypeTextReadback({
        structuredContent: {
          effect: "confirmed",
          evidence: [{ kind: "value_readback", detail: "unconfirmed" }],
        },
      }),
    ).toBe(false);
    expect(
      cuaTypeTextReadback({
        isError: true,
        structuredContent: {
          effect: "confirmed",
          evidence: [{ kind: "value_readback", detail: "confirmed" }],
        },
      }),
    ).toBe(false);
  });

  it("keeps a late result ambiguous without its live wrapper, after cancellation, or on error", () => {
    const result = {
      effect: "confirmed",
      evidence: [{ kind: "value_readback", detail: "confirmed" }],
    };
    expect(
      classifyCuaActionOutcome({
        name: "type_text",
        isError: false,
        hasActiveWrapper: true,
        signalAborted: false,
        result,
      }),
    ).toBe("confirmed_applied");
    expect(
      classifyCuaActionOutcome({
        name: "type_text",
        isError: false,
        hasActiveWrapper: false,
        signalAborted: false,
        result,
      }),
    ).toBe("ambiguous");
    expect(
      classifyCuaActionOutcome({
        name: "type_text",
        isError: false,
        hasActiveWrapper: true,
        signalAborted: true,
        result,
      }),
    ).toBe("ambiguous");
    expect(
      classifyCuaActionOutcome({
        name: "type_text",
        isError: true,
        hasActiveWrapper: true,
        signalAborted: false,
        result,
      }),
    ).toBe("ambiguous");
  });
});
