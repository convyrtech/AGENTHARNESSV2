// @vitest-environment jsdom
import type { SearchProviderId, SearchProviderState, SearchState } from "@zeno/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { t } from "../../lib/i18n.ts";
import { SearchSection } from "./SearchSection.tsx";

const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string>) => t("ru", key, vars);

function state(over: Partial<Record<SearchProviderId, Partial<SearchProviderState>>> = {}) {
  const ids: SearchProviderId[] = [
    "model",
    "prsloy",
    "free",
    "deepseek",
    "yandex",
    "searxng",
    "brave",
    "exa",
    "firecrawl",
    "jina",
  ];
  return {
    active: "free",
    providers: ids.map((id) => ({
      id,
      configured: id === "free" || id === "prsloy" || id === "model",
      ...over[id],
    })),
  } as SearchState;
}

const search = {
  getState: vi.fn(),
  setKey: vi.fn(),
  clearKey: vi.fn(),
  setActive: vi.fn(),
  check: vi.fn(),
};
const flags = { get: vi.fn(), set: vi.fn() };

beforeEach(() => {
  search.getState.mockReset().mockResolvedValue(state());
  search.setKey.mockReset();
  search.clearKey.mockReset();
  search.setActive.mockReset();
  search.check.mockReset();
  flags.get.mockReset().mockResolvedValue({ webTools: false });
  flags.set
    .mockReset()
    .mockImplementation((p: object) => Promise.resolve({ webTools: false, ...p }));
  (window as unknown as { zeno: unknown }).zeno = { search, harnessFlags: flags };
});
afterEach(cleanup);

describe("Settings → Поиск в интернете", () => {
  it("lists free first and the model's own last; free is in use by default", async () => {
    render(<SearchSection tr={tr} locale="ru" />);
    const list = await screen.findByTestId("web-search-providers");
    const rows = [...list.querySelectorAll<HTMLElement>(".settings-row")].map(
      (row) => row.dataset.testid,
    );
    expect(rows[0]).toBe("web-search-free");
    expect(rows.at(-1)).toBe("web-search-model");
    expect(rows.indexOf("web-search-jina")).toBeLessThan(rows.indexOf("web-search-prsloy"));
    expect(
      within(screen.getByTestId("web-search-free")).getByTestId("web-search-active"),
    ).toBeTruthy();
    expect(screen.getByTestId("web-search-checked-on").textContent).toContain("2026");
  });

  it("«Искать в интернете» sets the harness flag webTools", async () => {
    render(<SearchSection tr={tr} locale="ru" />);
    const toggle = await screen.findByTestId("web-search-toggle");
    await waitFor(() => expect(toggle.getAttribute("data-on")).toBe("false"));
    fireEvent.click(toggle);
    await waitFor(() => expect(flags.set).toHaveBeenCalledWith({ webTools: true }));
  });

  it("a key goes to main once and the field is empty again; then «Выбрать» and «Проверить»", async () => {
    search.setKey.mockResolvedValue(state({ brave: { configured: true, keyMask: "BSA…a1b2" } }));
    search.setActive.mockResolvedValue({
      ...state({ brave: { configured: true, keyMask: "BSA…a1b2" } }),
      active: "brave",
    });
    search.check.mockResolvedValue({ ok: true, latencyMs: 412.4, dated: true, firstUrl: "x" });
    render(<SearchSection tr={tr} locale="ru" />);
    const brave = await screen.findByTestId("web-search-brave");
    expect(brave.textContent).toContain("просит карту");
    fireEvent.click(within(brave).getByTestId("web-search-edit"));
    const input = within(brave).getByTestId("web-search-key") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "  BSA-secret-a1b2 " } });
    fireEvent.click(within(brave).getByTestId("web-search-save"));
    await waitFor(() =>
      expect(search.setKey).toHaveBeenCalledWith("brave", "BSA-secret-a1b2", undefined),
    );
    await waitFor(() =>
      expect(screen.getByTestId("web-search-brave").textContent).toContain("Ключ: BSA…a1b2"),
    );
    expect(document.body.innerHTML).not.toContain("BSA-secret");
    fireEvent.click(within(screen.getByTestId("web-search-brave")).getByTestId("web-search-use"));
    await waitFor(() => expect(search.setActive).toHaveBeenCalledWith("brave"));
    await screen.findByText("Сейчас этот", { selector: "[data-testid=web-search-brave] *" });
    fireEvent.click(within(screen.getByTestId("web-search-brave")).getByTestId("web-search-check"));
    await waitFor(() =>
      expect(screen.getByTestId("web-search-brave").textContent).toContain(
        "Работает из вашей сети · 412 мс · даты есть",
      ),
    );
  });

  it("SearXNG asks for an address, Yandex for a key and a folder; main's refusal is shown", async () => {
    search.setKey.mockRejectedValue(new Error("Нужен адрес сервера SearXNG"));
    render(<SearchSection tr={tr} locale="ru" />);
    const searx = await screen.findByTestId("web-search-searxng");
    fireEvent.click(within(searx).getByTestId("web-search-edit"));
    expect(within(searx).queryByTestId("web-search-key")).toBeNull();
    fireEvent.change(within(searx).getByTestId("web-search-url"), {
      target: { value: "https://s.example.ru" },
    });
    fireEvent.click(within(searx).getByTestId("web-search-save"));
    await waitFor(() =>
      expect(search.setKey).toHaveBeenCalledWith("searxng", "", { url: "https://s.example.ru" }),
    );
    expect((await within(searx).findByRole("alert")).textContent).toContain(
      "Нужен адрес сервера SearXNG",
    );
    const yandex = screen.getByTestId("web-search-yandex");
    fireEvent.click(within(yandex).getByTestId("web-search-edit"));
    expect(within(yandex).getByTestId("web-search-folder")).toBeTruthy();
  });

  it("the last check is shown with its date; a failed one says why", async () => {
    search.getState.mockResolvedValue(
      state({
        exa: {
          configured: true,
          keyMask: "…9f",
          lastCheck: { at: "2026-10-25T12:00:00Z", ok: false, code: "limit" },
        },
      }),
    );
    render(<SearchSection tr={tr} locale="ru" />);
    const exa = await screen.findByTestId("web-search-exa");
    await waitFor(() => expect(exa.textContent).toContain("Проверено 25 окт."));
    expect(exa.textContent).toContain("не работает: лимит исчерпан");
    expect(screen.getByTestId("web-search-model").textContent).toContain("источники не проверены");
  });
});
