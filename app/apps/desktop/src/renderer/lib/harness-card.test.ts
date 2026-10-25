import { describe, expect, it } from "vite-plus/test";
import {
  harnessBodyKey,
  harnessCardKind,
  harnessOffersRetry,
  harnessTitleKey,
  harnessUsesOwnText,
  isHarnessData,
  reviewRemarks,
  reviewVerdict,
  stopGateOutput,
} from "./harness-card.ts";

describe("harness cards", () => {
  it("knows the harness's card types and nothing else", () => {
    expect(harnessCardKind("prsloy-harness.budget")).toBe("budget");
    expect(harnessCardKind("prsloy-harness.stop-gate")).toBe("stopGate");
    expect(harnessCardKind("prsloy-harness.tool-leak")).toBe("toolLeak");
    expect(harnessCardKind("prsloy-harness.second-opinion")).toBe("review");
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

  it("the review keeps its own plain line and reads its remarks from details", () => {
    expect(harnessUsesOwnText("review")).toBe(true);
    expect(harnessUsesOwnText("budget")).toBe(true);
    expect(harnessUsesOwnText("note")).toBe(false);
    expect(harnessBodyKey("review")).toBeUndefined();
    expect(
      reviewRemarks({
        verdict: "FAIL",
        items: [
          { file: "site/index.html", line: 12, problem: "Ссылка ведёт в никуда", evidence: "x" },
          { file: "", problem: "Нет подписи у формы", evidence: "y" },
          { file: "a.js", problem: "  " },
        ],
      }),
    ).toEqual([
      { where: "site/index.html:12", problem: "Ссылка ведёт в никуда" },
      { problem: "Нет подписи у формы" },
    ]);
    expect(reviewRemarks(undefined)).toEqual([]);
    expect(reviewRemarks({ items: "nope" })).toEqual([]);
  });

  it("the failing check's output comes from the card's details", () => {
    expect(stopGateOutput({ command: "npm test", code: 1, output: " 1 failing \n" })).toBe(
      "$ npm test\n1 failing",
    );
    expect(stopGateOutput({ output: "boom" })).toBe("boom");
    expect(stopGateOutput({ command: "npm test", output: "" })).toBeUndefined();
    expect(stopGateOutput(undefined)).toBeUndefined();
  });

  it("reads the review's verdict for the card's data-verdict", () => {
    expect(reviewVerdict({ verdict: "PASS", items: [] })).toBe("pass");
    expect(reviewVerdict({ verdict: "FAIL", items: [{ problem: "x" }] })).toBe("fail");
    expect(reviewVerdict({ items: [{ problem: "x" }] })).toBe("fail");
    expect(reviewVerdict({ items: [] })).toBe("pass");
    expect(reviewVerdict(undefined)).toBeUndefined();
  });
});
