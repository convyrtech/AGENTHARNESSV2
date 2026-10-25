import { describe, expect, it } from "vite-plus/test";
import { t } from "./i18n.ts";
import {
  activeProvider,
  checkLine,
  lastCheckLine,
  orderedProviders,
  parseLimitDetails,
  requestKeyForm,
  searchErrorKey,
  searchForm,
  SEARCH_ORDER,
  takeKeyFormRequest,
} from "./search-settings.ts";

const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string>) => t("ru", key, vars);

describe("search settings", () => {
  it("orders free first and the model last, drops unknown ones", () => {
    const providers = ["model", "jina", "free", "prsloy"].map((id) => ({
      id: id as (typeof SEARCH_ORDER)[number],
      configured: true,
    }));
    expect(orderedProviders({ active: null, providers }).map((p) => p.id)).toEqual([
      "free",
      "jina",
      "prsloy",
      "model",
    ]);
  });

  it("treats an old `null` as free", () => {
    expect(activeProvider({ active: null, providers: [] })).toBe("free");
    expect(activeProvider({ active: "exa", providers: [] })).toBe("exa");
  });

  it("knows what each form asks for", () => {
    expect(searchForm("yandex")).toBe("keyFolder");
    expect(searchForm("searxng")).toBe("url");
    expect(searchForm("brave")).toBe("key");
    for (const id of ["free", "prsloy", "model"] as const) expect(searchForm(id)).toBe("none");
  });

  it("says a check in plain words", () => {
    expect(checkLine(tr, { ok: true, latencyMs: 99.6, dated: false, firstUrl: "u" })).toBe(
      "Работает из вашей сети · 100 мс · дат нет",
    );
    expect(
      checkLine(tr, { ok: true, latencyMs: 1, dated: true, firstUrl: "u", note: "заметка" }),
    ).toContain("· заметка");
    expect(checkLine(tr, { ok: false, error: "401", code: "auth" })).toBe(
      "Не работает: ключ не подошёл",
    );
    expect(searchErrorKey(undefined)).toBe("features.web.error.network");
  });

  it("dates the last check and ignores a broken date", () => {
    expect(lastCheckLine(tr, "ru-RU", { at: "2026-10-25T12:00:00Z", ok: true })).toBe(
      "Проверено 25 окт. · работает",
    );
    expect(lastCheckLine(tr, "ru-RU", { at: "nope", ok: true })).toBeUndefined();
    expect(lastCheckLine(tr, "ru-RU", undefined)).toBeUndefined();
  });
});

describe("search limit card", () => {
  it("parses the harness's details and refuses anything else", () => {
    expect(parseLimitDetails({ provider: "brave", code: "limit" })).toEqual({
      provider: "brave",
      code: "limit",
    });
    expect(parseLimitDetails({ provider: "tavily", code: "limit" })).toBeUndefined();
    expect(parseLimitDetails({ provider: "brave", code: "network" })).toBeUndefined();
    expect(parseLimitDetails(null)).toBeUndefined();
  });

  it("hands the key-form request to the settings page once", () => {
    requestKeyForm("exa");
    expect(takeKeyFormRequest()).toBe("exa");
    expect(takeKeyFormRequest()).toBeUndefined();
  });
});
