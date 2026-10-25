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
});
