// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { HarnessCard } from "./HarnessCard.tsx";

afterEach(cleanup);

const BUDGET =
  "Я остановился: на одну задачу у меня 25 шагов, и они закончились. Что успел: изменил index.html. Если нужно доделать, напишите «продолжай».";

describe("HarnessCard", () => {
  it("budget stop: the harness's own plain message, nothing raw", () => {
    render(<HarnessCard locale="ru" kind="budget" text={BUDGET} details={{ toolCalls: 25 }} />);
    expect(screen.getByText(BUDGET)).toBeTruthy();
    expect(screen.queryByText("Подробности")).toBeNull();
    expect(screen.queryByTestId("harness-card-retry")).toBeNull();
  });

  it("a card without text falls back to the short title and line", () => {
    render(<HarnessCard locale="ru" kind="budget" text="" />);
    expect(screen.getByText("Остановился: задача вышла за лимит")).toBeTruthy();
    expect(
      screen.getByText("Сделанное сохранено. Напишите «продолжай», чтобы доделать."),
    ).toBeTruthy();
  });

  it("failing check: the check's output folded under «Подробности»", () => {
    render(
      <HarnessCard
        locale="ru"
        kind="stopGate"
        text="Проверка проекта всё ещё не проходит. Я дважды пытался исправить и остановился."
        details={{ command: "npm test", code: 1, output: "1 failing" }}
      />,
    );
    expect(screen.queryByText(/1 failing/)).toBeNull();
    fireEvent.click(screen.getByText("Подробности"));
    expect(screen.getByText(/\$ npm test\s+1 failing/)).toBeTruthy();
  });

  it("confused model: offers the «Повторить» its text asks for", () => {
    const onRetry = vi.fn();
    const text = "Модель сбилась, нажмите «Повторить» или переключитесь на «Качественнее».";
    render(<HarnessCard locale="ru" kind="toolLeak" text={text} onRetry={onRetry} />);
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText("Подробности")).toBeNull();
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
