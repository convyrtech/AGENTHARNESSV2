// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppUpdateStatus } from "@zeno/contracts";
import { t, type MessageKey } from "../../lib/i18n.ts";
import { AppVersionRow } from "./AppVersionRow.tsx";

const tr = (key: MessageKey, vars?: Record<string, string>) => t("ru", key, vars);
const initial: AppUpdateStatus = {
  state: "idle",
  currentVersion: "0.1.0-alpha.2",
  canCheck: true,
};

function mockApp(status: AppUpdateStatus) {
  const app = {
    getUpdateStatus: vi.fn().mockResolvedValue(status),
    onUpdateStatus: vi.fn(() => () => undefined),
  };
  (window as unknown as { zeno: unknown }).zeno = { app };
  return app;
}

function mockClipboard(writeText: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AppVersionRow", () => {
  it("shows the current app version and copies it on click", async () => {
    const app = mockApp(initial);
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    render(<AppVersionRow tr={tr} />);

    const button = await screen.findByTestId("settings-app-version");
    expect(screen.getByText(tr("app.name"))).toBeInTheDocument();
    expect(button).toHaveTextContent("0.1.0-alpha.2");
    expect(app.getUpdateStatus).toHaveBeenCalledTimes(1);

    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith("0.1.0-alpha.2");
    expect(await screen.findByRole("status")).toHaveTextContent(
      tr("prsloy.settings.versionCopied"),
    );
  });

  it("keeps the version visible and explains a clipboard failure", async () => {
    mockApp(initial);
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    mockClipboard(writeText);
    render(<AppVersionRow tr={tr} />);

    fireEvent.click(await screen.findByTestId("settings-app-version"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      tr("prsloy.settings.versionCopyFailed"),
    );
    expect(screen.getByTestId("settings-app-version")).toHaveTextContent("0.1.0-alpha.2");
    expect(screen.getByTestId("settings-app-version")).toBeEnabled();
  });

  it("does not offer an empty version when update status is unavailable", async () => {
    (window as unknown as { zeno: unknown }).zeno = {
      app: {
        getUpdateStatus: vi.fn().mockRejectedValue(new Error("unavailable")),
        onUpdateStatus: vi.fn(() => () => undefined),
      },
    };
    render(<AppVersionRow tr={tr} />);
    await act(async () => undefined);
    expect(screen.queryByTestId("settings-app-version")).not.toBeInTheDocument();
  });
});
