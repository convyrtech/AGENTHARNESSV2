// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TestsOutdatedCard } from "./TestsOutdatedCard.tsx";

const TEXT =
  "Старые тесты расходятся с вашей просьбой — похоже, они устарели. Обновить их под новое правило?";
const details = (quote = "expect(price(100)).toBe(90)") => ({
  files: ["tests/price.test.js"],
  quote,
  request: "скидка 15%",
  actions: [
    { label: "Обновить тесты", prompt: "Обнови тесты под новое правило: скидка 15%" },
    { label: "Оставить как есть" },
  ],
});

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("TestsOutdatedCard", () => {
  it("shows the question, the files and the assertion in monospace", () => {
    render(<TestsOutdatedCard locale="ru" text={TEXT} details={details()} onSend={vi.fn()} />);
    expect(screen.getByTestId("tests-outdated-card").textContent).toContain(TEXT);
    expect(screen.getByTestId("tests-outdated-files").textContent).toBe(
      "Тесты: tests/price.test.js",
    );
    expect(screen.getByTestId("tests-outdated-quote").tagName).toBe("PRE");
    expect(screen.queryByTestId("tests-outdated-quote-toggle")).toBeNull();
  });

  it("«Обновить тесты» sends its prompt once, then the buttons are gone", () => {
    const onSend = vi.fn();
    render(<TestsOutdatedCard locale="ru" text={TEXT} details={details()} onSend={onSend} />);
    fireEvent.click(screen.getByTestId("tests-outdated-update"));
    expect(onSend).toHaveBeenCalledWith("Обнови тесты под новое правило: скидка 15%");
    expect(screen.queryByTestId("tests-outdated-update")).toBeNull();
    expect(screen.getByTestId("tests-outdated-answered").textContent).toBe(
      "Выбрано: Обновить тесты",
    );
    // reopened later: still answered
    cleanup();
    render(<TestsOutdatedCard locale="ru" text={TEXT} details={details()} onSend={onSend} />);
    expect(screen.queryByTestId("tests-outdated-update")).toBeNull();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("«Оставить как есть» sends nothing and closes the card", () => {
    const onSend = vi.fn();
    render(<TestsOutdatedCard locale="ru" text={TEXT} details={details()} onSend={onSend} />);
    fireEvent.click(screen.getByTestId("tests-outdated-keep"));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tests-outdated-keep")).toBeNull();
  });

  it("folds a long assertion with «Показать полностью»; no quote, no block", () => {
    render(
      <TestsOutdatedCard
        locale="ru"
        text={TEXT}
        details={details("x\n".repeat(10))}
        onSend={vi.fn()}
      />,
    );
    const toggle = screen.getByTestId("tests-outdated-quote-toggle");
    expect(screen.getByTestId("tests-outdated-quote").className).toContain("is-folded");
    fireEvent.click(toggle);
    expect(screen.getByTestId("tests-outdated-quote").className).not.toContain("is-folded");
    cleanup();
    render(<TestsOutdatedCard locale="ru" text={TEXT} details={details("")} onSend={vi.fn()} />);
    expect(screen.queryByTestId("tests-outdated-quote")).toBeNull();
  });
});
