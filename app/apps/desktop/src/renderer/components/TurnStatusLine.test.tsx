// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { parseTurnStatus } from "../lib/turn-status.ts";
import { TurnStatusLine } from "./TurnStatusLine.tsx";

afterEach(cleanup);

describe("TurnStatusLine", () => {
  it("says the page check's facts in words and lists its findings like files", () => {
    const status = parseTurnStatus({
      facts: ["page-fail", "page-hints"],
      page: ["кнопка .cta: не нажимается", "форма #order: нет подписи"],
    })!;
    render(<TurnStatusLine locale="ru" status={status} />);
    const line = screen.getByTestId("turn-status");
    expect(line.getAttribute("data-tone")).toBe("fail");
    expect(line.textContent).toContain(
      "На странице остались ошибки — посмотрите · Есть подсказки по удобству страницы",
    );
    expect(screen.getByTestId("turn-status-page").querySelectorAll("li")).toHaveLength(2);
  });
});
