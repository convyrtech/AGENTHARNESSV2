import { describe, expect, it } from "vite-plus/test";
import {
  harnessBodyKey,
  harnessCardKind,
  harnessOffersRetry,
  harnessTitleKey,
  isHarnessData,
} from "./harness-card.ts";

describe("harness cards", () => {
  it("knows the harness's card types and nothing else", () => {
    expect(harnessCardKind("prsloy-harness.budget")).toBe("budget");
    expect(harnessCardKind("prsloy-harness.stop-gate")).toBe("stopGate");
    expect(harnessCardKind("prsloy-harness.tool-leak")).toBe("toolLeak");
    expect(harnessCardKind("prsloy-harness")).toBe("note");
    expect(harnessCardKind("some-extension")).toBeUndefined();
    expect(harnessCardKind(undefined)).toBeUndefined();
  });

  it("hides data-only entries", () => {
    expect(isHarnessData('```json\n{"toolCalls":31}\n```')).toBe(true);
    expect(isHarnessData('{"toolCalls":31}')).toBe(true);
    expect(isHarnessData("Задача остановлена: исчерпан лимит")).toBe(false);
  });

  it("gives each kind a title, a line and retry only where the text asks for it", () => {
    expect(harnessTitleKey("budget")).toBe("harness.budget.title");
    expect(harnessBodyKey("stopGate")).toBe("harness.stopGate.body");
    expect(harnessBodyKey("note")).toBeUndefined();
    expect(harnessOffersRetry("toolLeak")).toBe(true);
    expect(harnessOffersRetry("budget")).toBe(false);
  });
});
