// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ExtensionUiInputDialog } from "./ExtensionUiInputDialog.tsx";

afterEach(cleanup);

describe("ExtensionUiInputDialog", () => {
  it("a key (request_secret): hidden as typed, empty, says where it goes, «Сохранить»", () => {
    const onConfirm = vi.fn();
    render(
      <ExtensionUiInputDialog
        open
        secret
        locale="ru"
        title="Нужен ключ: Токен бота — его выдаёт @BotFather в Telegram"
        initialValue=""
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const field = screen.getByTestId("extension-ui-input-field") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.value).toBe("");
    expect(screen.getByTestId("extension-ui-secret-note").textContent).toContain(".env");
    fireEvent.change(field, { target: { value: "7712:AAE-token" } });
    fireEvent.click(screen.getByTestId("extension-ui-input-confirm"));
    expect(screen.getByTestId("extension-ui-input-confirm").textContent).toBe("Сохранить");
    expect(onConfirm).toHaveBeenCalledWith("7712:AAE-token");
  });

  it("ordinary text stays a plain field with its prefilled value", () => {
    render(
      <ExtensionUiInputDialog
        open
        title="Имя"
        initialValue="Анна"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const field = screen.getByTestId("extension-ui-input-field") as HTMLInputElement;
    expect(field.type).not.toBe("password");
    expect(field.value).toBe("Анна");
    expect(screen.queryByTestId("extension-ui-secret-note")).toBeNull();
  });
});
