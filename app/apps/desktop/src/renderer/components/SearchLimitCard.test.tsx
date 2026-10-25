// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { takeKeyFormRequest } from "../lib/search-settings.ts";
import { useShellStore } from "../store/shell-store.ts";
import { SearchLimitCard } from "./SearchLimitCard.tsx";

afterEach(cleanup);

describe("«Лимит поиска исчерпан» card", () => {
  it("names the search and why; «Добавить ключ» opens its form in the settings", () => {
    render(
      <SearchLimitCard locale="ru" text="429" details={{ provider: "brave", code: "limit" }} />,
    );
    expect(screen.getByTestId("search-limit-card").textContent).toContain("Brave: лимит исчерпан");
    fireEvent.click(screen.getByTestId("search-limit-key"));
    expect(useShellStore.getState().view).toBe("settings");
    expect(useShellStore.getState().settingsSection).toBe("webSearch");
    expect(takeKeyFormRequest()).toBe("brave");
  });

  it("the PRSLOY search has no key to add, only «Выбрать другой поиск»", () => {
    render(
      <SearchLimitCard
        locale="ru"
        text="нет ключа"
        details={{ provider: "prsloy", code: "no_key" }}
      />,
    );
    expect(screen.queryByTestId("search-limit-key")).toBeNull();
    fireEvent.click(screen.getByTestId("search-limit-choose"));
    expect(takeKeyFormRequest()).toBeUndefined();
  });
});
