// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { t } from "../../lib/i18n.ts";
import { CasualPrefsBlock } from "./CasualPrefsBlock.tsx";

afterEach(cleanup);

describe("CasualPrefsBlock: «Проверка второй моделью»", () => {
  it("shows the harness flag and writes it back", async () => {
    const get = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve({ secondOpinion: true }), 300)),
    );
    const set = vi.fn().mockResolvedValue({ secondOpinion: false });
    (window as unknown as { zeno: unknown }).zeno = { harnessFlags: { get, set } };
    render(<CasualPrefsBlock tr={(key) => t("ru", key)} />);
    expect(screen.getByText("Проверка второй моделью")).toBeTruthy();
    const toggle = screen.getByTestId("settings-second-opinion");
    // Until main answers the switch shows «on» but is disabled: wait for the answer itself
    // (enabled), not for aria-checked, or a slow get() lets the click land on a disabled switch.
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(set).toHaveBeenCalledWith({ secondOpinion: false }));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });
});
