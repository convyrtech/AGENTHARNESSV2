// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MemoryAutoCard, MemoryUpdatedCard } from "./MemoryAutoCards.tsx";

const snap = { user: [], project: [], forgotten: [] };
const api = { forget: vi.fn(), pin: vi.fn(), revert: vi.fn() };

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue(snap);
  (window as unknown as { zeno: unknown }).zeno = { memory: api };
});
afterEach(cleanup);

describe("«Заметил и запомнил»", () => {
  it("one entry: its words, [Забыть] and [Закрепить]", async () => {
    render(
      <MemoryAutoCard
        locale="ru"
        text=""
        details={{
          items: [{ id: "a-1", scope: "user", text: "Пишет без терминов", quote: "пиши проще" }],
        }}
      />,
    );
    expect(screen.getByTestId("memory-card").textContent).toContain(
      "Заметил и запомнил: Пишет без терминов",
    );
    expect(screen.getByText("Ваши слова: «пиши проще»")).toBeTruthy();
    fireEvent.click(screen.getByTestId("memory-auto-pin"));
    await waitFor(() => expect(api.pin).toHaveBeenCalledWith("a-1", true, undefined));
    expect((await screen.findByRole("status")).textContent).toBe("Закреплено");
  });

  it("several: «Запомнил 2» · [Показать], each with its own buttons", async () => {
    render(
      <MemoryAutoCard
        locale="ru"
        text=""
        details={{
          items: [
            { id: "a-1", scope: "user", text: "Первое" },
            { id: "a-2", scope: "project", text: "Второе" },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("memory-card").textContent).toContain("Запомнил 2");
    expect(screen.queryAllByTestId("memory-auto-entry")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("memory-auto-show"));
    expect(screen.getAllByTestId("memory-auto-entry")).toHaveLength(2);
    fireEvent.click(screen.getAllByTestId("memory-auto-forget")[1]!);
    await waitFor(() => expect(api.forget).toHaveBeenCalledWith("a-2", undefined));
  });

  it("without core's handler: a plain «Не получилось»", async () => {
    api.pin.mockRejectedValue(new Error("No handler registered for 'prsloy:memory-pin'"));
    render(<MemoryAutoCard locale="ru" text="" details={{ items: [{ id: "a-1", text: "А" }] }} />);
    fireEvent.click(screen.getByTestId("memory-auto-pin"));
    expect((await screen.findByRole("alert")).textContent).toContain("Не получилось");
  });
});

describe("«Обновил»", () => {
  it("tells and offers [Вернуть]", async () => {
    render(
      <MemoryUpdatedCard
        locale="ru"
        text=""
        details={{ opId: "op-1", id: "u-1", before: "тёмные сайты", after: "светлые сайты" }}
      />,
    );
    expect(screen.getByTestId("memory-card").textContent).toContain(
      "Обновил: было «тёмные сайты», стало «светлые сайты»",
    );
    fireEvent.click(screen.getByTestId("memory-updated-revert"));
    await waitFor(() => expect(api.revert).toHaveBeenCalledWith("op-1", undefined));
    expect((await screen.findByTestId("memory-card")).textContent).toContain("Вернул как было.");
  });

  it("a pinned one asks; «Да» keeps the new, «Нет» goes back", async () => {
    const details = { opId: "op-2", id: "u-1", before: "А", after: "Б", pinned: true };
    render(<MemoryUpdatedCard locale="ru" text="" details={details} />);
    expect(screen.getByTestId("memory-card").textContent).toContain(
      "Раньше вы просили «А». Теперь — «Б»?",
    );
    fireEvent.click(screen.getByTestId("memory-updated-yes"));
    await waitFor(() => expect(api.pin).toHaveBeenCalledWith("u-1", true, undefined));
    expect((await screen.findByTestId("memory-card")).textContent).toContain("Оставил новое.");
    expect(api.revert).not.toHaveBeenCalled();
    cleanup();
    render(<MemoryUpdatedCard locale="ru" text="" details={details} />);
    fireEvent.click(screen.getByTestId("memory-updated-no"));
    await waitFor(() => expect(api.revert).toHaveBeenCalledWith("op-2", undefined));
  });
});
