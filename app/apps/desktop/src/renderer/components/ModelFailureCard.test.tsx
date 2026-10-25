// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useShellStore } from "../store/shell-store.ts";
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

  it("no balance: says so and opens the PRSLOY cabinet", () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { zeno: unknown }).zeno = { workspace: { openExternal } };
    render(<ModelFailureCard locale="ru" code="no_balance" detail="402 Insufficient balance" />);
    expect(screen.getByText("На балансе закончились деньги")).toBeTruthy();
    fireEvent.click(screen.getByTestId("model-failure-topUp"));
    expect(openExternal).toHaveBeenCalledWith("https://prsloy.online");
  });

  it("bad key: «Изменить ключ» opens Settings → Аккаунт", () => {
    render(<ModelFailureCard locale="ru" code="auth" detail="401 Invalid API key" />);
    expect(screen.getByText("Ключ не подходит")).toBeTruthy();
    fireEvent.click(screen.getByTestId("model-failure-changeKey"));
    expect(useShellStore.getState().view).toBe("settings");
    expect(useShellStore.getState().settingsSection).toBe("account");
  });

  it("missing model: says which and how to go on", () => {
    const onRetry = vi.fn();
    render(
      <ModelFailureCard
        locale="ru"
        code="unknown"
        detail="404 The model `kimi` does not exist"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Эта модель сейчас недоступна")).toBeTruthy();
    expect(screen.getByText("Переключите «Быстрее / Качественнее» и повторите")).toBeTruthy();
    fireEvent.click(screen.getByTestId("model-failure-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
