// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PrsloyState } from "@zeno/contracts";
import { t, type MessageKey } from "../../lib/i18n.ts";
import { AccountSection } from "./AccountSection.tsx";

const tr = (key: MessageKey, vars?: Record<string, string>) => t("ru", key, vars);
const state: PrsloyState = {
  hasKey: true,
  keyMemoryOnly: false,
  maskedKey: "sk-…abcd",
  baseUrl: "https://api.prsloy.online/v1",
  defaultBaseUrl: "https://api.prsloy.online/v1",
  needsWorkspace: false,
  harnessLoaded: true,
  firstRunBypass: false,
  gitSetup: { status: "absent" },
};

function mockPrsloy() {
  const api = {
    getState: vi.fn().mockResolvedValue(state),
    setKey: vi.fn(),
    setBaseUrl: vi.fn(),
  };
  (window as unknown as { zeno: unknown }).zeno = { prsloy: api };
  return api;
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("AccountSection", () => {
  it("shows the money left on the key, in rubles, with its age", async () => {
    const api = mockPrsloy();
    api.getState.mockResolvedValue({
      ...state,
      balance: {
        remainingRub: 3776.4,
        usedRub: 223.6,
        grantedRub: 4000,
        fetchedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    });
    render(<AccountSection tr={tr} />);
    const row = await screen.findByTestId("settings-account-balance");
    // Intl puts a thin no-break space between the digits; compare on plain text.
    const plain = (row.textContent ?? "").replace(/\u202f|\u00a0/g, " ");
    expect(plain).toContain("3 776");
    expect(document.body.textContent).toContain("обновлено 5 мин назад");
  });

  it("says the balance is low instead of only showing a number", async () => {
    const api = mockPrsloy();
    api.getState.mockResolvedValue({
      ...state,
      balance: {
        remainingRub: 30,
        usedRub: 3970,
        grantedRub: 4000,
        fetchedAt: new Date().toISOString(),
      },
    });
    render(<AccountSection tr={tr} />);
    await screen.findByTestId("settings-account-balance");
    expect(document.body.textContent).toContain("Мало денег");
  });

  it("shows nothing as a balance when the gateway never answered", async () => {
    mockPrsloy();
    render(<AccountSection tr={tr} />);
    expect((await screen.findByTestId("settings-account-balance")).textContent).toBe("—");
  });

  it("shows the masked key without a made-up dollar-rate control", async () => {
    mockPrsloy();
    render(<AccountSection tr={tr} />);
    expect((await screen.findByTestId("settings-account-masked")).textContent).toBe("sk-…abcd");
    expect(screen.queryByTestId("settings-rub-per-usd")).toBeNull();
  });

  it("changes the key and shows a refusal in Russian", async () => {
    const api = mockPrsloy();
    api.setKey
      .mockResolvedValueOnce({ ok: false, code: "no_balance", status: 402 })
      .mockResolvedValueOnce({
        ok: true,
        modelIds: [],
        state: { ...state, maskedKey: "sk-…new1" },
      });
    render(<AccountSection tr={tr} />);
    fireEvent.click(await screen.findByTestId("settings-account-key-change"));
    const input = screen.getByTestId("settings-account-key-input");
    fireEvent.change(input, { target: { value: " sk-new\n" } });
    fireEvent.submit(input.closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toBe(tr("prsloy.error.no_balance"));
    expect(api.setKey).toHaveBeenLastCalledWith("sk-new");
    fireEvent.submit(input.closest("form")!);
    expect((await screen.findByTestId("settings-account-masked")).textContent).toBe("sk-…new1");
  });

  it("saves a new server address through core", async () => {
    const api = mockPrsloy();
    api.setBaseUrl.mockResolvedValue({
      ok: true,
      modelIds: [],
      state: { ...state, baseUrl: "https://gw.example/v1" },
    });
    render(<AccountSection tr={tr} />);
    const url = await screen.findByTestId("settings-account-url");
    fireEvent.change(url, { target: { value: "https://gw.example" } });
    fireEvent.click(screen.getByRole("button", { name: tr("prsloy.settings.save") }));
    expect(await screen.findByText(tr("prsloy.settings.saved"))).toBeTruthy();
    expect(api.setBaseUrl).toHaveBeenCalledWith("https://gw.example");
    expect(screen.getByRole("button", { name: tr("prsloy.settings.baseUrlReset") })).toBeTruthy();
  });
});
