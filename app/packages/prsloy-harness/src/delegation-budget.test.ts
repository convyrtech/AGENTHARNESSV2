import { describe, expect, it } from "vite-plus/test";
import { DelegationBudget } from "./delegation-budget.ts";

const rates = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1 };
describe("delegated request admission", () => {
  it("preserves reviewer allowance before any request", () => {
    const budget = new DelegationBudget(1, 3, 0.9);
    expect(() => budget.reserve({}, rates, 8192)).toThrow("budget exhausted");
    expect(budget.calls).toBe(0);
    expect(budget.exceeded).toBe(true);
  });
  it("settles known usage once and frees unused reservation", () => {
    const budget = new DelegationBudget(10, 3, 1);
    budget.reserve({}, rates, 8192);
    const reserved = budget.pending;
    budget.settle({ input: 10, output: 5 }, rates, false);
    expect(budget.spent).toBeCloseTo(0.00006);
    expect(budget.pending).toBe(0);
    expect(budget.spent).toBeLessThan(reserved);
    budget.settle({ input: 10, output: 5 }, rates, false);
    expect(budget.spent).toBeCloseTo(0.00006);
  });
  it.each([undefined, { input: 0, output: 0 }])(
    "retains unknown charges and blocks another call",
    (usage) => {
      const budget = new DelegationBudget(10, 3, 1);
      budget.reserve({}, rates, 8192);
      const reserved = budget.pending;
      budget.settle(usage, rates, false);
      expect(budget.unknown).toBe(true);
      expect(budget.pending).toBe(reserved);
      expect(() => budget.reserve({}, rates, 8192, true)).toThrow("unresolved");
    },
  );
  it("does not release a failed request even when partial usage exists", () => {
    const budget = new DelegationBudget(10, 3, 1);
    budget.reserve({}, rates, 8192);
    budget.settle({ input: 10, output: 5 }, rates, true);
    expect(budget.unknown).toBe(true);
    expect(budget.chargedEstimate).toBeGreaterThan(0);
  });
  it("rejects unknown prices and oversized context before admission", () => {
    const budget = new DelegationBudget(10, 3, 1);
    expect(() => budget.reserve({}, { ...rates, output: NaN }, 8192)).toThrow();
    expect(() => budget.reserve("x".repeat(200_001), rates, 8192)).toThrow("context limit");
    expect(budget.calls).toBe(0);
  });
});
