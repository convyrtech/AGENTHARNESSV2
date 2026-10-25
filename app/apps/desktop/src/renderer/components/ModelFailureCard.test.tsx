// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ModelFailureCard } from "./ModelFailureCard.tsx";

afterEach(cleanup);

describe("ModelFailureCard", () => {
  it("says it in Russian, retries, and keeps the raw error folded", () => {
    const onRetry = vi.fn();
    const raw = "Error reading response: malformed server-sent event JSON";
    render(<ModelFailureCard locale="ru" detail={raw} onRetry={onRetry} />);
    expect(screen.getByText("Связь с моделью оборвалась")).toBeTruthy();
    expect(screen.queryByText(raw)).toBeNull();
    fireEvent.click(screen.getByTestId("model-failure-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Подробности"));
    expect(screen.getByText(raw)).toBeTruthy();
  });

  it("disables retry while a turn runs and hides it without a prompt", () => {
    const { rerender } = render(
      <ModelFailureCard locale="ru" detail="x" onRetry={() => undefined} disabled />,
    );
    expect((screen.getByTestId("model-failure-retry") as HTMLButtonElement).disabled).toBe(true);
    rerender(<ModelFailureCard locale="ru" detail="x" />);
    expect(screen.queryByTestId("model-failure-retry")).toBeNull();
  });

  it("shows the gateway's stream drop without repeating it under «Подробности»", () => {
    render(<ModelFailureCard locale="ru" detail="Связь с моделью оборвалась" onRetry={() => {}} />);
    expect(screen.getByText("Связь с моделью оборвалась")).toBeTruthy();
    expect(screen.getByTestId("model-failure-retry")).toBeTruthy();
    expect(screen.queryByText("Подробности")).toBeNull();
  });
});
