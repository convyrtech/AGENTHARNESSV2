// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PrsloyBalance } from "@zeno/contracts";
import { BalanceChip } from "./BalanceChip.tsx";

const balance = (over: Partial<PrsloyBalance> = {}): PrsloyBalance => ({
  remainingRub: 3776.4,
  usedRub: 223.6,
  grantedRub: 4000,
  fetchedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  ...over,
});

/** The chip asks main for the balance, like every other surface of the app. */
function mockMain(next: PrsloyBalance | undefined) {
  (window as unknown as { zeno: unknown }).zeno = {
    prsloy: { getState: vi.fn().mockResolvedValue({ balance: next }) },
  };
}

const plain = (value: string | null) => (value ?? "").replace(/\u202f|\u00a0/g, " ");

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("prsloy.casual.prefs.v1", JSON.stringify({ developerMode: true }));
});
afterEach(cleanup);

describe("BalanceChip", () => {
  it("shows what is left on the key, in rubles, and its age in the hover line", async () => {
    mockMain(balance());
    render(<BalanceChip locale="ru" />);
    const chip = await screen.findByTestId("balance-chip");
    expect(plain(chip.textContent)).toContain("остаток 3 776");
    expect(chip.getAttribute("title")).toContain("обновлено 12 мин назад");
    expect(chip.getAttribute("data-low")).toBeNull();
  });

  it("marks itself low when the money no longer covers the warning line", async () => {
    mockMain(balance({ remainingRub: 150 }));
    render(<BalanceChip locale="ru" />);
    const chip = await screen.findByTestId("balance-chip");
    expect(chip.getAttribute("data-low")).toBe("1");
    expect(chip.className).toContain("prsloy-balance-low");
  });

  it("is invisible in casual mode while there is enough money", async () => {
    localStorage.setItem("prsloy.casual.prefs.v1", JSON.stringify({ developerMode: false }));
    mockMain(balance());
    const { container } = render(<BalanceChip locale="ru" />);
    await vi.waitFor(() => expect(container.textContent).toBe(""));
    expect(screen.queryByTestId("balance-chip")).toBeNull();
  });

  it("appears in casual mode when the balance runs low: a warning before the task", async () => {
    localStorage.setItem("prsloy.casual.prefs.v1", JSON.stringify({ developerMode: false }));
    mockMain(balance({ remainingRub: 30 }));
    render(<BalanceChip locale="ru" />);
    expect(await screen.findByTestId("balance-chip")).toBeTruthy();
  });

  it("is nothing at all when the gateway has never answered about money", async () => {
    mockMain(undefined);
    const { container } = render(<BalanceChip locale="ru" />);
    await Promise.resolve();
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("balance-chip")).toBeNull();
  });
});
