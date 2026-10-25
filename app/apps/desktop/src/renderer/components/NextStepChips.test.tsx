// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { useShellStore } from "../store/shell-store.ts";
import { NextStepChips } from "./NextStepChips.tsx";

afterEach(() => {
  cleanup();
  act(() => useShellStore.getState().setPrompt(""));
});

describe("NextStepChips", () => {
  it("puts a step in the composer without sending, and hides while the owner types", () => {
    render(<NextStepChips locale="ru" steps={["Добавь форму заявки", "Сделай дизайн ярче"]} />);
    expect(screen.getByTestId("next-steps").textContent).toContain("Что дальше:");
    fireEvent.click(screen.getByText("Добавь форму заявки"));
    expect(useShellStore.getState().prompt).toBe("Добавь форму заявки");
    expect(screen.queryByTestId("next-steps")).toBeNull();
    act(() => useShellStore.getState().setPrompt(""));
    expect(screen.getAllByTestId("next-step")).toHaveLength(2);
  });

  it("renders nothing without steps", () => {
    render(<NextStepChips locale="ru" steps={[]} />);
    expect(screen.queryByTestId("next-steps")).toBeNull();
  });
});
