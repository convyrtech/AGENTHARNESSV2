// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BlockerCard } from "./BlockerCard.tsx";

afterEach(cleanup);

const details = {
  what: "исправить скидку",
  why: "старый тест ждёт 10%, а вы просили 15%",
  need: "скажите, какую скидку оставить",
  options: ["Оставь 15%, тест поправь", "Верни 10%"],
};

describe("«Не получилось» (report_blocker)", () => {
  it("three plain lines and ready answers that send at once", () => {
    const onSend = vi.fn();
    render(<BlockerCard locale="ru" text="" details={details} onSend={onSend} />);
    const card = screen.getByTestId("blocker-card");
    expect(card.textContent).toContain("Не получилось: исправить скидку");
    expect(screen.getByTestId("blocker-why").textContent).toBe(
      "Почему: старый тест ждёт 10%, а вы просили 15%",
    );
    expect(screen.getByTestId("blocker-need").textContent).toBe(
      "Что нужно от вас: скажите, какую скидку оставить",
    );
    expect(screen.getByRole("group", { name: "Не получилось: исправить скидку" })).toBeTruthy();
    fireEvent.click(screen.getByText("Верни 10%"));
    expect(onSend).toHaveBeenCalledWith("Верни 10%");
    expect(screen.getByTestId("blocker-reply").textContent).toBe("Ответить своими словами");
  });

  it("from history without details: its own text, no buttons", () => {
    render(<BlockerCard locale="ru" text="Не получилось: скидка" />);
    expect(screen.getByTestId("blocker-card").textContent).toBe("Не получилось: скидка");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
