import { describe, expect, it } from "vite-plus/test";
import { BLOCKER_TYPE, parseBlockerDetails } from "./blocker-card.ts";

describe("report_blocker card", () => {
  it("reads the three lines and up to three distinct answers", () => {
    expect(BLOCKER_TYPE).toBe("prsloy-harness.blocker");
    expect(
      parseBlockerDetails({
        what: " исправить скидку ",
        why: "тест ждёт 10%,\nа вы просили 15%",
        need: "скажите, какую оставить",
        reason: "test_conflicts_request",
        options: ["Оставь 15%", "Оставь 15%", "Верни 10%", "", 42, "Сделай как в тесте", "лишний"],
      }),
    ).toEqual({
      what: "исправить скидку",
      why: "тест ждёт 10%, а вы просили 15%",
      need: "скажите, какую оставить",
      reason: "test_conflicts_request",
      options: ["Оставь 15%", "Верни 10%", "Сделай как в тесте"],
    });
  });

  it("is nothing without all three lines", () => {
    expect(parseBlockerDetails({ what: "a", why: "b" })).toBeUndefined();
    expect(parseBlockerDetails(undefined)).toBeUndefined();
  });
});
