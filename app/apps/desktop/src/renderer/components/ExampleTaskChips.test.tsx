// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ExampleTaskChips } from "./ExampleTaskChips.tsx";

afterEach(cleanup);

describe("ExampleTaskChips", () => {
  it("offers four tasks, one per line, and only fills the composer", () => {
    const onPick = vi.fn();
    render(<ExampleTaskChips locale="ru" onPick={onPick} />);
    const chips = screen.getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "Сайт-визитка для моего дела",
      "Таблица расходов в Excel",
      "Бот для Telegram, который отвечает на вопросы",
      "Разобраться в чужом коде",
    ]);
    fireEvent.click(chips[2]!);
    expect(onPick).toHaveBeenCalledWith("Бот для Telegram, который отвечает на вопросы");
  });
});
