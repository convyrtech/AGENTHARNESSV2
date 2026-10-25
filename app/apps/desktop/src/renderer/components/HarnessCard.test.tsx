// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { HarnessCard } from "./HarnessCard.tsx";

afterEach(cleanup);

const BUDGET =
  "Задача остановлена: исчерпан лимит вызовов тулов (25). Вызовов: 31, потрачено $0.12. Сделано: изменены файлы: index.html; команд запущено: 4.";

describe("HarnessCard", () => {
  it("budget stop: a plain title and line, the harness's record folded away", () => {
    render(<HarnessCard locale="ru" kind="budget" text={BUDGET} />);
    expect(screen.getByText("Остановился: задача вышла за лимит")).toBeTruthy();
    expect(
      screen.getByText("Сделанное сохранено. Напишите «продолжай», чтобы доделать."),
    ).toBeTruthy();
    expect(screen.queryByText(BUDGET)).toBeNull();
    expect(screen.queryByTestId("harness-card-retry")).toBeNull();
    fireEvent.click(screen.getByText("Подробности"));
    expect(screen.getByText(BUDGET)).toBeTruthy();
  });

  it("confused model: offers the «Повторить» its text asks for", () => {
    const onRetry = vi.fn();
    render(<HarnessCard locale="ru" kind="toolLeak" text="Модель сбилась" onRetry={onRetry} />);
    expect(
      screen.getByText("Нажмите «Повторить» или переключитесь на «Качественнее»."),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("harness-card-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("review: its own line, remarks open as a list", () => {
    render(
      <HarnessCard
        locale="ru"
        kind="review"
        text="Вторая модель нашла 2 замечания — исправляю"
        details={{
          verdict: "FAIL",
          items: [
            { file: "site/index.html", line: 12, problem: "Ссылка ведёт в никуда", evidence: "a" },
            { file: "site/style.css", problem: "Текст сливается с фоном", evidence: "b" },
          ],
        }}
      />,
    );
    expect(screen.getByText("Вторая модель нашла 2 замечания — исправляю")).toBeTruthy();
    expect(screen.queryByText("Расширение")).toBeNull();
    fireEvent.click(screen.getByText("Замечания (2)"));
    const list = screen.getByTestId("harness-card-remarks");
    expect(list.textContent).toContain("site/index.html:12 — Ссылка ведёт в никуда");
    expect(list.textContent).toContain("Текст сливается с фоном");
  });

  it("review passed: one line, nothing to open", () => {
    render(<HarnessCard locale="ru" kind="review" text="Проверила вторая модель: замечаний нет" />);
    expect(screen.getByText("Проверила вторая модель: замечаний нет")).toBeTruthy();
    expect(screen.queryByTestId("harness-card-toggle")).toBeNull();
  });
});
