// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("missing model: says which and how to go on", async () => {
    const getState = vi
      .fn()
      .mockResolvedValue({ baseUrl: "https://x/v1", defaultBaseUrl: "https://x/v1" });
    (window as unknown as { zeno: unknown }).zeno = { prsloy: { getState } };
    const onRetry = vi.fn();
    render(
      <ModelFailureCard
        locale="ru"
        code="model_unavailable"
        detail="404 The model `kimi` does not exist"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Эта модель сейчас недоступна")).toBeTruthy();
    expect(screen.getByText("Переключите «Быстрее / Качественнее» и повторите")).toBeTruthy();
    fireEvent.click(screen.getByTestId("model-failure-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(getState).toHaveBeenCalled());
    expect(screen.queryByTestId("model-failure-server")).toBeNull();
  });

  it("missing model with another server set: also suggests checking the address", async () => {
    const getState = vi.fn().mockResolvedValue({
      baseUrl: "https://my.proxy/v1",
      defaultBaseUrl: "https://api.prsloy.online/v1",
    });
    (window as unknown as { zeno: unknown }).zeno = { prsloy: { getState } };
    render(<ModelFailureCard locale="ru" code="model_unavailable" detail="404 Not Found" />);
    expect((await screen.findByTestId("model-failure-server")).textContent).toBe(
      "или проверьте адрес сервера",
    );
  });

  it("agent host crash: says the conversation is safe and resends the last request", () => {
    const onRetry = vi.fn();
    const raw = "Agent Host exited with code 1: file:///app/dist/agent-host/agent-host-app.mjs";
    render(<ModelFailureCard locale="ru" kind="crash" detail={raw} onRetry={onRetry} />);
    expect(screen.getByText("Агент неожиданно остановился. Разговор сохранён.")).toBeTruthy();
    expect(screen.queryByText(raw)).toBeNull();
    fireEvent.click(screen.getByText("Повторить последний запрос"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Подробности"));
    expect(screen.getByText(raw)).toBeTruthy();
  });
});
