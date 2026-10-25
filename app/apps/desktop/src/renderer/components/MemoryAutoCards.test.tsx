// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MemoryAutoCard, MemoryConfirmCard, MemoryUpdatedCard } from "./MemoryAutoCards.tsx";

const snap = { user: [], project: [], forgotten: [] };
const api = { forget: vi.fn(), pin: vi.fn(), revert: vi.fn(), confirm: vi.fn(), restore: vi.fn() };

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
      "Заметил и запомнил «Пишет без терминов»",
    );
    expect(screen.getByText("Ваши слова: «пиши проще»")).toBeTruthy();
    fireEvent.click(screen.getByTestId("memory-auto-pin"));
    await waitFor(() => expect(api.pin).toHaveBeenCalledWith("a-1", true, undefined));
    expect((await screen.findByRole("status")).textContent).toBe("Закреплено");
  });

  it("[Забыть] → «Забыл.» · [Вернуть] → «Вернул.»", async () => {
    render(
      <MemoryAutoCard
        locale="ru"
        text=""
        details={{
          items: [{ id: "a-1", scope: "user", text: "Без анимаций", quote: "без анимаций" }],
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("memory-auto-forget"));
    await waitFor(() => expect(api.forget).toHaveBeenCalledWith("a-1", undefined));
    expect((await screen.findByRole("status")).textContent).toBe("Забыл.");
    fireEvent.click(await screen.findByTestId("memory-auto-restore"));
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith("a-1", undefined));
    await waitFor(() => expect(screen.queryByTestId("memory-auto-restore")).toBeNull());
    expect(screen.getByRole("status").textContent).toBe("Вернул.");
  });

  it("several: «Запомнил несколько вещей (2)» · [Показать], each with its own buttons", async () => {
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
    expect(screen.getByTestId("memory-card").textContent).toContain("Запомнил несколько вещей (2)");
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

describe("the agent asks before it forgets or replaces (research/27 §2)", () => {
  it("«Забыть «…»?» · [Да] → memory.confirm(id, true) → «Забыл.»", async () => {
    render(
      <MemoryConfirmCard
        locale="ru"
        text=""
        details={{
          confirmId: "c1",
          action: "forget",
          scope: "user",
          id: "m1",
          text: "Тёмная тема",
        }}
      />,
    );
    expect(screen.getByTestId("memory-card").textContent).toContain("Забыть «Тёмная тема»?");
    fireEvent.click(screen.getByTestId("memory-confirm-yes"));
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith("c1", true, undefined));
    expect((await screen.findByTestId("memory-card")).textContent).toContain("Забыл.");
    expect(screen.queryByTestId("memory-confirm-yes")).toBeNull();
  });

  it("«Раньше вы просили «…». Теперь — «…»?» · [Нет] → «Оставил как было.»", async () => {
    render(
      <MemoryConfirmCard
        locale="ru"
        text=""
        details={{
          confirmId: "c2",
          action: "replace",
          scope: "user",
          id: "m1",
          before: "А",
          after: "Б",
        }}
      />,
    );
    expect(screen.getByTestId("memory-card").textContent).toContain(
      "Раньше вы просили «А». Теперь — «Б»?",
    );
    fireEvent.click(screen.getByTestId("memory-confirm-no"));
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith("c2", false, undefined));
    expect((await screen.findByTestId("memory-card")).textContent).toContain("Оставил как было.");
  });

  it("main's refusal (an old proposal) stays under the card with the buttons", async () => {
    api.confirm.mockRejectedValue(new Error("Предложение устарело"));
    render(
      <MemoryConfirmCard
        locale="ru"
        text=""
        details={{ confirmId: "c3", action: "forget", scope: "user", id: "m1", text: "Х" }}
      />,
    );
    fireEvent.click(screen.getByTestId("memory-confirm-yes"));
    expect((await screen.findByRole("alert")).textContent).toContain("Предложение устарело");
    expect(screen.getByTestId("memory-confirm-yes")).toBeTruthy();
  });

  it("without memory.confirm in main (older build) it only says what was asked", () => {
    (window as unknown as { zeno: unknown }).zeno = { memory: { forget: vi.fn() } };
    render(
      <MemoryConfirmCard
        locale="ru"
        text=""
        details={{ confirmId: "c4", action: "forget", scope: "user", id: "m1", text: "Х" }}
      />,
    );
    expect(screen.queryByTestId("memory-confirm-yes")).toBeNull();
  });
});
