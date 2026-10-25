// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { t } from "../../lib/i18n.ts";
import { CasualPrefsBlock } from "./CasualPrefsBlock.tsx";

afterEach(cleanup);

describe("CasualPrefsBlock: «Проверка второй моделью»", () => {
  it("shows the harness flag and writes it back", async () => {
    const get = vi.fn().mockResolvedValue({ secondOpinion: true });
    const set = vi.fn().mockResolvedValue({ secondOpinion: false });
    (window as unknown as { zeno: unknown }).zeno = { harnessFlags: { get, set } };
    render(<CasualPrefsBlock tr={(key) => t("ru", key)} />);
    expect(screen.getByText("Проверка второй моделью")).toBeTruthy();
    const toggle = screen.getByTestId("settings-second-opinion");
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(toggle);
    await waitFor(() => expect(set).toHaveBeenCalledWith({ secondOpinion: false }));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });
});
