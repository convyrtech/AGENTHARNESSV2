// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useShellStore } from "../store/shell-store.ts";
import { MemoryCard } from "./MemoryCard.tsx";

const empty = { user: [], project: [], forgotten: [] };
const api = { list: vi.fn(), forget: vi.fn(), restore: vi.fn(), forgetAll: vi.fn() };

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue(empty);
  (window as unknown as { zeno: unknown }).zeno = { memory: api };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  act(() => useShellStore.getState().setPrompt(""));
});

describe("MemoryCard", () => {
  it("«Забыть» forgets by the card's id, then offers «Вернуть» for 10 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <MemoryCard
        locale="ru"
        kind="saved"
        text="Запомнил: Отвечать коротко"
        details={{ id: "u-1", scope: "user" }}
      />,
    );
    expect(screen.getByTestId("memory-card").textContent).toContain("Запомнил: Отвечать коротко");
    fireEvent.click(screen.getByTestId("memory-card-forget"));
    await waitFor(() => expect(api.forget).toHaveBeenCalledWith("u-1", undefined));
    expect((await screen.findByTestId("memory-card")).textContent).toContain("Забыл.");
    fireEvent.click(screen.getByTestId("memory-card-restore"));
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith("u-1", undefined));
    expect((await screen.findByTestId("memory-card")).textContent).toContain("Вернул.");
  });

  it("«Вернуть» goes away after ten seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <MemoryCard
        locale="ru"
        kind="forgot"
        text="Забыл."
        details={{ id: "u-1" }}
        timestamp={new Date().toISOString()}
      />,
    );
    expect(screen.getByTestId("memory-card-restore")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(10_500);
    });
    expect(screen.queryByTestId("memory-card-restore")).toBeNull();
    cleanup();
    render(
      <MemoryCard
        locale="ru"
        kind="forgot"
        text="Забыл."
        details={{ id: "u-1" }}
        timestamp="2020-01-01T00:00:00Z"
      />,
    );
    expect(screen.queryByTestId("memory-card-restore")).toBeNull();
  });

  it("a card from history finds its entry by text", async () => {
    api.list.mockResolvedValue({ ...empty, project: [{ id: "p-7", text: "Без npm" }] });
    render(<MemoryCard locale="ru" kind="saved" text="Запомнил для этого проекта: Без npm" />);
    // A project entry has no «Изменить» (§6.7).
    expect(screen.queryByTestId("memory-card-edit")).toBeNull();
    fireEvent.click(screen.getByTestId("memory-card-forget"));
    await waitFor(() => expect(api.forget).toHaveBeenCalledWith("p-7", undefined));
  });

  it("«Изменить» asks in the composer; «Открыть память» opens the panel", () => {
    render(
      <MemoryCard
        locale="ru"
        kind="saved"
        text="Запомнил: Отвечать коротко"
        details={{ id: "u-1" }}
      />,
    );
    fireEvent.click(screen.getByTestId("memory-card-edit"));
    expect(useShellStore.getState().prompt).toBe("Поправь запись в памяти «Отвечать коротко»: ");
    cleanup();
    render(<MemoryCard locale="ru" kind="full" text="Память заполнена. Что забыть?" />);
    fireEvent.click(screen.getByTestId("memory-card-open"));
    expect(useShellStore.getState().view).toBe("settings");
    expect(useShellStore.getState().settingsSection).toBe("memory");
  });

  it("a refusal has no buttons; without main's memory only «Изменить» stays", () => {
    render(
      <MemoryCard
        locale="ru"
        kind="refused"
        text="Это похоже на пароль или ключ. Такое не запоминаю."
      />,
    );
    expect(screen.getByTestId("memory-card").querySelectorAll("button")).toHaveLength(0);
    cleanup();
    (window as unknown as { zeno: unknown }).zeno = {};
    render(
      <MemoryCard
        locale="ru"
        kind="saved"
        text="Запомнил: Отвечать коротко"
        details={{ id: "u-1" }}
      />,
    );
    expect(screen.queryByTestId("memory-card-forget")).toBeNull();
    expect(screen.getByTestId("memory-card-edit")).toBeTruthy();
  });
});
